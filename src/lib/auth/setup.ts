import { createHash, timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db'
import { accountEvents, loginLimits, users } from '../db/schema/users'
import { npiUserRoles } from '../db/schema/npi'
import { NpiError, textValue } from '../npi/domain'
import { emailValue, hashPassword, passwordValue } from './accounts'
import { createSession } from './session'

export type SetupAccess = 'local' | 'token' | 'unavailable'
function setupAccess(address: string): SetupAccess {
  if (process.env.SETUP_TOKEN?.trim()) return 'token'
  let hostname = ''
  try {
    hostname = new URL(process.env.BASE_URL || '').hostname
  } catch {}
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  const localSocket = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
  return localHost && localSocket ? 'local' : 'unavailable'
}
export async function needsSetup() {
  return (await db.select({ id: users.id }).from(users).limit(1)).length === 0
}
export async function setupStatus(address: string) {
  const required = await needsSetup()
  return { required, access: required ? setupAccess(address) : null }
}
function setupClosed(): never {
  throw new NpiError('SETUP_COMPLETED', '管理员已创建，请使用现有账号登录', 409)
}
export async function initializeAdministrator(
  input: Record<string, unknown>,
  address: string,
) {
  if (!(await needsSetup())) setupClosed()
  const key = createHash('sha256')
    .update('setup:' + address)
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
      'SETUP_RATE_LIMIT',
      '初始化尝试过于频繁，请15分钟后重试',
      429,
    )
  const access = setupAccess(address)
  if (access === 'unavailable')
    throw new NpiError(
      'SETUP_LOCAL_ONLY',
      '请在服务器本机完成初始化，或联系部署人员配置初始化密钥',
      403,
    )
  if (access === 'token') {
    const expected = process.env.SETUP_TOKEN!.trim()
    const supplied =
      typeof input.setupToken === 'string' ? input.setupToken.trim() : ''
    const digest = (value: string) =>
      createHash('sha256').update(value).digest()
    if (
      expected.length < 24 ||
      supplied.length > 256 ||
      !timingSafeEqual(digest(expected), digest(supplied))
    )
      throw new NpiError(
        'SETUP_TOKEN_INVALID',
        '初始化密钥不正确，请向部署人员核对',
        403,
      )
  }
  const name = textValue(input.name, '管理员姓名', 100)
  const email = emailValue(input.email)
  const password = passwordValue(input.password)
  if (password !== input.confirmPassword)
    throw new NpiError('VALIDATION_ERROR', '两次输入的密码不一致')
  const passwordHash = await hashPassword(password)
  return db.transaction(async (tx) => {
    // Same lock as account management: only one request can claim an empty installation.
    await tx.execute(sql`select pg_advisory_xact_lock(73421001)`)
    if ((await tx.select({ id: users.id }).from(users).limit(1)).length)
      setupClosed()
    const [user] = await tx
      .insert(users)
      .values({ name, email, passwordHash, mustChangePassword: false })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        mustChangePassword: users.mustChangePassword,
      })
    await tx.insert(npiUserRoles).values({ userId: user!.id, role: 'admin' })
    await tx
      .insert(accountEvents)
      .values({
        actorId: user!.id,
        targetId: user!.id,
        action: 'ADMIN_INITIALIZED',
        detail: { method: 'first_run' },
      })
    const session = await createSession(user!.id, tx)
    return { ...session, user: { ...user!, role: 'admin' } }
  })
}
