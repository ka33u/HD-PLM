import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db, type TransactionClient } from '../db'
import { accountEvents, loginLimits, sessions, users } from '../db/schema/users'
import { npiDepartments, npiUserRoles } from '../db/schema/npi'
import { accountRegistrations } from '../db/schema/registrations'
import { NpiError, textValue } from '../npi/domain'
import { uuidValue, versionCheck } from '../npi/service'
import {
  emailValue,
  hashPassword,
  passwordValue,
  requireAdmin,
} from './accounts'
import {
  departmentCategories,
  type DepartmentCategory,
} from './department-categories'

async function requireInitialized(tx: TransactionClient | typeof db = db) {
  const [admin] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(npiUserRoles, eq(npiUserRoles.userId, users.id))
    .where(and(eq(npiUserRoles.role, 'admin'), eq(users.active, true)))
    .limit(1)
  if (!admin)
    throw new NpiError('SETUP_REQUIRED', '请先由管理员完成系统初始化', 409)
}
export async function registrationOptions() {
  await requireInitialized()
  const departments = await db
    .select({
      id: npiDepartments.id,
      name: npiDepartments.name,
      role: npiDepartments.role,
    })
    .from(npiDepartments)
    .where(
      inArray(
        npiDepartments.role,
        Object.keys(departmentCategories) as DepartmentCategory[],
      ),
    )
    .orderBy(asc(npiDepartments.name))
  return { departments, approvalRequired: true }
}
async function departmentValue(tx: TransactionClient, id: unknown) {
  const [department] = await tx
    .select()
    .from(npiDepartments)
    .where(eq(npiDepartments.id, uuidValue(id)))
  if (!department || !Object.hasOwn(departmentCategories, department.role))
    throw new NpiError('VALIDATION_ERROR', '请选择有效的设计、生产或采购部门')
  return department
}
export async function registerAccount(
  input: Record<string, unknown>,
  address: string,
) {
  await requireInitialized()
  // Actual socket address, separate budget from login; count before Argon2 work.
  const key = createHash('sha256')
    .update('registration:' + address)
    .digest('hex')
  const [limit] = await db
    .insert(loginLimits)
    .values({ key, count: 1, expiresAt: new Date(Date.now() + 15 * 60000) })
    .onConflictDoUpdate({
      target: loginLimits.key,
      set: {
        count: sql`case when ${loginLimits.expiresAt} < now() then 1 else ${loginLimits.count} + 1 end`,
        expiresAt: sql`case when ${loginLimits.expiresAt} < now() then now() + interval '15 minutes' else ${loginLimits.expiresAt} end`,
      },
    })
    .returning()
  if (limit!.count > 20)
    throw new NpiError(
      'REGISTRATION_RATE_LIMIT',
      '注册尝试过于频繁，请15分钟后重试',
      429,
    )
  await db.delete(loginLimits).where(lt(loginLimits.expiresAt, new Date()))
  // Never accept privilege or activation choices from a public form.
  if (
    ['role', 'active', 'status', 'mustChangePassword', 'userId'].some((k) =>
      Object.hasOwn(input, k),
    )
  )
    throw new NpiError(
      'VALIDATION_ERROR',
      '注册只需填写个人信息和部门，岗位由部门确定',
    )
  const name = textValue(input.name, '姓名', 100),
    email = emailValue(input.email)
  const password = passwordValue(input.password)
  if (password !== input.confirmPassword)
    throw new NpiError('VALIDATION_ERROR', '两次输入的密码不一致')
  const departmentId = uuidValue(input.departmentId)
  const passwordHash = await hashPassword(password)
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(73421001)`)
    await requireInitialized(tx)
    const department = await departmentValue(tx, departmentId)
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)
    if (existing)
      throw new NpiError(
        'EMAIL_REGISTERED',
        '该邮箱已提交注册或已有账号，请登录或联系管理员核对',
        409,
      )
    const [user] = await tx
      .insert(users)
      .values({
        name,
        email,
        passwordHash,
        active: false,
        mustChangePassword: false,
      })
      .returning({ id: users.id })
    await tx
      .insert(npiUserRoles)
      .values({ userId: user!.id, role: department.role })
    await tx
      .insert(accountRegistrations)
      .values({ userId: user!.id, departmentId })
    await tx
      .insert(accountEvents)
      .values({
        targetId: user!.id,
        action: 'REGISTRATION_SUBMITTED',
        detail: {
          name,
          email,
          departmentId,
          departmentName: department.name,
          role: department.role,
        },
      })
    return { status: 'pending' as const }
  })
}
export async function reviewRegistration(
  actorId: string,
  userId: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(73421001)`)
    await requireAdmin(actorId, tx)
    const [row] = await tx
      .select({ user: users, registration: accountRegistrations })
      .from(users)
      .innerJoin(
        accountRegistrations,
        eq(accountRegistrations.userId, users.id),
      )
      .where(eq(users.id, userId))
      .for('update', { of: users })
    if (!row)
      throw new NpiError('REGISTRATION_NOT_FOUND', '注册申请不存在', 404)
    versionCheck(row.user.version, input.expectedVersion)
    if (row.registration.status === 'approved')
      throw new NpiError(
        'REGISTRATION_REVIEWED',
        '该账号已开通，请使用编辑账号调整',
        409,
      )
    if (!['approve', 'reject'].includes(String(input.decision)))
      throw new NpiError('VALIDATION_ERROR', '请选择开通或驳回')
    const approved = input.decision === 'approve'
    const reason = textValue(input.reason, '审核说明', 2000, approved)
    const department = await departmentValue(
      tx,
      approved ? input.departmentId : row.registration.departmentId,
    )
    await tx
      .update(users)
      .set({
        active: approved,
        failedAttempts: 0,
        lockedUntil: null,
        version: row.user.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
    await tx
      .update(npiUserRoles)
      .set({
        role: department.role,
        departmentId: approved ? department.id : null,
      })
      .where(eq(npiUserRoles.userId, userId))
    if (approved)
      await tx
        .update(npiDepartments)
        .set({ version: sql`${npiDepartments.version}+1` })
        .where(eq(npiDepartments.id, department.id))
    await tx
      .update(accountRegistrations)
      .set({
        status: approved ? 'approved' : 'rejected',
        reviewedAt: new Date(),
      })
      .where(eq(accountRegistrations.userId, userId))
    await tx.delete(sessions).where(eq(sessions.userId, userId))
    await tx.insert(accountEvents).values({
      actorId,
      targetId: userId,
      action: approved ? 'REGISTRATION_APPROVED' : 'REGISTRATION_REJECTED',
      detail: {
        reason,
        requestedDepartmentId: row.registration.departmentId,
        departmentId: department.id,
        departmentName: department.name,
        role: department.role,
      },
    })
    return {
      id: userId,
      status: approved ? 'approved' : 'rejected',
      version: row.user.version + 1,
    }
  })
}
