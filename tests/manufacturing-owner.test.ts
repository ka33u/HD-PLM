import test from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { deliveryFixture } from './helpers/delivery-fixture'
import { isManufacturingOwner } from '../src/lib/npi/manufacturing-owner'

const f = await deliveryFixture('hd_manufacturing_owner')
const { users } = await import('../src/lib/db/schema/users')
const { projects } = await import('../src/lib/db/schema/projects')
const [wrongDepartment] = await f.db
  .insert(f.s.npiDepartments)
  .values({ name: '采购验证部门', role: 'procurement' })
  .returning()
const original = await f.db
  .select()
  .from(f.s.npiUserRoles)
  .where(eq(f.s.npiUserRoles.userId, f.actors.manufacturing!.id))
const departmentId = original[0]!.departmentId!
const bad: Array<{ id: string; status: number }> = []
for (const [key, active, department] of [
  ['noDepartment', true, null],
  ['wrongDepartment', true, wrongDepartment!.id],
  ['inactive', false, departmentId],
] as const) {
  const [u] = await f.db
    .insert(users)
    .values({
      name: key,
      email: crypto.randomUUID() + '@owner.test.invalid',
      active,
      mustChangePassword: false,
    })
    .returning()
  await f.db
    .insert(f.s.npiUserRoles)
    .values({ userId: u!.id, role: 'manufacturing', departmentId: department })
  bad.push({ id: u!.id, status: active ? 422 : 403 })
}
for (const role of [
  'admin',
  'technical',
  'procurement',
  'quality',
  'supervisor',
])
  bad.push({ id: f.actors[role]!.id, status: 422 })
// A corrupt legacy admin/department combination must never make an administrator eligible.
await f.db
  .update(f.s.npiUserRoles)
  .set({ departmentId })
  .where(eq(f.s.npiUserRoles.userId, f.actors.admin!.id))
const fields = {
  motorType: '三相异步电动机',
  motorModel: '制造职责验证',
  orderQuantity: '1',
  technicalOwnerId: f.actors.technical!.id,
  manufacturingOwnerId: f.actors.manufacturing!.id,
  requiredKitDate: '2026-12-10',
  prototypeRequiredDate: '2026-12-12',
}
const state = async () => ({
  programs: await f.db.select({ id: projects.id }).from(projects),
  plans: await f.db.select().from(f.s.npiProjects),
  tasks: await f.db.select().from(f.s.npiTrackingItems),
  events: await f.db.select({ id: f.s.npiEvents.id }).from(f.s.npiEvents),
})
let projectId = '',
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  server: ReturnType<typeof spawn> | undefined
try {
  await test('only active manufacturing members of manufacturing departments may own projects, including when an admin submits', async () => {
    const before = await state()
    for (const actor of ['admin', 'technical'])
      for (const person of bad) {
        const result = await f.call(
          actor,
          '/projects',
          'POST',
          { ...fields, manufacturingOwnerId: person.id },
          person.status,
        )
        if (person.status === 422)
          assert.match(result.error, /制造类部门.*管理员不可担任/)
      }
    assert.deepEqual(await state(), before)
    const meta = await f.call('admin', '/meta')
    assert.deepEqual(
      meta.users
        .filter(isManufacturingOwner)
        .map((u: any) => u.id)
        .sort(),
      ['manufacturing', 'peer', 'nextMfg']
        .map((key) => f.actors[key]!.id)
        .sort(),
    )
    projectId = (await f.call('admin', '/projects', 'POST', fields, 201)).id
    assert.equal(
      (await f.detail(projectId)).manufacturingOwnerId,
      fields.manufacturingOwnerId,
    )
  })
  await test('edit and inheritance reject invalid owners at preview and commit without changing existing data', async () => {
    const before = await state(),
      d = await f.detail(projectId)
    for (const person of bad) {
      const proposal = {
        ...fields,
        manufacturingOwnerId: person.id,
        expectedVersion: d.version,
        reason: '验证不合法交接',
        copyBom: false,
        copyExternal: false,
        code: 'REJECT-' + crypto.randomUUID().slice(0, 8),
        expectedSnapshot: 'forged',
      }
      for (const [route, method] of [
        ['change-preview', 'POST'],
        ['plan', 'PATCH'],
        ['inheritance-preview', 'POST'],
        ['inherit', 'POST'],
      ])
        await f.call(
          'admin',
          `/projects/${projectId}/${route}`,
          method,
          proposal,
          person.status,
        )
    }
    assert.deepEqual(await state(), before)
  })
  await test('both commit paths recheck membership after preview and valid handover retains task history', async () => {
    const d = await f.detail(projectId)
    const proposal = {
      ...fields,
      manufacturingOwnerId: f.actors.nextMfg!.id,
      expectedVersion: d.version,
      reason: '制造交接',
      copyBom: false,
      copyExternal: false,
      code: 'INHERIT-' + crypto.randomUUID().slice(0, 8),
    }
    const change = await f.call(
      'admin',
      `/projects/${projectId}/change-preview`,
      'POST',
      proposal,
    )
    const inherit = await f.call(
      'admin',
      `/projects/${projectId}/inheritance-preview`,
      'POST',
      proposal,
    )
    const [mapping] = await f.db
      .select()
      .from(f.s.npiUserRoles)
      .where(eq(f.s.npiUserRoles.userId, f.actors.nextMfg!.id))
    await f.db
      .update(f.s.npiUserRoles)
      .set({ departmentId: null })
      .where(eq(f.s.npiUserRoles.userId, f.actors.nextMfg!.id))
    const before = await state()
    await f.call(
      'admin',
      `/projects/${projectId}/plan`,
      'PATCH',
      { ...proposal, expectedSnapshot: change.expectedSnapshot },
      422,
    )
    await f.call(
      'admin',
      `/projects/${projectId}/inherit`,
      'POST',
      { ...proposal, expectedSnapshot: inherit.expectedSnapshot },
      422,
    )
    assert.deepEqual(await state(), before)
    await f.db
      .update(f.s.npiUserRoles)
      .set({ departmentId: mapping!.departmentId })
      .where(eq(f.s.npiUserRoles.userId, f.actors.nextMfg!.id))
    await f.call('admin', `/projects/${projectId}/plan`, 'PATCH', {
      ...proposal,
      expectedSnapshot: change.expectedSnapshot,
    })
    const after = await f.detail(projectId)
    assert.equal(after.manufacturingOwnerId, f.actors.nextMfg!.id)
    assert.equal(
      after.items.find((i: any) => i.sourceType === 'WHOLE_MACHINE').id,
      d.items.find((i: any) => i.sourceType === 'WHOLE_MACHINE').id,
    )
    const newProposal = { ...proposal, code: proposal.code + '-NEW' }
    const newPreview = await f.call(
      'admin',
      `/projects/${projectId}/inheritance-preview`,
      'POST',
      newProposal,
    )
    const created = await f.call(
      'admin',
      `/projects/${projectId}/inherit`,
      'POST',
      { ...newProposal, expectedSnapshot: newPreview.expectedSnapshot },
      201,
    )
    assert.equal(
      (await f.detail(created.id)).manufacturingOwnerId,
      f.actors.nextMfg!.id,
    )
  })
  await test('create, edit and inherit dropdowns exclude admins and legacy invalid owners and require an explicit replacement', async () => {
    // Simulate an existing project that predates the restriction; never rewrite historical audit entries.
    await f.db
      .update(f.s.npiProjects)
      .set({ manufacturingOwnerId: f.actors.admin!.id })
      .where(eq(f.s.npiProjects.programId, projectId))
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const address = probe.address()
    assert(address && typeof address !== 'string')
    const root = `http://127.0.0.1:${address.port}`
    await new Promise<void>((r) => probe.close(() => r()))
    server = spawn(process.execPath, ['dist/server.mjs'], {
      env: {
        ...process.env,
        BASE_URL: root,
        HOST: '127.0.0.1',
        PORT: String(address.port),
      },
      stdio: 'ignore',
    })
    let ready = false
    for (let n = 0; n < 60; n++) {
      if (
        await fetch(root + '/api/health')
          .then((r) => r.ok)
          .catch(() => false)
      ) {
        ready = true
        break
      }
      await delay(100)
    }
    assert(ready)
    browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    await ctx.addCookies([
      { name: 'session', value: f.actors.admin!.token, url: root },
    ])
    const page = await ctx.newPage()
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const verify = async () => {
      const select = page
        .getByRole('dialog')
        .getByLabel('制造负责人', { exact: true })
      await expect(select).toBeVisible()
      const ids = await select
        .locator('option')
        .evaluateAll((options) =>
          options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
        )
      assert.deepEqual(
        ids.sort(),
        ['manufacturing', 'peer', 'nextMfg']
          .map((key) => f.actors[key]!.id)
          .sort(),
      )
      return select
    }
    await page.goto(root + '/npi?view=projects')
    await page.getByRole('button', { name: '新建新品', exact: true }).click()
    await verify()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await page.goto(
      root + `/npi?view=projects&project=${projectId}&tab=overview`,
    )
    await page
      .getByRole('button', { name: '编辑项目信息', exact: true })
      .click()
    await expect(await verify()).toHaveValue('')
    await expect(
      page
        .getByRole('dialog')
        .getByText('原制造负责人不符合当前要求，请重新选择；历史记录保留。', {
          exact: true,
        }),
    ).toBeVisible()
    mkdirSync('runtime/owner-qa', { recursive: true })
    await page.screenshot({ path: 'runtime/owner-qa/legacy-owner.png' })
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await page
      .getByRole('button', { name: '以此项目新建', exact: true })
      .click()
    await expect(await verify()).toHaveValue('')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await page
      .getByRole('button', { name: '编辑项目信息', exact: true })
      .click()
    await (await verify()).selectOption(f.actors.manufacturing!.id)
    await page
      .getByRole('dialog')
      .getByLabel('变更原因', { exact: true })
      .fill('纠正历史制造负责人')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '预览变更', exact: true })
      .click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '确认变更', exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.equal(
      (await f.detail(projectId)).manufacturingOwnerId,
      f.actors.manufacturing!.id,
    )
    // When nobody qualifies, do not silently fall back to the administrator.
    await f.db.execute(
      sql`update npi_user_roles set department_id=null where role='manufacturing'`,
    )
    await page.goto(root + '/npi?view=projects')
    await page.getByRole('button', { name: '新建新品', exact: true }).click()
    const empty = page
      .getByRole('dialog')
      .getByLabel('制造负责人', { exact: true })
    assert.equal(
      (
        await empty
          .locator('option')
          .evaluateAll((options) =>
            options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
          )
      ).length,
      0,
    )
    await expect(page.getByRole('dialog')).toContainText('当前无可选人员')
    assert.deepEqual(errors, [])
  })
} finally {
  await browser?.close()
  server?.kill()
  await f.closeDatabase()
}
