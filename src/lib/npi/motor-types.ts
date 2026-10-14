// SPDX-License-Identifier: AGPL-3.0-or-later
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { npiMotorTypes } from '../db/schema/npi'
import { NpiError, textValue } from './domain'
import { event, getActor, uuidValue, versionCheck } from './service'
import type { TransactionClient } from '../db'

export async function listMotorTypes(tx: TransactionClient | typeof db = db) {
  return tx
    .select({
      id: npiMotorTypes.id,
      name: npiMotorTypes.name,
      enabled: npiMotorTypes.enabled,
      version: npiMotorTypes.version,
    })
    .from(npiMotorTypes)
    .orderBy(asc(npiMotorTypes.createdAt), asc(npiMotorTypes.name))
}
export async function validateMotorType(
  tx: TransactionClient,
  name: string,
  previous = '',
) {
  // Historical classifications stay readable after an option is retired.
  if (name === previous) return
  if (!name) throw new NpiError('VALIDATION_ERROR', '请选择电机类型')
  const [option] = await tx
    .select()
    .from(npiMotorTypes)
    .where(eq(npiMotorTypes.name, name))
    .for('share')
  if (!option?.enabled)
    throw new NpiError(
      'VALIDATION_ERROR',
      '电机类型不存在或已停用，请刷新选项后重选',
    )
}
export async function saveMotorType(
  userId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    if (actor.role !== 'admin')
      throw new NpiError('NPI_PERMISSION_DENIED', '仅管理员可维护电机类型', 403)
    await tx.execute(sql`select pg_advisory_xact_lock(73421009)`)
    const id = input.id ? uuidValue(input.id) : null
    const [before] = id
      ? await tx
          .select()
          .from(npiMotorTypes)
          .where(eq(npiMotorTypes.id, id))
          .for('update')
      : []
    if (id && !before) throw new NpiError('NOT_FOUND', '电机类型不存在', 404)
    versionCheck(before?.version || 0, input.expectedVersion)
    const name = textValue(input.name, '电机类型', 100)
    if (before && name !== before.name)
      throw new NpiError(
        'VALIDATION_ERROR',
        '已有类型名称保留用于历史项目；请新增类型后停用旧选项',
      )
    if (typeof input.enabled !== 'boolean')
      throw new NpiError('VALIDATION_ERROR', '请选择启用状态')
    const [duplicate] = await tx
      .select()
      .from(npiMotorTypes)
      .where(eq(npiMotorTypes.name, name))
    if (duplicate && duplicate.id !== id)
      throw new NpiError(
        'DUPLICATE_MOTOR_TYPE',
        '该电机类型已存在，请直接启用原选项',
        409,
      )
    const [after] = before
      ? await tx
          .update(npiMotorTypes)
          .set({ enabled: input.enabled, version: before.version + 1 })
          .where(eq(npiMotorTypes.id, before.id))
          .returning()
      : await tx
          .insert(npiMotorTypes)
          .values({ name, enabled: input.enabled })
          .returning()
    await event(tx, actor, null, after!.id, 'MOTOR_TYPE_CHANGED', {
      before: before || null,
      after,
    })
    return after!
  })
}
