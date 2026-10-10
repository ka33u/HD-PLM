// SPDX-License-Identifier: AGPL-3.0-or-later
// Issue #1: real API and browser against a fresh _test database.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq, sql } from 'drizzle-orm'
import { chromium, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_quick_reply')
process.env.ATTACHMENT_ROOT = mkdtempSync(join(tmpdir(), 'hd-issue-files-'))
const root = 'http://localhost:3492'
process.env.BASE_URL = root
const { db, closeDatabase } = await import('../src/lib/db')
const { users } = await import('../src/lib/db/schema/users')
const s = await import('../src/lib/db/schema/npi')
const { createSession } = await import('../src/lib/auth/session')
const { app } = await import('../src/server/app')
const { seedNpiConfig } = await import('../src/lib/npi/service')
await migrate(db, { migrationsFolder: 'migrations' })
await seedNpiConfig()
const actors: Record<string, { id: string; token: string }> = {}
for (const role of [
  'technical',
  'manufacturing',
  'procurement',
  'supervisor',
  'admin',
  'otherTech',
  'outsideBuyer',
  'sharedMfg',
  'sharedBuyer',
]) {
  const [u] = await db
    .insert(users)
    .values({
      email: crypto.randomUUID() + '@issue.test.invalid',
      name: '验证-' + role,
      mustChangePassword: false,
    })
    .returning()
  await db.insert(s.npiUserRoles).values({
    userId: u!.id,
    role:
      role === 'otherTech'
        ? 'technical'
        : role === 'sharedMfg'
          ? 'manufacturing'
          : role === 'sharedBuyer' || role === 'outsideBuyer'
            ? 'procurement'
            : (role as 'technical'),
  })
  actors[role] = { id: u!.id, token: (await createSession(u!.id)).sessionToken }
}
async function call(
  role: string,
  path: string,
  method = 'GET',
  data?: unknown,
  status = 200,
): Promise<any> {
  const a = actors[role]!,
    form = data instanceof FormData
  const response = await app.request(root + '/api/v1/npi' + path, {
    method,
    headers: {
      cookie: 'session=' + a.token,
      origin: root,
      'x-npi-actor': a.id,
      ...(form ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : form ? data : JSON.stringify(data),
  })
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}
let projectId = ''
const getItems = async (role = 'manufacturing', kind = 'manufacturing') =>
  (await call(role, '/workbench/quick-replies?kind=' + kind)).items as any[]
const payload = (
  items: any[],
  date = '2026-11-02',
  operation = 'promise',
  reason = '',
) => ({
  operation,
  reason,
  items: items.map((r) => ({ id: r.id, expectedVersion: r.version, date })),
})
const savedItems = async () =>
  (await call('technical', `/projects/${projectId}`)).items as any[]
async function setup() {
  projectId = (
    await call(
      'technical',
      '/projects',
      'POST',
      {
        code: 'QR-001',
        name: '高效电机',
        motorModel: 'YE5-250M-4 55kW B3',
        technicalOwnerId: actors.technical!.id,
        manufacturingOwnerId: actors.manufacturing!.id,
        requiredKitDate: '2026-11-20',
        prototypeRequiredDate: '2026-11-28',
      },
      201,
    )
  ).id
  for (const [role, peer, name] of [
    ['manufacturing', 'sharedMfg', '生产一组'],
    ['procurement', 'sharedBuyer', '采购一组'],
  ])
    await call('admin', '/departments', 'POST', {
      name,
      role,
      memberIds: [actors[role!]!.id, actors[peer!]!.id],
      expectedVersion: 0,
      reason: '验证同组部件回复',
    })
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet('母件结构表-多阶')
  sheet.getCell('A4').value = 'MOTOR-001'
  sheet.getCell('B4').value = '高效电机'
  sheet.getCell('C4').value = 'YE5-250M-4 55kW B3'
  sheet.getRow(5).values = [
    '级别',
    '子件行号',
    '子件编码',
    '子件名称',
    '子件规格',
    '基本用量',
    '子件计量单位',
    '供应类型',
    '领料部门名称',
  ]
  for (let i = 0; i < 40; i++)
    sheet.getRow(i + 6).values = [
      '+',
      (i + 1) * 10,
      i < 30 ? 'M-DUP' : 'P-DUP',
      (i < 30 ? '机壳部件' : '轴承部件') + (i + 1),
      '规格-' + i,
      1,
      '只',
      i < 30 ? '领用' : '外购',
      i < 30 ? '金工' : '采购',
    ]
  const form = new FormData()
  form.set(
    'file',
    new File([new Uint8Array(await workbook.xlsx.writeBuffer())], 'parts.xlsx'),
  )
  const preview = await call(
    'technical',
    `/projects/${projectId}/bom/import-preview`,
    'POST',
    form,
  )
  await call(
    'technical',
    `/projects/${projectId}/bom/import`,
    'POST',
    { previewToken: preview.previewToken, activate: true },
    201,
  )
  const rows = (await call('technical', `/projects/${projectId}/bom/tree`)).rows
  for (let i = 0; i < rows.length; i++)
    await call('technical', `/bom-items/${rows[i].id}/tracking`, 'PATCH', {
      ownerId: actors[i < 30 ? 'manufacturing' : 'procurement']!.id,
      requiredDate: i % 2 ? '2026-11-09' : '2026-11-08',
      trackingEnabled: true,
      affectsKit: true,
      expectedVersion: 0,
    })
}
try {
  await setup()
  await test('Quick list scopes personal/department work without granting full project access', async () => {
    assert.equal((await getItems()).length, 30)
    assert.equal((await getItems('sharedMfg')).length, 30)
    assert.equal((await getItems('procurement', 'procurement')).length, 10)
    assert.equal((await getItems('sharedBuyer', 'procurement')).length, 10)
    assert.equal((await getItems('outsideBuyer', 'procurement')).length, 0)
    assert.equal((await getItems('admin')).length, 30)
    assert.equal(
      (
        await call(
          'manufacturing',
          '/workbench/quick-replies?kind=manufacturing&projectId=' +
            crypto.randomUUID(),
        )
      ).items.length,
      0,
    )
    for (const [role, kind] of [
      ['supervisor', 'manufacturing'],
      ['procurement', 'manufacturing'],
      ['manufacturing', 'procurement'],
    ])
      await call(
        role!,
        '/workbench/quick-replies?kind=' + kind,
        'GET',
        undefined,
        403,
      )
    await call('sharedBuyer', `/projects/${projectId}`, 'GET', undefined, 403)
    await call(
      'sharedBuyer',
      `/projects/${projectId}/bom/tree`,
      'GET',
      undefined,
      403,
    )
  })
  await test('Batch validation and permissions roll back every row; first commitments and actual actor survive rescheduling', async () => {
    const m = await getItems(),
      p = await getItems('procurement', 'procurement')
    for (const data of [
      payload([]),
      payload([m[0], m[0]]),
      payload(Array(51).fill(m[0])),
      { operation: 'bad', items: [m[0]] },
      { operation: 'promise', items: [null] },
      payload([m[0]], '2026-02-30'),
    ])
      await call('manufacturing', '/tracking/batch-reply', 'POST', data, 422)
    for (const role of ['supervisor', 'outsideBuyer'])
      await call(role, '/tracking/batch-reply', 'POST', payload([p[0]]), 403)
    await call(
      'manufacturing',
      '/tracking/batch-reply',
      'POST',
      payload([m[0], p[0]]),
      403,
    )
    assert.equal((await getItems())[0].currentCommittedDate, null)
    const result = await call(
      'sharedMfg',
      '/tracking/batch-reply',
      'POST',
      payload(m.slice(0, 2)),
    )
    assert.equal(result.items.length, 2)
    let history = await db
      .select()
      .from(s.npiPromiseHistory)
      .where(eq(s.npiPromiseHistory.objectId, m[0].id))
    assert.equal(history[0]!.changedBy, actors.sharedMfg!.id)
    let updated = (await getItems()).filter((r) =>
      m.slice(0, 2).some((v) => v.id === r.id),
    )
    await call(
      'manufacturing',
      '/tracking/batch-reply',
      'POST',
      payload(updated, '2026-11-03'),
      400,
    )
    await call(
      'manufacturing',
      '/tracking/batch-reply',
      'POST',
      payload(updated, '2026-11-03', 'promise', '工序调整'),
    )
    updated = (await getItems()).filter((r) =>
      updated.some((v) => v.id === r.id),
    )
    assert.ok(
      updated.every(
        (r) =>
          r.firstCommittedDate === '2026-11-02' &&
          r.currentCommittedDate === '2026-11-03',
      ),
    )
    assert.ok(updated.every((r) => r.ownerId === actors.manufacturing!.id))
    await call(
      'sharedBuyer',
      '/tracking/batch-reply',
      'POST',
      payload(p.slice(0, 2)),
    )
    const buyerHistory = await db
      .select()
      .from(s.npiPromiseHistory)
      .where(eq(s.npiPromiseHistory.objectId, p[0].id))
    assert.equal(buyerHistory[0]!.changedBy, actors.sharedBuyer!.id)
    assert.equal(
      (await getItems('admin', 'procurement')).find((r) => r.id === p[0].id)
        .changeCount,
      0,
    )
  })
  await test('Stale versions, concurrent writers, failed auditing and stale BOM cannot partially save', async () => {
    let m = (await getItems())
      .filter((r) => !r.currentCommittedDate)
      .slice(0, 2)
    await call(
      'manufacturing',
      '/tracking/batch-reply',
      'POST',
      payload([m[0], { ...m[1], version: 0 }]),
      409,
    )
    assert.equal(
      (await getItems()).find((r) => r.id === m[0].id).currentCommittedDate,
      null,
    )
    await db.execute(
      sql`create function test_quick_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'PROMISE_CHANGED' then raise exception 'Test rollback'; end if; return NEW; end; $$`,
    )
    await db.execute(
      sql`create trigger test_quick_audit before insert on npi_events for each row execute function test_quick_audit_failure()`,
    )
    try {
      await call(
        'manufacturing',
        '/tracking/batch-reply',
        'POST',
        payload(m),
        500,
      )
    } finally {
      await db.execute(sql`drop trigger test_quick_audit on npi_events`)
      await db.execute(sql`drop function test_quick_audit_failure()`)
    }
    assert.equal(
      (await getItems()).find((r) => r.id === m[0].id).currentCommittedDate,
      null,
    )
    const results = await Promise.allSettled([
      call('sharedMfg', '/tracking/batch-reply', 'POST', payload(m)),
      call('manufacturing', '/tracking/batch-reply', 'POST', payload(m)),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.match(
      String(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
          .reason,
      ),
      /409|VERSION_CONFLICT/,
    )
    const current = (await call('technical', `/projects/${projectId}`))
      .activeBomImportId
    m = (await getItems()).filter((r) => !r.currentCommittedDate).slice(0, 2)
    await db
      .update(s.npiProjects)
      .set({ activeBomImportId: null })
      .where(eq(s.npiProjects.programId, projectId))
    try {
      assert.ok(
        (await getItems()).every((r) => r.bomReference.current === false),
      )
      await call(
        'manufacturing',
        '/tracking/batch-reply',
        'POST',
        payload(m),
        409,
      )
    } finally {
      await db
        .update(s.npiProjects)
        .set({ activeBomImportId: current })
        .where(eq(s.npiProjects.programId, projectId))
    }
  })
  await test('Actual completion is separate, cannot be futuredated or repeated, and preserves promises', async () => {
    const m = (await getItems())
      .filter((r) => r.currentCommittedDate)
      .slice(0, 2)
    await call(
      'sharedMfg',
      '/tracking/batch-reply',
      'POST',
      payload(m, '2099-12-31', 'complete'),
      422,
    )
    assert.ok((await getItems()).some((r) => r.id === m[0].id))
    const result = await call(
      'sharedMfg',
      '/tracking/batch-reply',
      'POST',
      payload(m, '2026-01-02', 'complete'),
    )
    assert.ok(
      result.items.every(
        (r: any) =>
          r.actualCompleteDate === '2026-01-02' &&
          r.firstCommittedDate ===
            m.find((v) => v.id === r.id).firstCommittedDate,
      ),
    )
    await call(
      'sharedMfg',
      '/tracking/batch-reply',
      'POST',
      payload(result.items, '2026-01-02', 'complete'),
      409,
    )
    const rest = (await getItems())[0]
    const node = (await savedItems()).find(
      (r) => r.sourceType === 'MANUFACTURING',
    )
    await call(
      'manufacturing',
      '/tracking/batch-reply',
      'POST',
      payload([node]),
      422,
    )
    await db
      .update(s.npiTrackingItems)
      .set({ trackingEnabled: false, affectsKit: false })
      .where(eq(s.npiTrackingItems.id, rest.id))
    try {
      await call(
        'manufacturing',
        '/tracking/batch-reply',
        'POST',
        payload([rest]),
        400,
      )
    } finally {
      await db
        .update(s.npiTrackingItems)
        .set({ trackingEnabled: true, affectsKit: true })
        .where(eq(s.npiTrackingItems.id, rest.id))
    }
    await db
      .update(s.npiProjects)
      .set({ deletedAt: new Date() })
      .where(eq(s.npiProjects.programId, projectId))
    try {
      assert.equal((await getItems()).length, 0)
      await call(
        'manufacturing',
        '/tracking/batch-reply',
        'POST',
        payload([rest]),
        404,
      )
    } finally {
      await db
        .update(s.npiProjects)
        .set({ deletedAt: null })
        .where(eq(s.npiProjects.programId, projectId))
    }
  })
  await test('Browser: inline/Enter/paste, batch dates, hidden drafts, conflict recovery, unknown result and mobile actual completion', async () => {
    mkdirSync('runtime/test-evidence', { recursive: true })
    const log = openSync('runtime/test-evidence/quick-reply-server.log', 'w')
    const server = spawn(process.execPath, ['dist/server.mjs'], {
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: '3492', HOST: '127.0.0.1' },
    })
    const browserServer = await chromium.launchServer({
      headless: true,
      ...(process.env.CI ? {} : { channel: 'chrome' }),
    })
    const browser = await chromium.connect(browserServer.wsEndpoint()),
      errors: string[] = []
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
        viewport: { width: 1440, height: 1000 },
      })
      await context.addCookies([
        { name: 'session', value: actors.sharedMfg!.token, url: root },
      ])
      const page = await context.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(root + '/npi?view=manufacturing')
      await page
        .getByRole('button', { name: '部件快速回复', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      const rowDates = dialog.locator('tbody input[type=date]')
      await expect(rowDates).toHaveCount(25)
      const ids = await dialog
        .locator('tbody tr')
        .evaluateAll((rows) =>
          rows.map((r) => r.getAttribute('data-quick-item')!),
        )
      await rowDates.nth(0).fill('2026-11-01')
      await rowDates.nth(0).press('Enter')
      await expect(rowDates.nth(1)).toBeFocused()
      await rowDates.nth(1).evaluate((el) => {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text', '2026/11/2\n2026.11.3')
        el.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      await expect(rowDates.nth(1)).toHaveValue('2026-11-02')
      await expect(rowDates.nth(2)).toHaveValue('2026-11-03')
      await rowDates.nth(3).evaluate((el) => {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text', 'invalid\n2026/11/4')
        el.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      await expect(rowDates.nth(3)).toHaveValue('')
      await dialog.getByLabel('搜索快速回复部件').fill('没有该部件')
      await expect(dialog.locator('.npi-quick-savebar')).toContainText(
        '3 项在当前筛选外',
      )
      await dialog.getByLabel('搜索快速回复部件').fill('')
      await dialog
        .getByRole('button', { name: '提交 3 项回复', exact: true })
        .click()
      await expect(dialog.locator('.npi-message[role=status]')).toContainText(
        '已回复 3 个部件',
      )
      const persisted = await getItems()
      for (let i = 0; i < 3; i++)
        assert.equal(
          persisted.find((r) => r.id === ids[i]).currentCommittedDate,
          `2026-11-0${i + 1}`,
        )
      // page-wide Enter navigation must not reset while editing a date.
      await dialog.getByLabel('快速回复状态').selectOption('all')
      await rowDates.nth(24).fill('2026-11-10')
      await rowDates.nth(24).press('Enter')
      await expect(
        dialog.getByRole('navigation', { name: '快速回复分页', exact: true }),
      ).toContainText('第2/')
      await expect(rowDates.first()).toBeFocused()
      await rowDates.first().fill('2026-11-11')
      await expect(
        dialog.getByRole('navigation', { name: '快速回复分页', exact: true }),
      ).toContainText('第2/')
      await dialog.getByLabel('统一改期原因').fill('产能确认后统一回复')
      await page.keyboard.press('Control+Enter')
      await expect(dialog.locator('.npi-message[role=status]')).toContainText(
        '已回复 2 个部件',
      )
      await dialog.getByLabel('快速回复状态').selectOption('pending')
      await dialog.getByLabel('本页可回复', { exact: true }).check()
      await dialog
        .getByRole('button', { name: '按各自要求日期', exact: true })
        .click()
      await expect(
        dialog.getByRole('button', { name: /提交 \d+ 项回复/ }),
      ).toBeEnabled()
      await dialog.getByRole('button', { name: /提交 \d+ 项回复/ }).click()
      await expect(rowDates).toHaveCount(0)
      await dialog.getByLabel('快速回复状态').selectOption('all')
      const id = await dialog
        .locator('tbody tr')
        .first()
        .getAttribute('data-quick-item')
      const before = (await getItems()).find((r) => r.id === id)
      await rowDates.first().fill('2026-11-15')
      await expect(
        dialog.getByRole('button', { name: '提交 1 项回复', exact: true }),
      ).toBeDisabled()
      await dialog.getByLabel('统一改期原因').fill('现场复核')
      await call(
        'manufacturing',
        '/tracking/batch-reply',
        'POST',
        payload([before], '2026-11-14', 'promise', '他人同时更新'),
      )
      await dialog
        .getByRole('button', { name: '提交 1 项回复', exact: true })
        .click()
      await expect(dialog.getByRole('alert')).toContainText('填写内容已保留')
      await dialog
        .getByRole('button', { name: '重新读取', exact: true })
        .click()
      await expect(dialog.locator('.npi-quick-conflicts')).toContainText(
        '2026-11-15',
      )
      await expect(rowDates.first()).toHaveValue('2026-11-15')
      await dialog
        .getByRole('button', { name: '已核对，保留我的日期', exact: true })
        .click()
      await dialog
        .getByRole('button', { name: '提交 1 项回复', exact: true })
        .click()
      await expect(
        dialog.locator('.npi-message[role=status]').first(),
      ).toContainText('已回复 1 个部件')
      // The server saved, but the connection lost the response: reread must not create a second history entry.
      await rowDates.first().fill('2026-11-16')
      await dialog.getByLabel('统一改期原因').fill('运输确认')
      await page.route(
        '**/api/v1/npi/tracking/batch-reply',
        async (route) => {
          await route.fetch()
          await route.abort('failed')
        },
        { times: 1 },
      )
      await dialog
        .getByRole('button', { name: '提交 1 项回复', exact: true })
        .click()
      await expect(dialog.getByRole('alert')).toContainText('填写内容已保留')
      await dialog
        .getByRole('button', { name: '重新读取', exact: true })
        .click()
      await expect(dialog.locator('.npi-quick-savebar')).toContainText(
        '本次 0 项待提交',
      )
      await dialog
        .getByRole('button', { name: '实际完成', exact: true })
        .click()
      await expect(dialog.locator('.npi-quick-savebar')).toContainText(
        '本次 0 项待提交',
      )
      await expect(rowDates.first()).toHaveValue('')
      await dialog
        .getByRole('button', { name: '预计完成日期', exact: true })
        .click()
      await dialog.getByLabel('快速回复状态').selectOption('all')
      await page.screenshot({
        path: 'runtime/test-evidence/quick-reply-desktop.png',
        fullPage: true,
      })
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await context.close()
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
      })
      await mobile.addCookies([
        { name: 'session', value: actors.sharedBuyer!.token, url: root },
      ])
      const phone = await mobile.newPage()
      phone.on('pageerror', (e) => errors.push(e.message))
      await phone.goto(root + '/npi')
      await phone
        .getByRole('button', { name: '部件快速回复', exact: true })
        .click()
      const d = phone.getByRole('dialog'),
        picks = d.locator('tbody input[type=checkbox]')
      await expect(d.locator('tbody tr')).toHaveCount(8)
      await picks.nth(0).check()
      await picks.nth(1).check()
      await d.getByLabel('统一填写日期').fill('2026-11-06')
      await d.getByRole('button', { name: '统一填入', exact: true }).click()
      await phone.screenshot({
        path: 'runtime/test-evidence/quick-reply-mobile.png',
        fullPage: false,
      })
      assert.ok(await d.evaluate((el) => el.scrollWidth <= el.clientWidth))
      const button = await d
        .getByRole('button', { name: '提交 2 项回复', exact: true })
        .boundingBox()
      assert.ok(button && button.y + button.height <= 844)
      await d.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(d.getByRole('alert')).toContainText('还有 2 项填写未提交')
      await d.getByRole('button', { name: '继续填写', exact: true }).click()
      await d
        .getByRole('button', { name: '提交 2 项回复', exact: true })
        .click()
      await expect(d.getByRole('status')).toContainText('已回复 2 个部件')
      await d.getByRole('button', { name: '实际到货', exact: true }).click()
      const actualId = await d
        .locator('tbody tr')
        .first()
        .getAttribute('data-quick-item')
      await d.locator('tbody input[type=date]').first().fill('2026-01-02')
      await d
        .getByRole('button', { name: '确认 1 项已实际完成', exact: true })
        .click()
      await expect(d.getByRole('status')).toContainText(
        '已确认实际完成 1 个部件',
      )
      assert.equal(
        (await savedItems()).find((r) => r.id === actualId).actualCompleteDate,
        '2026-01-02',
      )
      await d.getByRole('button', { name: '关闭', exact: true }).click()
      await phone
        .getByRole('button', { name: '改期', exact: true })
        .first()
        .click()
      await phone
        .getByRole('button', { name: '读取最新记录', exact: true })
        .click()
      await expect(phone.getByRole('dialog').getByRole('status')).toContainText(
        '当前记录未变化',
      )
      await mobile.close()
      const limited = await browser.newContext()
      await limited.addCookies([
        { name: 'session', value: actors.supervisor!.token, url: root },
      ])
      const sp = await limited.newPage()
      await sp.goto(root + '/npi?view=manufacturing')
      await expect(
        sp.getByRole('heading', { name: '制造准备', exact: true }),
      ).toBeVisible()
      await expect(
        sp.getByRole('button', { name: '部件快速回复', exact: true }),
      ).toHaveCount(0)
      await limited.close()
      const admin = await browser.newContext()
      await admin.addCookies([
        { name: 'session', value: actors.admin!.token, url: root },
      ])
      const ap = await admin.newPage()
      await ap.goto(root + '/npi?view=bom')
      await ap.getByRole('button', { name: '进入BOM ↗', exact: true }).click()
      await ap
        .getByRole('button', { name: '生产部件快速回复', exact: true })
        .click()
      await expect(ap.getByRole('dialog').locator('tbody tr')).toHaveCount(0)
      await ap
        .getByRole('dialog')
        .getByLabel('快速回复状态')
        .selectOption('all')
      await expect(ap.getByRole('dialog').locator('tbody tr')).toHaveCount(25)
      await ap
        .getByRole('dialog')
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await ap
        .getByRole('button', { name: '采购部件快速回复', exact: true })
        .click()
      await expect(ap.getByRole('dialog').getByRole('heading')).toHaveText(
        '采购部件快速回复',
      )
      await admin.close()

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
