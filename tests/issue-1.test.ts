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
import { eq } from 'drizzle-orm'
import { chromium, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_issue_one')
process.env.ATTACHMENT_ROOT = mkdtempSync(join(tmpdir(), 'hd-issue-files-'))
const root = 'http://localhost:3494'
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
          : role === 'sharedBuyer'
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
let projectId = '',
  oldImport = '',
  originalRows: any[] = [],
  trackingId = ''
const projectName = '同名电机',
  model = 'XYT250M15P8-90 B3 完整型号测试'
const project = () => call('technical', `/projects/${projectId}`)
const tree = () => call('technical', `/projects/${projectId}/bom/tree`)
async function importWorkbook() {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet('母件结构表-多阶')
  sheet.getCell('A4').value = 'MOTOR-001'
  sheet.getCell('B4').value = '测试电机'
  sheet.getCell('C4').value = model
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
  sheet.getRow(6).values = [
    '+',
    10,
    'A',
    '机壳',
    '规格A',
    1,
    '只',
    '外购',
    '采购',
  ]
  sheet.getRow(7).values = [
    '++',
    10,
    'A-CHILD',
    '毛坯',
    '规格C',
    2,
    '只',
    '领用',
    '金工',
  ]
  sheet.getRow(8).values = [
    '+',
    20,
    'B',
    '轴承',
    '规格B',
    1,
    '只',
    '外购',
    '采购',
  ]
  const form = new FormData()
  form.set(
    'file',
    new File([new Uint8Array(await workbook.xlsx.writeBuffer())], 'bom.xlsx'),
  )
  const preview = await call(
    'technical',
    `/projects/${projectId}/bom/import-preview`,
    'POST',
    form,
  )
  return call(
    'technical',
    `/projects/${projectId}/bom/import`,
    'POST',
    { previewToken: preview.previewToken, activate: true },
    201,
  )
}
try {
  await test('Motor code and editable order code persist with audit and conflict protection', async () => {
    projectId = (
      await call(
        'technical',
        '/projects',
        'POST',
        {
          code: 'ORDER-001',
          name: projectName,
          motorModel: model,
          motorCode: 'MOTOR-CODE-001',
          technicalOwnerId: actors.technical!.id,
          manufacturingOwnerId: actors.manufacturing!.id,
          requiredKitDate: '2026-11-10',
          prototypeRequiredDate: '2026-11-15',
        },
        201,
      )
    ).id
    const p = await project()
    assert.equal(p.profile.motorCode, 'MOTOR-CODE-001')
    const data = {
      expectedVersion: p.version,
      code: 'ORDER-002',
      motorCode: 'MOTOR-CODE-002',
      reason: '修正订单编号',
    }
    const preview = await call(
      'technical',
      `/projects/${projectId}/change-preview`,
      'POST',
      data,
    )
    await call('technical', `/projects/${projectId}/plan`, 'PATCH', {
      ...data,
      expectedSnapshot: preview.expectedSnapshot,
    })
    assert.equal((await project()).code, 'ORDER-002')
    assert.equal((await project()).profile.motorCode, 'MOTOR-CODE-002')
    await call(
      'technical',
      `/projects/${projectId}/plan`,
      'PATCH',
      { ...data, expectedSnapshot: preview.expectedSnapshot },
      409,
    )
    await call('otherTech', `/projects/${projectId}`, 'GET', undefined, 403)
  })
  await test('Import alone creates no purchasing tasks; explicit owner assignment routes to the buyer', async () => {
    oldImport = (await importWorkbook()).importId
    originalRows = (await tree()).rows
    assert.equal(
      (await call('procurement', '/workbench/procurement')).items.length,
      0,
    )
    const t = await call(
      'technical',
      `/bom-items/${originalRows[2].id}/tracking`,
      'PATCH',
      {
        ownerId: actors.procurement!.id,
        requiredDate: '2026-11-08',
        trackingEnabled: true,
        affectsKit: true,
        expectedVersion: 0,
      },
    )
    trackingId = t.id
    const items = (await call('procurement', '/workbench/procurement')).items
    assert.equal(items.length, 1)
    assert.equal(items[0].motorModel, model)
    await call('procurement', `/tracking/${trackingId}/promise`, 'POST', {
      expectedVersion: t.version,
      committedDate: '2026-11-07',
      reason: '供应商确认',
    })
  })
  await test('Excel reimports require a review that retains original commitments', async () => {
    await importWorkbook()
    const review = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
    )
    assert.equal(review.items.length, 1)
    const r = review.items[0]
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      {
        action: 'migrate',
        trackingItemId: r.item.id,
        expectedVersion: r.item.version,
        expectedProjectVersion: review.projectVersion,
        activeImportId: review.activeImportId,
        targetBomItemId: r.suggestedId,
        reason: '核对原位置与数量一致',
      },
    )
    const t = (await project()).items.find((t: any) => t.id === trackingId)
    assert.equal(t.firstCommittedDate, '2026-11-07')
    assert.equal(t.currentCommittedDate, '2026-11-07')
    assert.notEqual(t.bomItemId, originalRows[2].id)
  })
  await test('Online revisions carry only unchanged rows and preserve promises on those tasks', async () => {
    const p = await project(),
      rows = (await tree()).rows
    await call('technical', `/bom-items/${rows[1].id}/tracking`, 'PATCH', {
      ownerId: actors.manufacturing!.id,
      requiredDate: '2026-11-08',
      trackingEnabled: true,
      affectsKit: true,
      expectedVersion: 0,
    })
    const result = await call(
      'technical',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      {
        action: 'edit',
        importId: p.activeBomImportId,
        bomItemId: rows[0].id,
        expectedProjectVersion: p.version,
        reason: '修改未跟踪物料',
        row: { qty: '3' },
      },
      201,
    )
    assert.equal(result.carriedCount, 1)
    const tracked = (await project()).items.find(
      (t: any) => t.id === trackingId,
    )
    assert.equal(tracked.firstCommittedDate, '2026-11-07')
    assert.equal(tracked.bomReference.current, true)
    assert.equal(
      (await call('technical', `/projects/${projectId}/bom/reconciliation`))
        .items.length,
      1,
    )
  })
  await test('Online editing produces immutable versions and exports revised content; changed-code tracking stays on the old item', async () => {
    const p = await project(),
      rows = (await tree()).rows,
      target = rows[2]
    const body = {
      action: 'edit',
      importId: p.activeBomImportId,
      bomItemId: target.id,
      expectedProjectVersion: p.version,
      reason: '替换采购规格',
      row: { materialCode: 'B-NEW', specification: '规格B新版', qty: '2' },
    }
    await call(
      'manufacturing',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      body,
      403,
    )
    await call(
      'supervisor',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      body,
      403,
    )
    const revised = await call(
      'technical',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      body,
      201,
    )
    await call(
      'technical',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      body,
      409,
    )
    assert.equal(revised.carriedCount, 0)
    const diff = await call(
      'technical',
      `/projects/${projectId}/bom/diff?before=${p.activeBomImportId}&after=${revised.importId}`,
    )
    const change = diff.find((d: any) => d.type === 'CODE_CHANGED')
    assert.equal(change.before.materialCode, 'B')
    assert.equal(change.after.materialCode, 'B-NEW')
    const review = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
    )
    assert.equal(
      review.items.find((r: any) => r.item.id === trackingId).replacement
        .materialCode,
      'B-NEW',
    )
    assert.equal(
      review.items.find((r: any) => r.item.id === trackingId).suggestedId,
      null,
    )
    const t = (await project()).items.find((t: any) => t.id === trackingId)
    assert.equal(t.bomItemId, target.id)
    assert.equal(t.firstCommittedDate, '2026-11-07')
    const buyerHistory = await call(
      'procurement',
      `/tracking/${trackingId}/history`,
    )
    assert.equal(buyerHistory.bomChange.before.code, 'B')
    assert.equal(buyerHistory.bomChange.after.code, 'B-NEW')
    const [original] = await db
      .select()
      .from(s.npiBomItems)
      .where(eq(s.npiBomItems.id, originalRows[2].id))
    assert.equal(original!.row.materialCode, 'B')
    const response = await app.request(
      root + `/api/v1/npi/projects/${projectId}/bom/${revised.importId}/source`,
      { headers: { cookie: 'session=' + actors.technical!.token } },
    )
    assert.equal(response.status, 200)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as any)
    assert.equal(workbook.worksheets[0]!.getCell('C8').value, 'B-NEW')
    assert.equal(workbook.worksheets[0]!.getCell('G8').value, '2')
  })
  await test('Removing a parent requires an exact subtree count and retains the old version', async () => {
    const p = await project(),
      rows = (await tree()).rows
    const body = {
      action: 'remove',
      importId: p.activeBomImportId,
      bomItemId: rows[0].id,
      expectedProjectVersion: p.version,
      reason: '整组替代',
      expectedRemovedCount: 1,
    }
    await call(
      'technical',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      body,
      409,
    )
    const r = await call(
      'technical',
      `/projects/${projectId}/bom/revisions`,
      'POST',
      { ...body, expectedRemovedCount: 2 },
      201,
    )
    assert.equal(r.rowCount, 1)
    assert.equal(
      (
        await call(
          'technical',
          `/projects/${projectId}/bom/tree?importId=${oldImport}`,
        )
      ).rows.length,
      3,
    )
  })
  await test('Trash hides tasks and blocks writes until restored; other users cannot restore', async () => {
    const p = await project(),
      body = {
        action: 'delete',
        expectedVersion: p.version,
        reason: '误建项目',
        confirmCode: 'ORDER-002',
      }
    await call(
      'manufacturing',
      `/projects/${projectId}/trash`,
      'POST',
      body,
      403,
    )
    await call('technical', `/projects/${projectId}/trash`, 'POST', body)
    assert.equal((await call('technical', '/dashboard')).projects.length, 0)
    assert.equal(
      (await call('procurement', '/workbench/procurement')).items.length,
      0,
    )
    await call(
      'procurement',
      `/tracking/${trackingId}/promise`,
      'POST',
      { expectedVersion: 1, committedDate: '2026-11-08', reason: '已删除项目' },
      404,
    )
    await call('technical', `/projects/${projectId}`, 'GET', undefined, 404)
    const rows = await call('technical', '/project-trash')
    assert.equal(rows.length, 1)
    const deletedDetail = await call('technical', `/project-trash/${projectId}`)
    assert.ok(deletedDetail.counts.bomVersions > 0)
    assert.ok(deletedDetail.counts.trackingItems > 0)
    assert.equal(deletedDetail.project.deletedByName, '验证-technical')
    await call(
      'otherTech',
      `/project-trash/${projectId}`,
      'GET',
      undefined,
      404,
    )
    const restore = {
      action: 'restore',
      expectedVersion: rows[0].version,
      reason: '恢复验证',
    }
    await call(
      'otherTech',
      `/projects/${projectId}/trash`,
      'POST',
      restore,
      403,
    )
    await call('technical', `/projects/${projectId}/trash`, 'POST', restore)
    assert.equal((await call('technical', '/dashboard')).projects.length, 1)
    assert.equal(
      (await call('procurement', '/workbench/procurement')).items[0]
        .firstCommittedDate,
      '2026-11-07',
    )
  })
  await test('Departments share same-role tasks, audit the actual actor and revoke access immediately', async () => {
    const buyer = actors.sharedBuyer!,
      mfg = actors.sharedMfg!
    const body = {
      name: '采购一组',
      role: 'procurement',
      memberIds: [actors.procurement!.id, buyer.id],
      expectedVersion: 0,
      reason: '建立采购协作',
    }
    await call('supervisor', '/departments', 'POST', body, 403)
    await call(
      'admin',
      '/departments',
      'POST',
      { ...body, memberIds: [mfg.id] },
      422,
    )
    const department = await call('admin', '/departments', 'POST', body)
    const manufacturing = await call('admin', '/departments', 'POST', {
      ...body,
      name: '制造一组',
      role: 'manufacturing',
      memberIds: [actors.manufacturing!.id, mfg.id],
    })
    const shared = (await call('sharedBuyer', '/workbench/procurement')).items
    assert.equal(shared.length, 1)
    assert.equal(shared[0].ownerId, actors.procurement!.id)
    const saved = await call(
      'sharedBuyer',
      `/tracking/${trackingId}/promise`,
      'POST',
      {
        expectedVersion: shared[0].version,
        committedDate: '2026-11-06',
        reason: '同组成员跟进供应商',
      },
    )
    assert.equal(saved.firstCommittedDate, '2026-11-07')
    const [history] = await db
      .select()
      .from(s.npiPromiseHistory)
      .where(eq(s.npiPromiseHistory.changedBy, buyer.id))
    assert.equal(history!.changedBy, buyer.id)
    await call('sharedBuyer', `/projects/${projectId}`, 'GET', undefined, 403)
    await call('sharedBuyer', `/files/tracking/${trackingId}`)
    const p = await call('sharedMfg', `/projects/${projectId}`)
    assert.equal((await call('sharedMfg', '/dashboard')).projects.length, 1)
    const node = p.items.find((i: any) => i.trackingType === 'process')
    await call('sharedMfg', `/tracking/${node.id}/promise`, 'POST', {
      expectedVersion: node.version,
      committedDate: '2026-11-05',
      reason: '同组工艺安排',
    })
    await call(
      'sharedBuyer',
      `/tracking/${node.id}/promise`,
      'POST',
      {
        expectedVersion: node.version + 1,
        committedDate: '2026-11-04',
        reason: '跨岗位不得回复',
      },
      403,
    )
    await call('admin', '/departments', 'POST', {
      ...body,
      id: department.id,
      memberIds: [actors.procurement!.id],
      expectedVersion: department.version,
      reason: '采购成员移出',
    })
    assert.equal(
      (await call('sharedBuyer', '/workbench/procurement')).items.length,
      0,
    )
    await call(
      'sharedBuyer',
      `/tracking/${trackingId}/promise`,
      'POST',
      {
        expectedVersion: saved.version,
        committedDate: '2026-11-04',
        reason: '旧页面不得继续办理',
      },
      403,
    )
    await call(
      'sharedBuyer',
      `/files/tracking/${trackingId}`,
      'GET',
      undefined,
      403,
    )
    await call(
      'admin',
      '/departments',
      'POST',
      { ...body, id: department.id, expectedVersion: department.version },
      409,
    )
    await call('admin', '/departments', 'POST', {
      name: manufacturing.name,
      role: 'manufacturing',
      id: manufacturing.id,
      memberIds: [actors.manufacturing!.id],
      expectedVersion: manufacturing.version,
      reason: '制造成员移出',
    })
    assert.equal((await call('sharedMfg', '/dashboard')).projects.length, 0)
    await call('sharedMfg', `/projects/${projectId}`, 'GET', undefined, 403)
  })
  await test('LAN browser compatibility: files, inheritance, project identities, report drill-down and online procurement', async () => {
    mkdirSync('runtime/test-evidence', { recursive: true })
    const log = openSync('runtime/test-evidence/issue-1-server.log', 'w')
    const server = spawn(process.execPath, ['dist/server.mjs'], {
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: '3494', HOST: '127.0.0.1' },
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
      for (const mobile of [false, true]) {
        const context = await browser.newContext({
          viewport: mobile
            ? { width: 390, height: 844 }
            : { width: 1440, height: 1050 },
        })
        await context.addCookies([
          { name: 'session', value: actors.technical!.token, url: root },
        ])
        // Reproduce the real LAN HTTP capability set: randomUUID is unavailable.
        await context.addInitScript(() => {
          Object.defineProperty(Crypto.prototype, 'randomUUID', {
            value: undefined,
            configurable: true,
          })
        })
        const page = await context.newPage()
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(root + '/npi')
        await expect(
          page.getByRole('heading', { name: '新品驾驶舱', exact: true }),
        ).toBeVisible()
        await expect(page.locator('[data-brief-id]').first()).toContainText(
          model,
        )
        const nav = page.getByRole('navigation', {
          name: '主导航',
          exact: true,
        })
        await nav.getByRole('button', { name: '新品项目', exact: true }).click()
        await expect(
          page.getByRole('region', { name: '新品项目目录' }),
        ).toContainText(model)
        await page
          .getByRole('button', { name: '项目详情 ↗', exact: true })
          .click()
        await expect(page.getByRole('heading', { level: 1 })).toContainText(
          model,
        )
        await page.getByRole('tab', { name: '项目资料', exact: true }).click()
        const files = page.getByRole('region', { name: '附件资料' })
        await files
          .getByLabel('选择文件或照片', { exact: true })
          .setInputFiles({
            name: '规格.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(
              '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
            ),
          })
        await files
          .getByLabel('资料标题', { exact: true })
          .fill(mobile ? '手机附件' : '桌面附件')
        await files
          .getByRole('button', { name: '上传资料', exact: true })
          .click()
        await expect(
          files.getByText(mobile ? '手机附件' : '桌面附件', { exact: true }),
        ).toBeVisible()
        await page
          .getByRole('button', { name: '以此项目新建', exact: true })
          .click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await page
          .getByRole('dialog')
          .getByRole('button', { name: '关闭弹窗', exact: true })
          .click()
        await page.getByRole('tab', { name: '制造准备', exact: true }).click()
        await page
          .getByRole('button', { name: '工艺准备附件资料', exact: true })
          .click()
        await expect(
          page.getByRole('dialog').getByRole('region', { name: '附件资料' }),
        ).toBeVisible()
        await page
          .getByRole('dialog')
          .getByRole('button', { name: '关闭弹窗', exact: true })
          .click()
        await nav.getByRole('button', { name: '报表看板', exact: true }).click()
        await page
          .locator('.npi-stage-distribution')
          .getByRole('button', { name: /设计中/ })
          .click()
        await expect(
          page.getByRole('cell', { name: '项目清单', exact: true }),
        ).toHaveCount(0)
        await expect(
          page.getByRole('button', {
            name: model + ' · ' + projectName + ' ↗',
            exact: true,
          }),
        ).toBeVisible()
        await page.screenshot({
          path: `runtime/test-evidence/issue-1-reports-${mobile ? 'mobile' : 'desktop'}.png`,
          fullPage: true,
        })
        await nav.getByRole('button', { name: '制造准备', exact: true }).click()
        await expect(page.locator('[data-npi-task]').first()).toContainText(
          model,
        )
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        if (!mobile) {
          await nav
            .getByRole('button', { name: 'BOM管理', exact: true })
            .click()
          await page
            .getByRole('button', { name: '进入BOM ↗', exact: true })
            .click()
          await page
            .getByRole('button', { name: '修订物料', exact: true })
            .click()
          const dialog = page.getByRole('dialog')
          await dialog.getByLabel('规格', { exact: true }).fill('在线修改规格')
          await dialog
            .getByLabel('修订原因', { exact: true })
            .fill('浏览器回归')
          await dialog
            .getByRole('button', { name: '确认生成新版本', exact: true })
            .click()
          await expect(dialog).toHaveCount(0)
          await expect(
            page.getByRole('table', { name: '完整BOM明细' }),
          ).toContainText('在线修改规格')
          await page
            .getByRole('button', { name: '分配采购', exact: true })
            .click()
          await page
            .getByRole('dialog')
            .getByLabel('回复责任人', { exact: true })
            .selectOption(actors.procurement!.id)
          await page
            .getByRole('dialog')
            .getByRole('button', { name: '保存', exact: true })
            .click()
          await expect(page.getByRole('dialog')).toHaveCount(0)
          assert.equal(
            (await call('procurement', '/workbench/procurement')).items.length,
            2,
          )
        }
        await context.close()
      }
      const adminContext = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
      })
      await adminContext.addCookies([
        { name: 'session', value: actors.admin!.token, url: root },
      ])
      const adminPage = await adminContext.newPage()
      adminPage.on('pageerror', (e) => errors.push(e.message))
      await adminPage.goto(root + '/npi')
      await adminPage
        .getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('button', { name: '系统设置', exact: true })
        .click()
      const groups = adminPage.getByRole('region', { name: '部门协作分组' })
      await groups
        .locator('.npi-settings-row')
        .filter({ hasText: '采购一组' })
        .getByRole('button', { name: '管理成员', exact: true })
        .click()
      await adminPage
        .getByRole('dialog')
        .getByLabel(/验证-sharedBuyer/)
        .check()
      await adminPage
        .getByRole('dialog')
        .getByLabel('变更原因', { exact: true })
        .fill('浏览器确认共享范围')
      await adminPage
        .getByRole('dialog')
        .getByRole('button', { name: '确认共享范围（2人）', exact: true })
        .click()
      await expect(adminPage.getByRole('dialog')).toHaveCount(0)
      await expect(
        groups.locator('.npi-settings-row').filter({ hasText: '采购一组' }),
      ).toContainText('验证-sharedBuyer')
      await adminPage.screenshot({
        path: 'runtime/test-evidence/issue-1-departments.png',
        fullPage: true,
      })
      const sharedContext = await browser.newContext()
      await sharedContext.addCookies([
        { name: 'session', value: actors.sharedBuyer!.token, url: root },
      ])
      const sharedPage = await sharedContext.newPage()
      sharedPage.on('pageerror', (e) => errors.push(e.message))
      await sharedPage.goto(root + '/npi')
      await expect(
        sharedPage.getByRole('heading', { name: '我的采购件', exact: true }),
      ).toBeVisible()
      await expect(
        sharedPage.getByRole('button', { name: '改期', exact: true }),
      ).toBeVisible()
      await expect(
        sharedPage.getByRole('button', { name: '到货', exact: true }).first(),
      ).toBeVisible()
      await sharedContext.close()
      await adminContext.close()
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
