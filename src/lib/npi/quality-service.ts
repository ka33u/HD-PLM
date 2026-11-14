import { readProjectProfile } from './project-profile'
// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, type TransactionClient } from '../db'
import { projects } from '../db/schema/projects'
import { users } from '../db/schema/users'
import * as s from '../db/schema/npi'
import { dateValue, NpiError, textValue, today } from './domain'
import {
  event,
  getActor,
  loadProject,
  uuidValue,
  versionCheck,
  type Actor,
} from './service'
import {
  qualityCommonFields,
  qualityFields,
  qualityKinds,
  qualityResults,
  type QualityKind,
} from './quality'
type Run = TransactionClient | typeof db
const deny = (): never => {
  throw new NpiError(
    'NPI_PERMISSION_DENIED',
    '只有质量人员或管理员可以维护质量记录',
    403,
  )
}
export async function qualityProject(
  run: Run,
  actor: Actor,
  id: string,
  edit = false,
) {
  uuidValue(id)
  if (edit && !['quality', 'admin'].includes(actor.role)) return deny()
  if (!['quality', 'admin'].includes(actor.role))
    return loadProject(run, id, actor)
  const q = run
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, id))
  const [p] = edit ? await q.for('update') : await q
  if (!p || p.deletedAt)
    throw new NpiError('PROGRAM_NOT_FOUND', '新品项目不存在或已移入回收站', 404)
  if (edit && p.currentNpiStage === 'completed')
    throw new NpiError('INVALID_STATE_TRANSITION', '已完成项目为只读')
  return p
}
export async function qualityProjects(userId: string) {
  const actor = await getActor(userId)
  if (!['quality', 'admin'].includes(actor.role)) return deny()
  return db
    .select({
      id: projects.id,
      code: projects.code,
      name: projects.name,
      motorModel: s.npiProjects.motorModel,
      stage: s.npiProjects.currentNpiStage,
      owner: users.name,
      count: sql<number>`(select count(*)::int from npi_quality_records q where q.program_id = ${projects.id} and q.status <> 'voided')`,
      open: sql<number>`(select count(*)::int from npi_quality_records q where q.program_id = ${projects.id} and q.status <> 'voided' and q.exception_status = 'open')`,
    })
    .from(s.npiProjects)
    .innerJoin(projects, eq(projects.id, s.npiProjects.programId))
    .innerJoin(users, eq(users.id, s.npiProjects.technicalOwnerId))
    .where(isNull(s.npiProjects.deletedAt))
    .orderBy(desc(projects.createdAt))
}
export async function qualityDetail(userId: string, id: string) {
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx),
        p = await qualityProject(tx, actor, id)
      const [profile] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, id))
      const records = await tx
        .select()
        .from(s.npiQualityRecords)
        .where(eq(s.npiQualityRecords.programId, id))
        .orderBy(desc(s.npiQualityRecords.createdAt))
      return {
        project: {
          id,
          name: profile!.name,
          code: profile!.code,
          motorModel: p.motorModel,
          motorCode: readProjectProfile(profile).motorCode,
          stage: p.currentNpiStage,
        },
        canWrite:
          ['quality', 'admin'].includes(actor.role) &&
          p.currentNpiStage !== 'completed',
        actorName: actor.name,
        records,
        openCount: records.filter(
          (r) => r.status !== 'voided' && r.exceptionStatus === 'open',
        ).length,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export async function qualityHistory(userId: string, id: string) {
  const actor = await getActor(userId),
    [r] = await db
      .select()
      .from(s.npiQualityRecords)
      .where(eq(s.npiQualityRecords.id, uuidValue(id)))
  if (!r) throw new NpiError('RECORD_NOT_FOUND', '记录不存在', 404)
  await qualityProject(db, actor, r.programId)
  return db
    .select({
      id: s.npiEvents.id,
      action: s.npiEvents.action,
      detail: s.npiEvents.detail,
      at: s.npiEvents.createdAt,
      actor: users.name,
    })
    .from(s.npiEvents)
    .innerJoin(users, eq(users.id, s.npiEvents.actorId))
    .where(
      and(eq(s.npiEvents.programId, r.programId), eq(s.npiEvents.objectId, id)),
    )
    .orderBy(desc(s.npiEvents.createdAt))
    .limit(100)
}
export async function saveQuality(
  userId: string,
  programId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    await qualityProject(tx, actor, programId, true)
    const id = uuidValue(input.id),
      [old] = await tx
        .select()
        .from(s.npiQualityRecords)
        .where(eq(s.npiQualityRecords.id, id))
    if (old && old.programId !== programId) return deny()
    versionCheck(old?.version || 0, input.version)
    const action = String(input.action || 'save')
    if (!['save', 'submit', 'reopen', 'resolve', 'void'].includes(action))
      throw new NpiError('VALIDATION_ERROR', '质量操作无效')
    if (old?.status === 'voided')
      throw new NpiError('INVALID_STATE_TRANSITION', '已作废记录为只读')
    let values: Partial<typeof s.npiQualityRecords.$inferInsert> = {}
    if (['reopen', 'resolve', 'void'].includes(action)) {
      if (!old) throw new NpiError('RECORD_NOT_FOUND', '请先保存记录', 404)
      const reason = textValue(
        input.reason,
        action === 'resolve' ? '处置与复验结论' : '修改 / 作废原因',
        8000,
      )
      if (action === 'resolve') {
        if (old.status !== 'recorded' || old.exceptionStatus !== 'open')
          throw new NpiError(
            'INVALID_STATE_TRANSITION',
            '请先提交异常记录，再填写处置与复验结论',
          )
        values = { exceptionStatus: 'closed', resolution: reason }
      } else if (action === 'reopen') {
        if (old.status !== 'recorded')
          throw new NpiError(
            'INVALID_STATE_TRANSITION',
            '只有已记录内容可以撤回编辑',
          )
        values = { status: 'draft' }
      } else values = { status: 'voided' }
    } else {
      if (old && old.status !== 'draft')
        throw new NpiError('INVALID_STATE_TRANSITION', '已提交记录需先撤回编辑')
      const kind = String(input.kind) as QualityKind
      if (!Object.hasOwn(qualityKinds, kind) || (old && old.kind !== kind))
        throw new NpiError('VALIDATION_ERROR', '记录分类无效或不能变更')
      const title = textValue(input.title, '记录标题', 200),
        performedDate = input.performedDate
          ? dateValue(input.performedDate, '检验日期')
          : null
      if (performedDate && performedDate > today())
        throw new NpiError('VALIDATION_ERROR', '检验日期不能晚于今天')
      const result = String(input.result || '') as
        keyof typeof qualityResults | ''
      if (result && !Object.hasOwn(qualityResults, result))
        throw new NpiError('VALIDATION_ERROR', '检验结论无效')
      if (
        !input.data ||
        typeof input.data !== 'object' ||
        Array.isArray(input.data)
      )
        throw new NpiError('VALIDATION_ERROR', '检验内容格式无效')
      const data: Record<string, string> = {}
      for (const field of [...qualityFields[kind], ...qualityCommonFields]) {
        const raw = (input.data as Record<string, unknown>)[field.key]
        data[field.key] =
          raw === undefined || raw === ''
            ? ''
            : textValue(raw, field.label, field.multiline ? 8000 : 300)
      }
      if (kind === 'incoming') {
        for (const key of ['quantity', 'sampleQuantity'])
          if (
            data[key] &&
            (!/^\d+(\.\d{1,6})?$/.test(data[key]!) ||
              !Number.isFinite(Number(data[key])) ||
              Number(data[key]) <= 0)
          )
            throw new NpiError(
              'VALIDATION_ERROR',
              '来料数量和检验数量必须大于零',
            )
        if (
          data.quantity &&
          data.sampleQuantity &&
          Number(data.sampleQuantity) > Number(data.quantity)
        )
          throw new NpiError('VALIDATION_ERROR', '检验数量不能超过来料数量')
      }
      if (action === 'submit') {
        if (!performedDate || !result)
          throw new NpiError('VALIDATION_ERROR', '请填写检验日期和结论')
        for (const field of [
          ...qualityFields[kind],
          ...qualityCommonFields.filter((f) => f.key !== 'action'),
        ])
          if (!data[field.key])
            throw new NpiError('VALIDATION_ERROR', `请填写${field.label}`)
        if (result !== 'pass' && !data.action)
          throw new NpiError(
            'VALIDATION_ERROR',
            '异常或待确认记录须填写跟进安排',
          )
        const files = await tx
          .select()
          .from(s.npiAttachments)
          .where(
            and(
              eq(s.npiAttachments.qualityRecordId, id),
              isNull(s.npiAttachments.archivedAt),
            ),
          )
        if (
          !files.some(
            (f) => f.category === 'evidence' && f.mimeType.startsWith('image/'),
          )
        )
          throw new NpiError(
            'VALIDATION_ERROR',
            '请先保存草稿并上传检验现场照片',
          )
        if (
          result === 'pass' &&
          files.some((f) => f.category === 'report' && f.conclusion !== 'pass')
        )
          throw new NpiError(
            'VALIDATION_ERROR',
            '存在不通过或继续跟踪的报告，检验结论不能选合格；请核对依据或修订报告',
          )
        if (kind === 'sample' && !files.some((f) => f.category === 'report'))
          throw new NpiError(
            'VALIDATION_ERROR',
            '样机报告须上传报告文件并填写分析与结论',
          )
      }
      values = {
        kind,
        title,
        performedDate,
        result,
        data,
        status: action === 'submit' ? 'recorded' : 'draft',
        exceptionStatus: result && result !== 'pass' ? 'open' : 'none',
        resolution: '',
      }
    }
    const updated = {
      ...values,
      updatedBy: actor.id,
      updatedAt: new Date(),
      version: (old?.version || 0) + 1,
    }
    const [record] = old
      ? await tx
          .update(s.npiQualityRecords)
          .set(updated)
          .where(eq(s.npiQualityRecords.id, id))
          .returning()
      : await tx
          .insert(s.npiQualityRecords)
          .values({
            id,
            programId,
            createdBy: actor.id,
            ...updated,
          } as typeof s.npiQualityRecords.$inferInsert)
          .returning()
    await event(tx, actor, programId, id, 'QUALITY_' + action.toUpperCase(), {
      title: record!.title,
      before: old || null,
      after: record,
      reason: input.reason || '',
    })
    return record!
  })
}
export type QualityDetail = Awaited<ReturnType<typeof qualityDetail>>
export type QualityRecord = QualityDetail['records'][number]
