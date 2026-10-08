// SPDX-License-Identifier: AGPL-3.0-or-later
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { chromium, expect } from '@playwright/test'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_trash')
const root = 'http://localhost:3493'
process.env.BASE_URL = root
const { db, closeDatabase } = await import('../src/lib/db')
const { users } = await import('../src/lib/db/schema/users')
const s = await import('../src/lib/db/schema/npi')
const { app } = await import('../src/server/app')
const { createSession } = await import('../src/lib/auth/session')
const { seedNpiConfig } = await import('../src/lib/npi/service')
await migrate(db, { migrationsFolder: 'migrations' })
await seedNpiConfig()
const actors: Record<string, { id: string; token: string }> = {}
for (const role of [
  'admin',
  'technical',
  'otherTech',
  'manufacturing',
  'procurement',
  'supervisor',
]) {
  const [user] = await db
    .insert(users)
    .values({
      email: crypto.randomUUID() + '@trash.test.invalid',
      name: role === 'technical' ? '张工' : role === 'admin' ? '管理员' : role,
      mustChangePassword: false,
    })
    .returning()
  await db.insert(s.npiUserRoles).values({
    userId: user!.id,
    role: (role === 'otherTech' ? 'technical' : role) as 'technical',
  })
  actors[role] = {
    id: user!.id,
    token: (await createSession(user!.id)).sessionToken,
  }
}
async function call(
  role: string,
  path: string,
  method = 'GET',
  data?: unknown,
  status = 200,
): Promise<any> {
  const actor = actors[role]!
  const response = await app.request(root + '/api/v1/npi' + path, {
    method,
    headers: {
      cookie: 'session=' + actor.token,
      origin: root,
      'x-npi-actor': actor.id,
      'content-type': 'application/json',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  return body
}
async function create(code: string, owner = 'technical') {
  const project = await call(
    owner,
    '/projects',
    'POST',
    {
      code,
      name: '高效节能电机',
      motorModel: 'YE5-250M-4 55kW B3',
      customer: '恒达设备',
      technicalOwnerId: actors[owner]!.id,
      manufacturingOwnerId: actors.manufacturing!.id,
      requiredKitDate: '2026-11-20',
      prototypeRequiredDate: '2026-11-28',
    },
    201,
  )
  return project.id as string
}
async function trash(
  id: string,
  role = 'technical',
  reason = '客户调整计划，暂缓开发，保留设计资料待确认',
) {
  const project = await call(role, `/projects/${id}`)
  const result = await call(role, `/projects/${id}/trash`, 'POST', {
    action: 'delete',
    confirmCode: project.code,
    expectedVersion: project.version,
    reason,
  })
  return { id, expectedVersion: result.version }
}
let batch: Array<{ id: string; expectedVersion: number }> = []
try {
  await test('Trash details respect ownership and expose deletion metadata without granting active project access', async () => {
    for (const code of ['RB-A', 'RB-B'])
      batch.push(await trash(await create(code)))
    const other = await trash(
      await create('RB-OTHER', 'otherTech'),
      'otherTech',
    )
    const rows = await call('technical', '/project-trash')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].deletedByName, '张工')
    assert.equal(rows[0].technicalOwnerName, '张工')
    const detail = await call('technical', `/project-trash/${batch[0]!.id}`)
    assert.equal(detail.counts.trackingItems, 4)
    assert.deepEqual(
      [
        detail.counts.bomVersions,
        detail.counts.attachments,
        detail.counts.issues,
      ],
      [0, 0, 0],
    )
    assert.equal(detail.history[0].action, 'PROJECT_TRASHED')
    assert.equal(detail.history[0].reason, detail.project.reason)
    await call('technical', `/projects/${batch[0]!.id}`, 'GET', undefined, 404)
    await call('technical', `/project-trash/${other.id}`, 'GET', undefined, 404)
    assert.equal((await call('admin', '/project-trash')).length, 3)
    for (const role of ['manufacturing', 'procurement', 'supervisor']) {
      await call(role, '/project-trash', 'GET', undefined, 403)
      await call(role, `/project-trash/${batch[0]!.id}`, 'GET', undefined, 403)
      await call(
        role,
        '/project-trash/restore',
        'POST',
        { projects: batch, reason: '越权批量恢复' },
        403,
      )
    }
    await call(
      'technical',
      '/project-trash/restore',
      'POST',
      { projects: [batch[0], other], reason: '跨项目权限测试' },
      403,
    )
    assert.equal((await call('technical', '/project-trash')).length, 2)
  })
  await test('Bulk validation, stale versions and audit failures cannot partially restore a batch', async () => {
    for (const projects of [
      [],
      [batch[0], batch[0]],
      Array(51).fill(batch[0]),
      [null],
      [{ id: 'bad' }],
    ])
      await call(
        'technical',
        '/project-trash/restore',
        'POST',
        { projects, reason: '参数验证' },
        422,
      )
    await call(
      'technical',
      '/project-trash/restore',
      'POST',
      { projects: batch, reason: '   ' },
      422,
    )
    await call(
      'technical',
      '/project-trash/restore',
      'POST',
      {
        projects: [batch[0], { ...batch[1], expectedVersion: 0 }],
        reason: '版本冲突',
      },
      409,
    )
    const auditCount = async () =>
      (
        await db
          .select()
          .from(s.npiEvents)
          .where(eq(s.npiEvents.action, 'PROJECT_RESTORED'))
      ).length
    assert.equal(await auditCount(), 0)
    await db.execute(
      sql`create function test_trash_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'PROJECT_RESTORED' then raise exception 'Test rollback'; end if; return NEW; end; $$`,
    )
    await db.execute(
      sql`create trigger test_trash_audit before insert on npi_events for each row execute function test_trash_audit_failure()`,
    )
    try {
      await call(
        'technical',
        '/project-trash/restore',
        'POST',
        { projects: batch, reason: '审计失败回滚' },
        500,
      )
    } finally {
      await db.execute(sql`drop trigger test_trash_audit on npi_events`)
      await db.execute(sql`drop function test_trash_audit_failure()`)
    }
    assert.equal((await call('technical', '/project-trash')).length, 2)
    assert.equal(await auditCount(), 0)
  })
  await test('Concurrent bulk restoration has one winner and retains task identities and promise dates', async () => {
    const ids = batch.map((r) => r.id)
    const items = await db
      .select()
      .from(s.npiTrackingItems)
      .where(inArray(s.npiTrackingItems.programId, ids))
    await db
      .update(s.npiTrackingItems)
      .set({
        firstCommittedDate: '2026-11-15',
        currentCommittedDate: '2026-11-16',
      })
      .where(eq(s.npiTrackingItems.id, items[0]!.id))
    const before = await db
      .select()
      .from(s.npiTrackingItems)
      .where(inArray(s.npiTrackingItems.programId, ids))
    const request = () =>
      app.request(root + '/api/v1/npi/project-trash/restore', {
        method: 'POST',
        headers: {
          cookie: 'session=' + actors.technical!.token,
          origin: root,
          'x-npi-actor': actors.technical!.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ projects: batch, reason: '客户确认重新启动' }),
      })
    const results = await Promise.all([request(), request()])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    assert.deepEqual(
      await db
        .select()
        .from(s.npiTrackingItems)
        .where(inArray(s.npiTrackingItems.programId, ids)),
      before,
    )
    const events = await db
      .select()
      .from(s.npiEvents)
      .where(
        and(
          eq(s.npiEvents.action, 'PROJECT_RESTORED'),
          inArray(s.npiEvents.programId, ids),
        ),
      )
    assert.equal(events.length, 2)
    assert.ok(
      events.every(
        (e) =>
          e.actorId === actors.technical!.id &&
          (e.detail as any).reason === '客户确认重新启动',
      ),
    )
    await call('technical', `/project-trash/${ids[0]}`, 'GET', undefined, 404)
    batch = [await trash(ids[0]!), await trash(ids[1]!)]
    const detail = await call('technical', `/project-trash/${ids[0]}`)
    assert.equal(detail.history.length, 3)
    assert.equal(detail.history[1].action, 'PROJECT_RESTORED')
  })
  await test('Dedicated trash page supports navigation, filters, pagination, details and safe desktop/mobile restores', async () => {
    for (let i = 1; i <= 21; i++)
      await trash(await create(`RB-${String(i).padStart(3, '0')}`))
    const rows = await call('technical', '/project-trash')
    const old = rows.find((r: any) => r.code === 'RB-001')
    await db
      .update(s.npiProjects)
      .set({
        deletedAt: new Date('2026-09-01T01:00:00Z'),
        currentNpiStage: 'prototype',
      })
      .where(eq(s.npiProjects.programId, old.id))
    mkdirSync('runtime/test-evidence', { recursive: true })
    const log = openSync('runtime/test-evidence/trash-server.log', 'w')
    const server = spawn(process.execPath, ['dist/server.mjs'], {
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: '3493', HOST: '127.0.0.1' },
    })
    const browserServer = await chromium.launchServer({
      headless: true,
      ...(process.env.CI ? {} : { channel: 'chrome' }),
    })
    const browser = await chromium.connect(browserServer.wsEndpoint())
    const errors: string[] = []
    try {
      let ready = false
      for (let i = 0; i < 60; i++) {
        try {
          if ((await fetch(root + '/api/health')).ok) {
            ready = true
            break
          }
        } catch {}
        await delay(250)
      }
      assert.ok(ready)
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      })
      await context.addCookies([
        { name: 'session', value: actors.technical!.token, url: root },
      ])
      const page = await context.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(root + '/npi')
      await page
        .getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('button', { name: '项目回收站', exact: true })
        .click()
      await expect(page).toHaveURL(root + '/npi/trash')
      await page.reload()
      await expect(
        page.getByRole('heading', { name: '项目回收站', exact: true }),
      ).toBeVisible()
      const table = page.getByRole('table', { name: '已删除项目列表' })
      await expect(table.locator('tbody tr')).toHaveCount(20)
      await expect(
        page.getByRole('navigation', { name: '回收站分页', exact: true }),
      ).toContainText('共23行')
      await page.screenshot({
        path: 'runtime/test-evidence/trash-desktop.png',
        fullPage: true,
      })
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(table.locator('tbody tr')).toHaveCount(3)
      await page.getByLabel('搜索项目', { exact: true }).fill('RB-001')
      await expect(table.locator('tbody tr')).toHaveCount(1)
      await page.getByRole('button', { name: '查看详情', exact: true }).click()
      await expect(page.getByRole('dialog')).toContainText('张工')
      await expect(page.getByRole('dialog')).toContainText('2026/09/01 09:00')
      await expect(page.getByRole('dialog')).toContainText('保留的项目资料')
      await page.screenshot({ path: 'runtime/test-evidence/trash-detail.png' })
      await page.getByRole('button', { name: '关闭弹窗' }).click()
      await page.getByLabel('删除前阶段').selectOption('design')
      await expect(
        page.getByRole('heading', { name: '没有符合条件的项目' }),
      ).toBeVisible()
      await page
        .getByRole('button', { name: '清除筛选', exact: true })
        .first()
        .click()
      await page.getByLabel('删除日期至').fill('2026-09-01')
      await expect(table.locator('tbody tr')).toHaveCount(1)
      await page.getByLabel('删除日期从').fill('2026-10-01')
      await expect(page.getByRole('alert')).toContainText(
        '开始日期不能晚于结束日期',
      )
      await page
        .getByRole('button', { name: '清除筛选', exact: true })
        .first()
        .click()
      await page.getByLabel('搜索项目', { exact: true }).fill('RB-00')
      await expect(table.locator('tbody tr')).toHaveCount(9)
      await page.getByLabel('选择项目 RB-002', { exact: true }).check()
      await page.getByLabel('选择项目 RB-003', { exact: true }).check()
      await page
        .getByRole('button', { name: '恢复所选（2）', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: '确认恢复（2）' }),
      ).toBeDisabled()
      await page
        .getByLabel('恢复原因', { exact: true })
        .fill('例会确认两个项目继续开发')
      await page.getByRole('button', { name: '确认恢复（2）' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('status')).toContainText('已恢复 2 个项目')
      await expect(table.locator('tbody tr')).toHaveCount(7)
      await page
        .getByRole('button', { name: '返回新品项目', exact: true })
        .click()
      await expect(
        page.getByRole('heading', { name: '新品项目', exact: true }),
      ).toBeVisible()
      await page.goBack()
      await expect(
        page.getByRole('heading', { name: '项目回收站', exact: true }),
      ).toBeVisible()
      // A stale open restore dialog must show a conflict, not replay a successful restore.
      await page.getByLabel('搜索项目', { exact: true }).fill('RB-004')
      await page.getByRole('button', { name: '恢复', exact: true }).click()
      const stale = (await call('technical', '/project-trash')).find(
        (r: any) => r.code === 'RB-004',
      )
      await call('admin', '/project-trash/restore', 'POST', {
        projects: [{ id: stale.id, expectedVersion: stale.version }],
        reason: '管理员先恢复',
      })
      await page.getByLabel('恢复原因', { exact: true }).fill('旧页面恢复')
      await page.getByRole('button', { name: '确认恢复（1）' }).click()
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
        '记录已改变',
      )
      await page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: '没有符合条件的项目' }),
      ).toBeVisible()
      await context.close()
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
      })
      await mobile.addCookies([
        { name: 'session', value: actors.technical!.token, url: root },
      ])
      const phone = await mobile.newPage()
      phone.on('pageerror', (e) => errors.push(e.message))
      await phone.goto(root + '/npi/trash')
      await phone.getByLabel('搜索项目', { exact: true }).fill('RB-005')
      await expect(phone.getByRole('table').locator('tbody tr')).toHaveCount(1)
      assert.ok(
        await phone.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      )
      await phone.getByRole('button', { name: '选择本页', exact: true }).click()
      await expect(
        phone.getByRole('button', { name: '恢复所选（1）', exact: true }),
      ).toBeEnabled()
      await phone
        .getByRole('button', { name: '取消本页选择', exact: true })
        .click()
      await phone.screenshot({
        path: 'runtime/test-evidence/trash-mobile.png',
        fullPage: true,
      })
      await phone.getByRole('button', { name: '查看详情', exact: true }).click()
      await phone
        .getByRole('button', { name: '恢复此项目', exact: true })
        .click()
      await phone.getByLabel('恢复原因', { exact: true }).fill('移动端确认恢复')
      await phone.getByRole('button', { name: '确认恢复（1）' }).click()
      await expect(phone.getByRole('status')).toContainText('已恢复 1 个项目')
      await phone.getByRole('button', { name: '打开项目', exact: true }).click()
      await expect(
        phone.getByRole('heading', { name: /YE5-250M/ }),
      ).toBeVisible()
      await mobile.close()
      const limited = await browser.newContext()
      await limited.addCookies([
        { name: 'session', value: actors.supervisor!.token, url: root },
      ])
      const denied = await limited.newPage()
      await denied.goto(root + '/npi/trash')
      await expect(
        denied.getByRole('heading', { name: '新品驾驶舱', exact: true }),
      ).toBeVisible()
      await expect(
        denied
          .getByRole('navigation', { name: '主导航' })
          .getByRole('button', { name: '项目回收站' }),
      ).toHaveCount(0)
      await limited.close()
      const emptyContext = await browser.newContext()
      await emptyContext.addCookies([
        { name: 'session', value: actors.otherTech!.token, url: root },
      ])
      const emptyPage = await emptyContext.newPage()
      await emptyPage.route(
        '**/api/v1/npi/project-trash',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: '测试暂时不可用' }),
          }),
        { times: 1 },
      )
      await emptyPage.goto(root + '/npi/trash')
      await expect(
        emptyPage.getByRole('heading', { name: '暂时无法读取回收站' }),
      ).toBeVisible()
      await expect(
        emptyPage.getByRole('heading', { name: '回收站为空', exact: true }),
      ).toHaveCount(0)
      await emptyPage
        .getByRole('button', { name: '重新加载', exact: true })
        .click()
      await expect(
        emptyPage.getByRole('table').locator('tbody tr'),
      ).toHaveCount(1)
      await emptyPage.getByRole('button', { name: '恢复', exact: true }).click()
      await emptyPage
        .getByLabel('恢复原因', { exact: true })
        .fill('恢复最后一个项目')
      await emptyPage.getByRole('button', { name: '确认恢复（1）' }).click()
      await expect(
        emptyPage.getByRole('heading', { name: '回收站为空', exact: true }),
      ).toBeVisible()
      await emptyContext.close()
      assert.deepEqual(errors, [])
    } finally {
      await browser.close()
      await browserServer.close()
      server.kill()
      closeSync(log)
    }
  })
} finally {
  await closeDatabase()
}
