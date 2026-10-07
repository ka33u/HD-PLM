// SPDX-License-Identifier: AGPL-3.0-or-later
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema/users'
import * as s from '../db/schema/npi'
import { requireAdmin } from '../auth/accounts'
import { event, uuidValue, versionCheck } from './service'
import { NpiError, textValue } from './domain'
export async function listDepartments(userId: string) {
  await requireAdmin(userId)
  const departments = await db
    .select()
    .from(s.npiDepartments)
    .orderBy(asc(s.npiDepartments.name))
  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      active: users.active,
      role: s.npiUserRoles.role,
      departmentId: s.npiUserRoles.departmentId,
    })
    .from(users)
    .innerJoin(s.npiUserRoles, eq(s.npiUserRoles.userId, users.id))
    .orderBy(asc(users.name))
  const events = await db
    .select({
      id: s.npiEvents.id,
      createdAt: s.npiEvents.createdAt,
      actorName: users.name,
      detail: s.npiEvents.detail,
    })
    .from(s.npiEvents)
    .innerJoin(users, eq(users.id, s.npiEvents.actorId))
    .where(eq(s.npiEvents.action, 'DEPARTMENT_CHANGED'))
    .orderBy(desc(s.npiEvents.createdAt))
    .limit(30)
  const history = events.map((e) => {
    const d = e.detail as {
      reason: string
      after: { name: string; memberIds: string[] }
      before: { memberIds: string[] } | null
    }
    return {
      id: e.id,
      createdAt: e.createdAt,
      actorName: e.actorName,
      reason: d.reason,
      name: d.after.name,
      beforeCount: d.before?.memberIds.length || 0,
      afterCount: d.after.memberIds.length,
    }
  })
  return { departments, members, history }
}
export async function saveDepartment(
  userId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    // Shared with account edits and checked by business writes: changing a group
    // cannot race a task mutation authorized against its previous membership.
    await tx.execute(sql`select pg_advisory_xact_lock(73421001)`)
    const actor = await requireAdmin(userId, tx)
    const id = input.id ? uuidValue(input.id) : null
    const [old] = id
      ? await tx
          .select()
          .from(s.npiDepartments)
          .where(eq(s.npiDepartments.id, id))
          .for('update')
      : []
    if (id && !old)
      throw new NpiError('DEPARTMENT_NOT_FOUND', '部门不存在', 404)
    versionCheck(old?.version || 0, input.expectedVersion)
    const name = textValue(input.name, '部门名称', 100),
      reason = textValue(input.reason, '变更原因', 2000)
    if (!['manufacturing', 'procurement'].includes(String(input.role)))
      throw new NpiError('VALIDATION_ERROR', '请选择制造或采购岗位')
    const role = input.role as 'manufacturing' | 'procurement'
    if (old && old.role !== role)
      throw new NpiError(
        'VALIDATION_ERROR',
        '部门岗位不能改写，请建立新分组并重新安排成员',
      )
    if (!Array.isArray(input.memberIds) || input.memberIds.length > 500)
      throw new NpiError('VALIDATION_ERROR', '请选择部门成员，最多500人')
    const ids = [...new Set(input.memberIds.map(uuidValue))]
    const members = ids.length
      ? await tx
          .select({
            id: users.id,
            active: users.active,
            role: s.npiUserRoles.role,
            departmentId: s.npiUserRoles.departmentId,
          })
          .from(users)
          .innerJoin(s.npiUserRoles, eq(s.npiUserRoles.userId, users.id))
          .where(inArray(users.id, ids))
      : []
    if (
      members.length !== ids.length ||
      members.some((m) => !m.active || m.role !== role)
    )
      throw new NpiError('VALIDATION_ERROR', '成员必须是已启用的同岗位账号')
    if (members.some((m) => m.departmentId && m.departmentId !== id))
      throw new NpiError(
        'VERSION_CONFLICT',
        '成员已属于其他部门，请先在原部门移出并刷新',
        409,
      )
    const previous = id
      ? await tx
          .select()
          .from(s.npiUserRoles)
          .where(eq(s.npiUserRoles.departmentId, id))
      : []
    const [department] = old
      ? await tx
          .update(s.npiDepartments)
          .set({ name, version: old.version + 1 })
          .where(eq(s.npiDepartments.id, old.id))
          .returning()
      : await tx.insert(s.npiDepartments).values({ name, role }).returning()
    await tx
      .update(s.npiUserRoles)
      .set({ departmentId: null })
      .where(eq(s.npiUserRoles.departmentId, department!.id))
    if (ids.length)
      await tx
        .update(s.npiUserRoles)
        .set({ departmentId: department!.id })
        .where(inArray(s.npiUserRoles.userId, ids))
    await event(tx, actor, null, department!.id, 'DEPARTMENT_CHANGED', {
      reason,
      before: old ? { ...old, memberIds: previous.map((p) => p.userId) } : null,
      after: { ...department, memberIds: ids },
    })
    return department!
  })
}
