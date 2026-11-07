// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import * as s from '../db/schema/npi'
import { users } from '../db/schema/users'
import { NpiError, dateValue, stages, textValue, today } from './domain'
import {
  event,
  getActor,
  loadProject,
  uuidValue,
  versionCheck,
} from './service'
import {
  lifecycleDefinitions,
  lifecycleKinds,
  parseLifecycleData,
  resultLabels,
  submissionErrors,
} from './lifecycle'
import type { LifecycleKind, LifecycleResult } from './lifecycle'
import type { Actor } from './service'
import type { TransactionClient } from '../db'
type Project = typeof s.npiProjects.$inferSelect
type Run = TransactionClient | typeof db
export function requireLifecycleOwner(actor: Actor, p: Project) {
  if (
    actor.id !== p.technicalOwnerId ||
    !['technical', 'admin'].includes(actor.role)
  )
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '流程记录与阶段结论由本项目负责人填写，主管和其他成员可查看',
      403,
    )
}
export async function lifecycleRows(run: Run, projectId: string) {
  return run
    .select()
    .from(s.npiLifecycleRecords)
    .where(eq(s.npiLifecycleRecords.programId, projectId))
    .orderBy(
      desc(s.npiLifecycleRecords.createdAt),
      desc(s.npiLifecycleRecords.id),
    )
}
export async function lifecycleGate(run: Run, p: Project) {
  const next = stages[stages.indexOf(p.currentNpiStage) + 1] || null
  if (!next) return { next, blockers: [] as string[] }
  const records = await lifecycleRows(run, p.programId)
  const required = lifecycleKinds.slice(
    0,
    next === 'completed' ? 6 : stages.indexOf(next),
  )
  const blockers: string[] = []
  for (const kind of required) {
    const active = records.filter(
      (r) => r.kind === kind && r.status !== 'cancelled',
    )
    const latest = active[0]
    if (
      !latest ||
      latest.status !== 'submitted' ||
      !['pass', ...(kind === 'trial' ? ['not_applicable'] : [])].includes(
        latest.result,
      )
    )
      blockers.push(`${lifecycleDefinitions[kind].label}尚无最新有效通过结论`)
    if (active.some((r) => r.status === 'draft'))
      blockers.push(
        `${lifecycleDefinitions[kind].label}有未提交记录，请完成或说明原因后取消`,
      )
  }
  if (['trial', 'completed'].includes(next)) {
    const issues = await run
      .select()
      .from(s.npiIssues)
      .where(eq(s.npiIssues.programId, p.programId))
    const open = issues.filter(
      (i) =>
        !['Closed', 'Cancelled'].includes(i.state) &&
        (next === 'completed' || ['High', 'Critical'].includes(i.severity)),
    )
    if (open.length)
      blockers.push(
        `${open.length} 项${next === 'completed' ? '' : '重要或重大'}问题尚未验证关闭`,
      )
  }
  if (next === 'completed') {
    const tasks = await run
      .select()
      .from(s.npiTrackingItems)
      .where(eq(s.npiTrackingItems.programId, p.programId))
    const unfinished = tasks.filter(
      (i) =>
        (i.affectsKit || i.sourceType === 'WHOLE_MACHINE') &&
        !i.actualCompleteDate,
    )
    if (unfinished.length)
      blockers.push(`${unfinished.length} 项零部件、工装或整机尚未确认完成`)
  }
  return { next, blockers }
}
export async function requireLifecycleGate(run: Run, p: Project) {
  const gate = await lifecycleGate(run, p)
  if (gate.blockers.length)
    throw new NpiError('LIFECYCLE_INCOMPLETE', gate.blockers.join('；'), 409)
}
export async function getLifecycle(userId: string, projectId: string) {
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx),
        p = await loadProject(tx, projectId, actor)
      const records = await tx
        .select({ record: s.npiLifecycleRecords, author: users.name })
        .from(s.npiLifecycleRecords)
        .innerJoin(users, eq(users.id, s.npiLifecycleRecords.updatedBy))
        .where(eq(s.npiLifecycleRecords.programId, projectId))
        .orderBy(
          desc(s.npiLifecycleRecords.createdAt),
          desc(s.npiLifecycleRecords.id),
        )
      const files = await tx
        .select({
          id: s.npiAttachments.id,
          recordId: s.npiAttachments.lifecycleRecordId,
          category: s.npiAttachments.category,
          conclusion: s.npiAttachments.conclusion,
          archivedAt: s.npiAttachments.archivedAt,
        })
        .from(s.npiAttachments)
        .where(
          and(
            eq(s.npiAttachments.programId, projectId),
            isNull(s.npiAttachments.archivedAt),
          ),
        )
      return {
        projectId,
        projectVersion: p.version,
        canWrite:
          actor.id === p.technicalOwnerId &&
          ['technical', 'admin'].includes(actor.role) &&
          p.currentNpiStage !== 'completed',
        gate: await lifecycleGate(tx, p),
        records: records.map(({ record, author }) => ({
          ...record,
          author: author || '未命名',
          files: files.filter((f) => f.recordId === record.id).length,
          missing: submissionErrors(
            record,
            files.filter((f) => f.recordId === record.id),
          ),
          overdue:
            p.currentNpiStage !== 'completed' &&
            record.status !== 'cancelled' &&
            (record.status === 'draft'
              ? !!record.plannedDate && record.plannedDate < today()
              : records.find(
                  ({ record: r }) =>
                    r.kind === record.kind && r.status !== 'cancelled',
                )?.record.id === record.id &&
                ['continue', 'fail'].includes(record.result) &&
                !!record.data.fields.followUpDate &&
                record.data.fields.followUpDate < today()),
        })),
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export type LifecycleView = Awaited<ReturnType<typeof getLifecycle>>
export async function saveLifecycle(
  userId: string,
  projectId: string,
  id: string,
  input: Record<string, unknown>,
) {
  uuidValue(id)
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true),
      p = await loadProject(tx, projectId, actor, true)
    requireLifecycleOwner(actor, p)
    const [old] = await tx
      .select()
      .from(s.npiLifecycleRecords)
      .where(eq(s.npiLifecycleRecords.id, id))
      .for('update')
    if (old && old.programId !== projectId)
      throw new NpiError('VERSION_CONFLICT', '记录归属不一致', 409)
    versionCheck(old?.version || 0, input.expectedVersion)
    if (old && old.status !== 'draft')
      throw new NpiError(
        'INVALID_STATE_TRANSITION',
        '已提交或已取消记录保留原文，请新增复核或复测记录',
        409,
      )
    const action = input.action || 'draft'
    if (!['draft', 'submit', 'cancel'].includes(String(action)))
      throw new NpiError('VALIDATION_ERROR', '记录操作无效')
    if (action === 'cancel') {
      if (!old) throw new NpiError('VALIDATION_ERROR', '请先保存记录')
      const reason = textValue(input.reason, '取消原因', 2000)
      await tx
        .update(s.npiLifecycleRecords)
        .set({
          status: 'cancelled',
          version: old.version + 1,
          updatedBy: actor.id,
          updatedAt: new Date(),
        })
        .where(eq(s.npiLifecycleRecords.id, id))
      await event(tx, actor, projectId, id, 'LIFECYCLE_CANCELLED', {
        name: old.title,
        kind: old.kind,
        reason,
        before: old,
      })
    } else {
      const kind = input.kind as LifecycleKind
      if (!lifecycleKinds.includes(kind) || (old && old.kind !== kind))
        throw new NpiError(
          'VALIDATION_ERROR',
          '记录类型无效或已改变，请另建记录',
        )
      const result = String(input.result || '') as LifecycleResult
      if (
        !Object.hasOwn(resultLabels, result) ||
        (result === 'not_applicable' && kind !== 'trial')
      )
        throw new NpiError('VALIDATION_ERROR', '结论无效')
      const values = {
        kind,
        title: textValue(input.title, '记录标题', 200),
        plannedDate: dateValue(input.plannedDate, '计划日期', true),
        performedDate: dateValue(input.performedDate, '实际记录日期', true),
        data: parseLifecycleData(kind, input.data),
        result,
        status: (action === 'submit' ? 'submitted' : 'draft') as
          'submitted' | 'draft',
        submittedAt: action === 'submit' ? new Date() : null,
        updatedBy: actor.id,
        updatedAt: new Date(),
        version: (old?.version || 0) + 1,
      }
      let issueId = old?.issueId || null
      if (action === 'submit') {
        const files = await tx
          .select()
          .from(s.npiAttachments)
          .where(
            and(
              eq(s.npiAttachments.lifecycleRecordId, id),
              eq(s.npiAttachments.programId, projectId),
            ),
          )
        const errors = submissionErrors(values, files)
        if (errors.length)
          throw new NpiError('LIFECYCLE_INCOMPLETE', errors.join('；'), 422)
        if (['fail', 'continue'].includes(result)) {
          const [issue] = await tx
            .insert(s.npiIssues)
            .values({
              programId: projectId,
              number: 'ISS-' + randomUUID(),
              title:
                `${lifecycleDefinitions[kind].label} · ${values.title}`.slice(
                  0,
                  200,
                ),
              description: `${values.data.fields.summary}\n后续措施：${values.data.fields.nextAction}\n来源流程记录：${id}`,
              severity: result === 'fail' ? 'High' : 'Medium',
              ownerId: p.technicalOwnerId,
              createdBy: actor.id,
              targetDate: values.data.fields.followUpDate!,
            })
            .returning()
          issueId = issue!.id
          await event(tx, actor, projectId, issueId, 'ISSUE_CREATED', {
            title: issue!.title,
            lifecycleRecordId: id,
            targetDate: issue!.targetDate,
          })
        }
      }
      if (old)
        await tx
          .update(s.npiLifecycleRecords)
          .set({ ...values, issueId })
          .where(eq(s.npiLifecycleRecords.id, id))
      else
        await tx.insert(s.npiLifecycleRecords).values({
          ...values,
          id,
          programId: projectId,
          createdBy: actor.id,
          issueId,
        })
      await event(
        tx,
        actor,
        projectId,
        id,
        action === 'submit' ? 'LIFECYCLE_SUBMITTED' : 'LIFECYCLE_SAVED',
        {
          name: values.title,
          kind,
          before: old || null,
          after: { ...values, issueId },
        },
      )
    }
    await tx
      .update(s.npiProjects)
      .set({ version: sql`${s.npiProjects.version} + 1` })
      .where(eq(s.npiProjects.programId, projectId))
    return { id }
  })
}
