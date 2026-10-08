// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db'
import { projects } from '../db/schema/projects'
import * as s from '../db/schema/npi'
import { users } from '../db/schema/users'
import { event, getActor, uuidValue, versionCheck } from './service'
import { NpiError, textValue } from './domain'
export async function trashedProjects(userId: string, projectId?: string) {
  const actor = await getActor(userId)
  if (!['admin', 'technical'].includes(actor.role))
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '仅技术负责人或管理员可管理回收站',
      403,
    )
  const technical = alias(users, 'trash_technical'),
    manufacturing = alias(users, 'trash_manufacturing')
  const rows = await db
    .select({
      id: s.npiProjects.programId,
      name: projects.name,
      code: projects.code,
      motorModel: s.npiProjects.motorModel,
      deletedAt: s.npiProjects.deletedAt,
      reason: s.npiProjects.deletionReason,
      version: s.npiProjects.version,
      customer: projects.customer,
      stage: s.npiProjects.currentNpiStage,
      technicalOwnerId: s.npiProjects.technicalOwnerId,
      technicalOwnerName: technical.name,
      manufacturingOwnerName: manufacturing.name,
      requiredKitDate: s.npiProjects.requiredKitDate,
      prototypeRequiredDate: s.npiProjects.prototypeRequiredDate,
      deletedByName: sql<
        string | null
      >`(select u.name from ${s.npiEvents} e join ${users} u on u.id = e.actor_id where e.program_id = ${s.npiProjects.programId} and e.action = 'PROJECT_TRASHED' order by e.created_at desc, e.id desc limit 1)`,
    })
    .from(s.npiProjects)
    .innerJoin(projects, eq(projects.id, s.npiProjects.programId))
    .innerJoin(technical, eq(technical.id, s.npiProjects.technicalOwnerId))
    .innerJoin(
      manufacturing,
      eq(manufacturing.id, s.npiProjects.manufacturingOwnerId),
    )
    .where(
      and(
        isNotNull(s.npiProjects.deletedAt),
        projectId
          ? eq(s.npiProjects.programId, uuidValue(projectId))
          : undefined,
        actor.role === 'admin'
          ? undefined
          : eq(s.npiProjects.technicalOwnerId, actor.id),
      ),
    )
    .orderBy(desc(s.npiProjects.deletedAt), asc(s.npiProjects.programId))
  return rows.map((row) => ({
    ...row,
    deletedAt: row.deletedAt!.toISOString(),
  }))
}

export async function trashedProjectDetail(userId: string, id: string) {
  const [project] = await trashedProjects(userId, id)
  if (!project)
    throw new NpiError(
      'PROGRAM_NOT_FOUND',
      '项目已恢复或不在你的回收站中，请刷新列表',
      404,
    )
  const [counts] = await db
    .select({
      bomVersions: sql<number>`(select count(*)::int from ${s.npiBomImports} where program_id = ${id})`,
      trackingItems: sql<number>`(select count(*)::int from ${s.npiTrackingItems} where program_id = ${id})`,
      attachments: sql<number>`(select count(*)::int from ${s.npiAttachments} where program_id = ${id})`,
      issues: sql<number>`(select count(*)::int from ${s.npiIssues} where program_id = ${id})`,
    })
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, id))
  const history = await db
    .select({
      id: s.npiEvents.id,
      action: s.npiEvents.action,
      detail: s.npiEvents.detail,
      actorName: users.name,
      createdAt: s.npiEvents.createdAt,
    })
    .from(s.npiEvents)
    .innerJoin(users, eq(users.id, s.npiEvents.actorId))
    .where(
      and(
        eq(s.npiEvents.programId, id),
        inArray(s.npiEvents.action, ['PROJECT_TRASHED', 'PROJECT_RESTORED']),
      ),
    )
    .orderBy(desc(s.npiEvents.createdAt), desc(s.npiEvents.id))
    .limit(20)
  return {
    project,
    counts: counts!,
    history: history.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actorName: entry.actorName,
      createdAt: entry.createdAt.toISOString(),
      reason: String((entry.detail as { reason?: unknown })?.reason || ''),
    })),
  }
}

export async function restoreTrashedProjects(
  userId: string,
  input: Record<string, unknown>,
) {
  const reason = textValue(input.reason, '恢复原因', 2000)
  if (
    !Array.isArray(input.projects) ||
    !input.projects.length ||
    input.projects.length > 50
  )
    throw new NpiError('VALIDATION_ERROR', '每次请选择1至50个项目')
  const requested = input.projects
    .map((entry: unknown) => {
      if (!entry || typeof entry !== 'object')
        throw new NpiError('VALIDATION_ERROR', '项目参数无效')
      const item = entry as Record<string, unknown>
      return { id: uuidValue(item.id), expectedVersion: item.expectedVersion }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  if (new Set(requested.map((p) => p.id)).size !== requested.length)
    throw new NpiError('VALIDATION_ERROR', '不能重复选择同一项目')
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    if (!['admin', 'technical'].includes(actor.role))
      throw new NpiError(
        'NPI_PERMISSION_DENIED',
        '仅技术负责人或管理员可恢复项目',
        403,
      )
    // Consistent locking order and one transaction make a batch all-or-nothing.
    const rows = await tx
      .select()
      .from(s.npiProjects)
      .where(
        inArray(
          s.npiProjects.programId,
          requested.map((p) => p.id),
        ),
      )
      .orderBy(asc(s.npiProjects.programId))
      .for('update')
    if (
      rows.length !== requested.length ||
      rows.some(
        (p) => actor.role !== 'admin' && p.technicalOwnerId !== actor.id,
      )
    )
      throw new NpiError(
        'NPI_PERMISSION_DENIED',
        '所选项目不在你的管理范围内，未恢复任何项目',
        403,
      )
    for (const row of rows) {
      const request = requested.find((p) => p.id === row.programId)!
      versionCheck(row.version, request.expectedVersion)
      if (!row.deletedAt)
        throw new NpiError(
          'VERSION_CONFLICT',
          '所选项目状态已变化，未恢复任何项目，请刷新后重新选择',
          409,
        )
    }
    for (const row of rows) {
      await tx
        .update(s.npiProjects)
        .set({ deletedAt: null, deletionReason: '', version: row.version + 1 })
        .where(eq(s.npiProjects.programId, row.programId))
      await event(tx, actor, row.programId, row.programId, 'PROJECT_RESTORED', {
        reason,
      })
    }
    return { restored: requested.map((p) => p.id) }
  })
}
export type TrashedProject = Awaited<ReturnType<typeof trashedProjects>>[number]
export type TrashedProjectDetail = Awaited<
  ReturnType<typeof trashedProjectDetail>
>
export async function changeProjectTrash(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    const [project] = await tx
      .select()
      .from(s.npiProjects)
      .where(eq(s.npiProjects.programId, uuidValue(id)))
      .for('update')
    if (!project) throw new NpiError('PROGRAM_NOT_FOUND', '项目不存在', 404)
    if (
      actor.role !== 'admin' &&
      (actor.role !== 'technical' || project.technicalOwnerId !== actor.id)
    )
      throw new NpiError(
        'NPI_PERMISSION_DENIED',
        '仅技术负责人或管理员可删除或恢复项目',
        403,
      )
    versionCheck(project.version, input.expectedVersion)
    const reason = textValue(input.reason, '操作原因', 2000)
    if (!['delete', 'restore'].includes(String(input.action)))
      throw new NpiError('VALIDATION_ERROR', '操作无效')
    const deleted = input.action === 'delete'
    if (deleted === !!project.deletedAt)
      throw new NpiError('VERSION_CONFLICT', '项目状态已改变，请刷新', 409)
    if (input.confirmCode !== undefined) {
      const [p] = await tx
        .select({ code: projects.code })
        .from(projects)
        .where(eq(projects.id, id))
      if (p?.code !== input.confirmCode)
        throw new NpiError('VALIDATION_ERROR', '项目编号不一致')
    } else if (deleted)
      throw new NpiError('VALIDATION_ERROR', '请输入项目编号确认删除')
    await tx
      .update(s.npiProjects)
      .set({
        deletedAt: deleted ? new Date() : null,
        deletionReason: deleted ? reason : '',
        version: project.version + 1,
      })
      .where(eq(s.npiProjects.programId, id))
    await event(
      tx,
      actor,
      id,
      id,
      deleted ? 'PROJECT_TRASHED' : 'PROJECT_RESTORED',
      { reason },
    )
    return { deleted, version: project.version + 1 }
  })
}
