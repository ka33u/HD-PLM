// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema/projects'
import * as s from '../db/schema/npi'
import { event, getActor, uuidValue, versionCheck } from './service'
import { NpiError, textValue } from './domain'
export async function trashedProjects(userId: string) {
  const actor = await getActor(userId)
  if (!['admin', 'technical'].includes(actor.role))
    throw new NpiError(
      'NPI_PERMISSION_DENIED',
      '仅技术负责人或管理员可管理回收站',
      403,
    )
  return db
    .select({
      id: s.npiProjects.programId,
      name: projects.name,
      code: projects.code,
      motorModel: s.npiProjects.motorModel,
      deletedAt: s.npiProjects.deletedAt,
      reason: s.npiProjects.deletionReason,
      version: s.npiProjects.version,
    })
    .from(s.npiProjects)
    .innerJoin(projects, eq(projects.id, s.npiProjects.programId))
    .where(
      and(
        isNotNull(s.npiProjects.deletedAt),
        actor.role === 'admin'
          ? undefined
          : eq(s.npiProjects.technicalOwnerId, actor.id),
      ),
    )
    .orderBy(desc(s.npiProjects.deletedAt))
}
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
