import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { chromium, expect } from '@playwright/test'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_registration')
const root = 'http://localhost:3488'
process.env.BASE_URL = root
const { db, closeDatabase } = await import('../src/lib/db')
const { users, sessions, accountEvents, loginLimits } =
  await import('../src/lib/db/schema/users')
const { accountRegistrations } =
  await import('../src/lib/db/schema/registrations')
const s = await import('../src/lib/db/schema/npi')
const { app } = await import('../src/server/app')
const { hashPassword, checkPassword } = await import('../src/lib/auth/accounts')
const { getActor, seedNpiConfig } = await import('../src/lib/npi/service')
const { createSession } = await import('../src/lib/auth/session')
await migrate(db, { migrationsFolder: 'migrations' })
await seedNpiConfig()
type Identity = { id: string; token: string }
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  actor?: Identity,
  address = crypto.randomUUID(),
  origin = root,
) {
  const response = await app.request(
    root + path,
    {
      method,
      headers: {
        origin,
        'content-type': 'application/json',
        ...(actor
          ? { cookie: 'session=' + actor.token, 'x-npi-actor': actor.id }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: address, remotePort: 12345 } } },
  )
  return {
    status: response.status,
    data: (await response.json()) as any,
    cookie: response.headers.get('set-cookie'),
  }
}
const departments = await db.select().from(s.npiDepartments)
const dept = (role: string) => departments.find((d) => d.role === role)!
const payload = (role = 'manufacturing') => {
  const password = 'Personal-' + crypto.randomUUID()
  return {
    name: '注册验收人员',
    email: crypto.randomUUID() + '@register.test.invalid',
    password,
    confirmPassword: password,
    departmentId: dept(role).id,
  }
}
const account = async (email: string) =>
  (await db.select().from(users).where(eq(users.email, email)))[0]!
const member = payload(),
  adminId = crypto.randomUUID(),
  adminPassword = 'Admin-' + crypto.randomUUID()
let admin: Identity, technician: Identity, manufacturer: Identity
let server: ReturnType<typeof spawn> | undefined,
  log: number | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await test('registration cannot claim an uninitialized installation or expose team accounts', async () => {
    assert.equal((await call('/api/auth/register')).status, 409)
    assert.equal((await call('/api/auth/register', 'POST', member)).status, 409)
    assert.equal((await db.select().from(users)).length, 0)
    await db.insert(users).values({
      id: adminId,
      name: '注册验收管理员',
      email: 'admin@register.test.invalid',
      passwordHash: await hashPassword(adminPassword),
      mustChangePassword: false,
    })
    await db.insert(s.npiUserRoles).values({ userId: adminId, role: 'admin' })
    admin = { id: adminId, token: (await createSession(adminId)).sessionToken }
    for (const role of ['technical', 'manufacturing'] as const) {
      const [user] = await db
        .insert(users)
        .values({
          name: '原部门成员-' + role,
          email: role + '@register.test.invalid',
          mustChangePassword: false,
        })
        .returning()
      await db
        .insert(s.npiUserRoles)
        .values({ userId: user!.id, role, departmentId: dept(role).id })
      const identity = {
        id: user!.id,
        token: (await createSession(user!.id)).sessionToken,
      }
      if (role === 'technical') technician = identity
      else manufacturer = identity
    }
    const result = await call('/api/auth/register')
    assert.equal(result.status, 200)
    assert.deepEqual(result.data.departments.map((d: any) => d.role).sort(), [
      'manufacturing',
      'procurement',
      'quality',
      'technical',
    ])
    for (const d of result.data.departments)
      assert.deepEqual(Object.keys(d).sort(), ['id', 'name', 'role'])
    assert.equal(result.data.approvalRequired, true)
  })
  await test('public requests validate confirmations, departments and origin and cannot assign privileges', async () => {
    for (const role of ['admin', 'supervisor', 'technical'])
      assert.equal(
        (await call('/api/auth/register', 'POST', { ...member, role })).status,
        422,
      )
    for (const extra of [
      { active: true },
      { status: 'approved' },
      { mustChangePassword: false },
      { userId: admin.id },
    ])
      assert.equal(
        (await call('/api/auth/register', 'POST', { ...member, ...extra }))
          .status,
        422,
      )
    for (const extra of [
      { confirmPassword: 'not-matching' },
      { password: 'short', confirmPassword: 'short' },
      { departmentId: crypto.randomUUID() },
      { name: ' ' },
      { email: 'invalid' },
    ])
      assert.equal(
        (await call('/api/auth/register', 'POST', { ...member, ...extra }))
          .status,
        422,
      )
    assert.equal(
      (
        await call(
          '/api/auth/register',
          'POST',
          member,
          undefined,
          'cross',
          'https://other.invalid',
        )
      ).status,
      403,
    )
    assert.equal(
      (await call('/api/auth/register', 'POST', member, admin)).data.code,
      'ALREADY_SIGNED_IN',
    )
    assert.equal(await account(member.email), undefined)
  })
  await test('registration saves a hashed, inactive account without session or shared membership; repeat email is rejected', async () => {
    const result = await call('/api/auth/register', 'POST', {
      ...member,
      email: ' ' + member.email.toUpperCase() + ' ',
    })
    assert.equal(result.status, 201)
    assert.deepEqual(result.data, { status: 'pending' })
    assert.equal(result.cookie, null)
    const user = await account(member.email)
    assert.equal(user.active, false)
    assert.equal(user.mustChangePassword, false)
    assert.equal(await checkPassword(user.passwordHash, member.password), true)
    assert.equal(
      (
        await db
          .select()
          .from(s.npiUserRoles)
          .where(eq(s.npiUserRoles.userId, user.id))
      )[0]!.departmentId,
      null,
    )
    assert.equal(
      (await db.select().from(sessions).where(eq(sessions.userId, user.id)))
        .length,
      0,
    )
    assert.equal(
      (await call('/api/auth/register', 'POST', member)).data.code,
      'EMAIL_REGISTERED',
    )
    assert.equal(
      (await call('/api/auth/login', 'POST', member)).data.code,
      'REGISTRATION_PENDING',
    )
    assert.equal((await account(member.email)).failedAttempts, 0)
    assert.equal(
      (
        await call('/api/auth/login', 'POST', {
          ...member,
          password: 'wrong-password',
        })
      ).data.code,
      'LOGIN_FAILED',
    )
    // Even an independently stored token is invalid for an inactive applicant.
    const candidate = {
      id: user.id,
      token: (await createSession(user.id)).sessionToken,
    }
    assert.equal(
      (await call('/api/v1/npi/meta', 'GET', undefined, candidate)).status,
      401,
    )
    assert.equal(
      (
        await call(
          `/api/accounts/${user.id}`,
          'PATCH',
          {
            active: true,
            expectedVersion: user.version,
            reason: '尝试绕过审核',
          },
          admin,
        )
      ).data.code,
      'REGISTRATION_REVIEW_REQUIRED',
    )
    assert.equal(
      (
        await call(
          `/api/accounts/${user.id}/registration`,
          'POST',
          {
            decision: 'approve',
            expectedVersion: user.version,
            departmentId: member.departmentId,
          },
          manufacturer,
        )
      ).status,
      403,
    )
  })
  await test('one concurrent approval succeeds, joins shared production tasks and invalidates stale department edits', async () => {
    const user = await account(member.email),
      oldDepartment = dept('manufacturing')
    const body = {
      decision: 'approve',
      expectedVersion: user.version,
      departmentId: member.departmentId,
      reason: '核对生产部成员',
    }
    const results = await Promise.all([
      call(`/api/accounts/${user.id}/registration`, 'POST', body, admin),
      call(`/api/accounts/${user.id}/registration`, 'POST', body, admin),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    const signed = await call('/api/auth/login', 'POST', member)
    assert.equal(signed.status, 200)
    assert.equal(signed.data.user.mustChangePassword, false)
    assert.equal(signed.data.user.role, 'manufacturing')
    const identity = {
      id: user.id,
      token: /session=([a-f0-9]{64})/.exec(signed.cookie!)![1]!,
    }
    assert((await getActor(user.id)).collaboratorIds?.includes(manufacturer.id))
    const project = await call(
      '/api/v1/npi/projects',
      'POST',
      {
        name: '注册协同电机',
        motorModel: 'YE5-TEST',
        technicalOwnerId: technician.id,
        manufacturingOwnerId: manufacturer.id,
        requiredKitDate: '2026-11-20',
        prototypeRequiredDate: '2026-11-28',
      },
      technician,
    )
    assert.equal(project.status, 201)
    assert.equal(
      (
        await call(
          `/api/v1/npi/projects/${project.data.id}`,
          'GET',
          undefined,
          identity,
        )
      ).status,
      200,
    )
    assert.equal(
      (
        await call(
          '/api/v1/npi/departments',
          'POST',
          {
            id: oldDepartment.id,
            name: oldDepartment.name,
            role: 'manufacturing',
            memberIds: [manufacturer.id],
            expectedVersion: oldDepartment.version,
            reason: '过期页面不应移除新注册成员',
          },
          admin,
        )
      ).status,
      409,
    )
    const row = (
      await call('/api/accounts', 'GET', undefined, admin)
    ).data.accounts.find((a: any) => a.id === user.id)
    assert.equal(row.registrationStatus, 'approved')
    assert.equal(row.departmentName, oldDepartment.name)
    await call(
      `/api/accounts/${user.id}`,
      'PATCH',
      {
        active: false,
        expectedVersion: row.version,
        reason: '验证开通后仍可停用',
      },
      admin,
    )
    assert.equal(
      (await call('/api/auth/me', 'GET', undefined, identity)).status,
      401,
    )
  })
  await test('rejection needs a reason, stays closed, and can be re-reviewed into the correct department', async () => {
    const p = payload(),
      registered = await call('/api/auth/register', 'POST', p)
    assert.equal(registered.status, 201)
    let user = await account(p.email)
    const path = `/api/accounts/${user.id}/registration`
    assert.equal(
      (
        await call(
          path,
          'POST',
          { decision: 'reject', expectedVersion: user.version },
          admin,
        )
      ).status,
      422,
    )
    assert.equal(
      (
        await call(
          path,
          'POST',
          {
            decision: 'reject',
            expectedVersion: user.version,
            reason: '请核对采购部门',
          },
          admin,
        )
      ).status,
      200,
    )
    assert.equal(
      (await call('/api/auth/login', 'POST', p)).data.code,
      'REGISTRATION_REJECTED',
    )
    assert.equal(
      (
        await call(
          path,
          'POST',
          {
            decision: 'approve',
            expectedVersion: user.version,
            departmentId: dept('procurement').id,
          },
          admin,
        )
      ).status,
      409,
    )
    user = await account(p.email)
    assert.equal(
      (
        await call(
          path,
          'POST',
          {
            decision: 'approve',
            expectedVersion: user.version,
            departmentId: dept('procurement').id,
            reason: '确认岗位为采购',
          },
          admin,
        )
      ).status,
      200,
    )
    assert.equal(
      (await call('/api/auth/login', 'POST', p)).data.user.role,
      'procurement',
    )
    assert.equal(
      (
        await db
          .select()
          .from(accountRegistrations)
          .where(eq(accountRegistrations.userId, user.id))
      )[0]!.departmentId,
      p.departmentId,
    )
  })
  await test('design category records affiliation without inheriting another project owner’s authority', async () => {
    const p = payload('technical')
    await call('/api/auth/register', 'POST', p)
    const user = await account(p.email)
    await call(
      `/api/accounts/${user.id}/registration`,
      'POST',
      {
        decision: 'approve',
        expectedVersion: user.version,
        departmentId: p.departmentId,
      },
      admin,
    )
    const actor = await getActor(user.id)
    assert.equal(actor.departmentId, p.departmentId)
    assert.deepEqual(actor.collaboratorIds, [])
    const newGroup = await call(
      '/api/v1/npi/departments',
      'POST',
      {
        name: '研发二部',
        role: 'technical',
        memberIds: [],
        expectedVersion: 0,
        reason: '设计类别可继续扩展',
      },
      admin,
    )
    assert.equal(newGroup.status, 200)
    assert(
      (await call('/api/auth/register')).data.departments.some(
        (d: any) => d.name === '研发二部',
      ),
    )
  })
  await test('duplicate submissions are atomic; audit excludes secrets and registration rate limits are separate', async () => {
    const p = payload('procurement')
    const results = await Promise.all([
      call('/api/auth/register', 'POST', p),
      call('/api/auth/register', 'POST', p),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
    const user = await account(p.email)
    assert.equal(
      (
        await db
          .select()
          .from(accountRegistrations)
          .where(eq(accountRegistrations.userId, user.id))
      ).length,
      1,
    )
    const events = await db.select().from(accountEvents)
    for (const action of [
      'REGISTRATION_SUBMITTED',
      'REGISTRATION_APPROVED',
      'REGISTRATION_REJECTED',
    ])
      assert(events.some((e) => e.action === action))
    assert.doesNotMatch(
      JSON.stringify(events),
      /passwordHash|confirmPassword|Personal-/,
    )
    const address = 'registration-rate-budget'
    await db.insert(loginLimits).values({
      key: createHash('sha256')
        .update('registration:' + address)
        .digest('hex'),
      count: 20,
      expiresAt: new Date(Date.now() + 60000),
    })
    assert.equal(
      (await call('/api/auth/register', 'POST', payload(), undefined, address))
        .status,
      429,
    )
    assert.equal(
      (
        await call(
          '/api/auth/login',
          'POST',
          { email: 'admin@register.test.invalid', password: adminPassword },
          undefined,
          address,
        )
      ).status,
      200,
    )
  })

  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const address = probe.address()
  assert(address && typeof address !== 'string')
  const port = address.port,
    site = `http://localhost:${port}`
  await new Promise<void>((r) => probe.close(() => r()))
  mkdirSync('runtime/test-evidence', { recursive: true })
  log = openSync('runtime/registration-server.log', 'w')
  server = spawn(process.execPath, ['dist/server.mjs'], {
    env: {
      ...process.env,
      BASE_URL: site,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', log, log],
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(site + '/api/health')).ok) break
    } catch {}
    await delay(200)
  }
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const phone = await phoneContext.newPage(),
    errors: string[] = [],
    mobileMember = payload('procurement')
  phone.on('pageerror', (e) => errors.push(e.message))
  await test('mobile signup preserves the target, validates passwords and gives a clear pending state', async () => {
    const target = '/npi?view=procurement'
    await phone.goto(site + '/login?redirect=' + encodeURIComponent(target))
    await phone.getByRole('link', { name: '没有账号？注册新用户' }).click()
    await expect(
      phone.getByRole('heading', { name: '注册新账号' }),
    ).toBeVisible()
    await phone.getByLabel('姓名', { exact: true }).fill('手机采购注册')
    await phone.getByLabel('邮箱', { exact: true }).fill(mobileMember.email)
    await phone
      .getByLabel('部门类别', { exact: true })
      .selectOption('procurement')
    await expect(phone.getByLabel('所属部门', { exact: true })).toHaveValue(
      dept('procurement').id,
    )
    await phone
      .getByLabel('设置密码', { exact: true })
      .fill(mobileMember.password)
    await phone
      .getByLabel('确认密码', { exact: true })
      .fill(mobileMember.password + 'mismatch')
    await phone.getByRole('button', { name: '提交注册申请' }).click()
    await expect(phone.getByRole('alert')).toContainText('两次输入的密码不一致')
    await phone
      .getByLabel('确认密码', { exact: true })
      .fill(mobileMember.password)
    await phone.getByLabel('显示密码', { exact: true }).check()
    assert.equal(
      await phone.getByLabel('设置密码', { exact: true }).getAttribute('type'),
      'text',
    )
    assert.equal(
      await phone
        .getByLabel('部门类别', { exact: true })
        .evaluate((e) => getComputedStyle(e).fontSize),
      '16px',
    )
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    await phone.screenshot({
      path: 'runtime/test-evidence/registration-mobile.png',
      fullPage: true,
      mask: [
        phone.getByLabel('邮箱', { exact: true }),
        phone.getByLabel('设置密码', { exact: true }),
        phone.getByLabel('确认密码', { exact: true }),
      ],
    })
    await phone.getByRole('button', { name: '提交注册申请' }).click()
    await expect(
      phone.getByRole('heading', { name: '注册申请已提交' }),
    ).toBeVisible()
    await phone.getByRole('link', { name: '返回登录', exact: true }).click()
    await expect(phone.getByLabel('邮箱', { exact: true })).toHaveValue(
      mobileMember.email,
    )
    await expect(
      phone.getByLabel('记住邮箱', { exact: true }),
    ).not.toBeChecked()
    await phone.getByLabel('密码', { exact: true }).fill(mobileMember.password)
    await phone.getByRole('button', { name: '登录', exact: true }).click()
    await expect(phone.getByRole('alert')).toContainText('等待管理员确认部门')
    assert.equal(new URL(phone.url()).searchParams.get('redirect'), target)
    assert(
      !JSON.stringify(
        await phone.evaluate(() => ({
          local: { ...localStorage },
          session: { ...sessionStorage },
        })),
      ).includes(mobileMember.password),
    )
  })
  await test('administrator reviews in the existing account screen and the phone can then enter procurement', async () => {
    const context = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    await context.addCookies([
      {
        name: 'session',
        value: admin.token,
        url: site,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ])
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(site + '/npi')
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name: '系统设置', exact: true })
      .click()
    await page.getByLabel('查找账号', { exact: true }).fill(mobileMember.email)
    const row = page.locator('tbody tr')
    await expect(row).toContainText('待审核注册')
    await expect(row).toContainText('采购部')
    await row.getByRole('button', { name: '审核注册' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('开通部门', { exact: true })).toHaveValue(
      mobileMember.departmentId,
    )
    await page.screenshot({
      path: 'runtime/test-evidence/registration-admin.png',
      fullPage: true,
    })
    await dialog.getByRole('button', { name: '确认开通' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row).toContainText('已启用')
    await expect(
      page
        .getByRole('region', { name: '部门协作分组', exact: true })
        .locator('.npi-settings-row')
        .filter({ hasText: '采购部' }),
    ).toContainText('手机采购注册')
    await phone.getByRole('button', { name: '登录', exact: true }).click()
    await expect(
      phone.getByRole('heading', { name: '采购管理', exact: true }),
    ).toBeVisible()
    assert.equal(new URL(phone.url()).searchParams.get('view'), 'procurement')
    assert.equal(
      await phone.evaluate(() => localStorage.getItem('npi-login-email')),
      null,
    )
    assert.deepEqual(errors, [])
  })
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  if (log !== undefined) closeSync(log)
  await closeDatabase()
}
