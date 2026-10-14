// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual multi-role browser workflow against a fresh database and built application.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { chromium, expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_workflow_navigation')
process.env.ATTACHMENT_ROOT = mkdtempSync(join(tmpdir(), 'hd-workflow-files-'))
const portProbe = createServer()
await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
const address = portProbe.address()
assert(address && typeof address !== 'string')
const port = String(address.port)
await new Promise<void>((resolve, reject) =>
  portProbe.close((error) => (error ? reject(error) : resolve())),
)
const root = 'http://localhost:' + port
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
  'otherTech',
]) {
  const [user] = await db
    .insert(users)
    .values({
      email: crypto.randomUUID() + '@workflow-browser.test.invalid',
      name: '协同验证-' + role,
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
  if (
    method === 'PATCH' &&
    /^\/bom-items\/[^/]+\/tracking$/.test(path) &&
    status === 200 &&
    (data as any)?.expectedVersion === 0
  ) {
    const { sql } = await import('drizzle-orm')
    const rows = await db.execute(
      sql`select version from npi_tracking_items where bom_item_id=${path.split('/')[2]!}`,
    )
    if (rows[0])
      data = {
        ...(data as object),
        expectedVersion: rows[0].version,
        reason: '测试夹具分配已自动生成的任务',
      }
  }
  const actor = actors[role]!,
    form = data instanceof FormData
  const response = await app.request(root + '/api/v1/npi' + path, {
    method,
    headers: {
      cookie: 'session=' + actor.token,
      origin: root,
      'x-npi-actor': actor.id,
      ...(form ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : form ? data : JSON.stringify(data),
  })
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}

let projectId = '',
  alternateProjectId = '',
  oldBomId = '',
  activeBomId = ''
const detail = () => call('technical', `/projects/${projectId}`)
const projectUrl = (tab = 'overview', view = 'projects') =>
  `${root}/npi?view=${view}&project=${projectId}&tab=${tab}`
async function seedWorkflow() {
  projectId = (
    await call(
      'technical',
      '/projects',
      'POST',
      {
        code: 'FLOW-UI-001',
        name: '全流程协同电机',
        motorModel: 'YE5-250M-4 55kW B3',
        technicalOwnerId: actors.technical!.id,
        manufacturingOwnerId: actors.manufacturing!.id,
        requiredKitDate: '2026-11-20',
        prototypeRequiredDate: '2026-11-28',
      },
      201,
    )
  ).id
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet('母件结构表-多阶')
  sheet.getCell('A4').value = 'FLOW-MOTOR'
  sheet.getCell('B4').value = '全流程协同电机'
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
  for (let i = 0; i < 3; i++)
    sheet.getRow(i + 6).values = [
      '+',
      (i + 1) * 10,
      'FLOW-PART-' + i,
      ['待生产机壳', '待采购轴承', '标准垫片'][i],
      '规格' + i,
      1,
      '只',
      i === 1 ? '外购' : '领用',
      i === 1 ? '采购' : '金工',
    ]
  const form = new FormData()
  form.set(
    'file',
    new File(
      [new Uint8Array(await workbook.xlsx.writeBuffer())],
      'workflow.xlsx',
    ),
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
    { previewToken: preview.previewToken },
    201,
  )
  const rows = (await call('technical', `/projects/${projectId}/bom/tree`)).rows
  for (let i = 0; i < 2; i++)
    await call('technical', `/bom-items/${rows[i].id}/tracking`, 'PATCH', {
      expectedVersion: 0,
      ownerId: actors[i === 1 ? 'procurement' : 'manufacturing']!.id,
      requiredDate: '2026-11-20',
      trackingEnabled: true,
      affectsKit: true,
    })
  oldBomId = (await detail()).activeBomImportId
  const nextPreview = await call(
    'technical',
    `/projects/${projectId}/bom/import-preview`,
    'POST',
    form,
  )
  await call(
    'technical',
    `/projects/${projectId}/bom/import`,
    'POST',
    { previewToken: nextPreview.previewToken },
    201,
  )
  activeBomId = (await detail()).activeBomImportId
  const review = await call(
    'technical',
    `/projects/${projectId}/bom/reconciliation`,
  )
  for (const row of review.items)
    await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      {
        action: 'migrate',
        trackingItemId: row.item.id,
        targetBomItemId: row.suggestedId,
        expectedVersion: row.item.version,
        expectedProjectVersion: review.projectVersion,
        activeImportId: review.activeImportId,
        reason: '导入后已逐项核对新版位置与数量',
      },
    )
  alternateProjectId = (
    await call(
      'technical',
      '/projects',
      'POST',
      {
        code: 'FLOW-UI-002',
        name: '异步读取项目 B',
        motorModel: 'SECOND-MODEL',
        technicalOwnerId: actors.technical!.id,
        manufacturingOwnerId: actors.manufacturing!.id,
        requiredKitDate: '2026-11-20',
        prototypeRequiredDate: '2026-11-28',
      },
      201,
    )
  ).id
}

try {
  await seedWorkflow()
  await test('Browser: persistent project routes, protected drafts, role boundaries and a complete five-stage collaboration', async () => {
    mkdirSync('runtime/test-evidence', { recursive: true })
    const log = openSync(
      'runtime/test-evidence/workflow-navigation-server.log',
      'w',
    )
    const server = spawn(process.execPath, ['dist/server.mjs'], {
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
    })
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CI ? {} : { channel: 'chrome' }),
    })
    const contexts: BrowserContext[] = [],
      errors: string[] = []
    async function pageFor(role: string, url = projectUrl(), mobile = false) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1440, height: 1000 },
      })
      contexts.push(context)
      context.setDefaultTimeout(15000)
      await context.addCookies([
        { name: 'session', value: actors[role]!.token, url: root },
      ])
      const page = await context.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(url)
      return page
    }
    const guide = (page: Page) =>
      page.getByRole('region', { name: '当前阶段协作指引', exact: true })
    async function expectTab(page: Page, tab: string, name: string) {
      await expect
        .poll(() => new URL(page.url()).searchParams.get('project'))
        .toBe(projectId)
      await expect
        .poll(() => new URL(page.url()).searchParams.get('tab'))
        .toBe(tab)
      await expect(
        page.getByRole('tab', { name, exact: true, includeHidden: true }),
      ).toHaveAttribute('aria-selected', 'true')
    }
    async function advance(page: Page, next: string, label: string) {
      await page.getByRole('tab', { name: '概览', exact: true }).click()
      const before = await guide(page).innerText()
      await page
        .getByRole('button', { name: `推进阶段 · ${label}`, exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading')).toHaveText('推进至' + label)
      if (next === 'manufacturing')
        await dialog.getByLabel('图纸实际完成日期').fill('2026-09-01')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(async () => (await detail()).currentNpiStage).toBe(next)
      await expect(guide(page)).toBeVisible()
      await expect.poll(() => guide(page).innerText()).not.toBe(before)
    }
    async function replyAndCompletePart(
      page: Page,
      role: 'manufacturing' | 'procurement',
    ) {
      await page.goto(`${root}/npi?view=${role}`)
      await page.locator(`[data-workbench-project="${projectId}"]`).click()
      await page
        .getByRole('button', { name: '批量回复完成时间', exact: true })
        .click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByLabel('快速回复项目')).toHaveCount(0)
      const dates = dialog.locator('tbody input[type=date]')
      const count = role === 'manufacturing' ? 3 : 1
      await expect(dates).toHaveCount(count)
      for (let i = 0; i < count; i++) await dates.nth(i).fill('2026-11-10')
      await dialog
        .getByRole('button', { name: `提交 ${count} 项回复`, exact: true })
        .click()
      await expect(
        dialog.locator('.npi-message[role=status]').first(),
      ).toContainText(`已回复 ${count} 个部件`)
      await dialog
        .getByRole('button', {
          name: role === 'procurement' ? '实际到货' : '实际完成',
          exact: true,
        })
        .click()
      await expect(dates).toHaveCount(count)
      for (let i = 0; i < count; i++) await dates.nth(i).fill('2026-09-01')
      await dialog
        .getByRole('button', {
          name: `确认 ${count} 项已实际完成`,
          exact: true,
        })
        .click()
      await expect(
        dialog.locator('.npi-message[role=status]').first(),
      ).toContainText(`已确认实际完成 ${count} 个部件`)
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    try {
      let ready = false
      for (let i = 0; i < 60; i++) {
        assert.equal(
          server.exitCode,
          null,
          'isolated application server exited early',
        )
        try {
          if ((await fetch(root + '/api/health')).ok) {
            ready = true
            break
          }
        } catch {}
        await delay(250)
      }
      assert.ok(ready, 'built server must become ready')
      const tech = await pageFor('technical', projectUrl('bom'))
      await expectTab(tech, 'bom', 'ERP BOM')
      await expect(
        tech.getByRole('table', { name: '完整BOM明细' }),
      ).toContainText('待生产机壳')
      await tech.reload()
      await expectTab(tech, 'bom', 'ERP BOM')
      await tech.getByRole('tab', { name: '项目资料', exact: true }).click()
      await expectTab(tech, 'files', '项目资料')
      await tech.getByRole('tab', { name: '承诺与动态', exact: true }).click()
      await expectTab(tech, 'history', '承诺与动态')
      await tech.goBack()
      await expectTab(tech, 'files', '项目资料')
      await tech.goBack()
      await expectTab(tech, 'bom', 'ERP BOM')
      await tech.goForward()
      await expectTab(tech, 'files', '项目资料')
      await tech.reload()
      await expectTab(tech, 'files', '项目资料')
      await tech
        .getByRole('button', { name: '返回新品项目', exact: true })
        .click()
      await expect
        .poll(() => new URL(tech.url()).searchParams.has('project'))
        .toBe(false)
      await expect(
        tech.getByRole('region', { name: '新品项目目录' }),
      ).toBeVisible()
      await tech.goBack()
      await expectTab(tech, 'files', '项目资料')
      await tech.getByRole('tab', { name: '概览', exact: true }).click()
      await expect(guide(tech)).toBeVisible()
      for (const stage of ['设计', '制造', '样机', '试验', '完成'])
        await expect(guide(tech)).toContainText(stage)
      await expect(guide(tech)).toContainText('协同验证-technical')
      await expect(
        tech.getByRole('button', { name: '编辑项目信息', exact: true }),
      ).toBeVisible()

      // A delayed cross-project response must not overwrite the project restored by Back.
      const alternateUrl = `${root}/npi?view=projects&project=${alternateProjectId}&tab=overview`
      let release!: () => void, intercepted!: () => void, finished!: () => void
      const hold = new Promise<void>((resolve) => {
          release = resolve
        }),
        received = new Promise<void>((resolve) => {
          intercepted = resolve
        }),
        fulfilled = new Promise<void>((resolve) => {
          finished = resolve
        })
      await tech.route(
        `**/api/v1/npi/projects/${alternateProjectId}`,
        async (route) => {
          const response = await route.fetch()
          intercepted()
          await hold
          await route.fulfill({ response })
          finished()
        },
        { times: 1 },
      )
      await tech.evaluate(
        ({ alternateUrl, originalUrl }) => {
          history.pushState(null, '', alternateUrl)
          history.pushState(null, '', originalUrl)
        },
        { alternateUrl, originalUrl: projectUrl() },
      )
      await tech.goBack()
      await received
      await tech.goBack()
      await expectTab(tech, 'overview', '概览')
      release()
      await fulfilled
      await tech.getByRole('tab', { name: '项目资料', exact: true }).click()
      await expectTab(tech, 'files', '项目资料')
      await expect(tech.locator('.npi-project-summary')).toContainText(
        'FLOW-UI-001',
      )
      await expect(tech.locator('.npi-project-summary')).not.toContainText(
        'FLOW-UI-002',
      )
      await tech.getByRole('tab', { name: '概览', exact: true }).click()

      // These dialogs own local form state and are not represented by Workspace's dialog booleans.
      for (const [button, value] of [
        ['编辑项目信息', '保留的项目计划名称'],
        ['以此项目新建', '保留的继承项目名称'],
      ]) {
        await tech.getByRole('button', { name: button!, exact: true }).click()
        const dialog = tech.getByRole('dialog')
        await dialog.getByLabel('电机型号', { exact: true }).fill(value!)
        await tech.goBack()
        await expectTab(tech, 'overview', '概览')
        await expect(
          dialog.getByLabel('电机型号', { exact: true }),
        ).toHaveValue(value!)
        await expect(tech.locator('.npi-navigation-notice')).toBeVisible()
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        await expect(dialog).toHaveCount(0)
      }
      await tech.getByRole('tab', { name: /^项目问题/ }).click()
      await expectTab(tech, 'issues', '项目问题')
      await tech.getByRole('button', { name: '新建问题', exact: true }).click()
      const issueDraft = tech.getByRole('dialog')
      await issueDraft
        .getByLabel('问题标题', { exact: true })
        .fill('后退仍保留的问题草稿')
      await tech.goBack()
      await expectTab(tech, 'issues', '项目问题')
      await expect(
        issueDraft.getByLabel('问题标题', { exact: true }),
      ).toHaveValue('后退仍保留的问题草稿')
      await issueDraft
        .getByRole('button', { name: '取消', exact: true })
        .click()

      await tech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
      await tech.getByLabel('BOM版本', { exact: true }).selectOption(oldBomId)
      await expect(tech.getByLabel('BOM版本', { exact: true })).toHaveValue(
        oldBomId,
      )
      await tech.getByRole('tab', { name: '概览', exact: true }).click()
      await guide(tech)
        .getByRole('button', { name: /打开BOM与任务分配/ })
        .click()
      await expectTab(tech, 'bom', 'ERP BOM')
      await expect(tech.getByLabel('BOM版本', { exact: true })).toHaveValue(
        activeBomId,
      )
      await tech.getByLabel('BOM版本', { exact: true }).selectOption(oldBomId)
      await tech.getByRole('tab', { name: '样机齐套', exact: true }).click()
      await tech.getByRole('tab', { name: 'ERP BOM', exact: true }).click()
      await tech
        .getByLabel('BOM版本', { exact: true })
        .selectOption(activeBomId)
      const untracked = tech
        .getByRole('table', { name: '完整BOM明细' })
        .getByRole('row')
        .filter({ hasText: '标准垫片' })
      await untracked.locator('.npi-bom-name-link').click()
      await tech
        .getByRole('dialog')
        .getByRole('button', { name: '修订物料', exact: true })
        .click()
      const revision = tech.getByRole('dialog')
      await revision
        .getByLabel('物料名称', { exact: true })
        .fill('后退仍保留的修订名称')
      await tech.goBack()
      await expectTab(tech, 'bom', 'ERP BOM')
      await expect(
        revision.getByLabel('物料名称', { exact: true }),
      ).toHaveValue('后退仍保留的修订名称')
      await revision.getByRole('button', { name: '取消', exact: true }).click()
      await tech.getByRole('tab', { name: '概览', exact: true }).click()

      const supervisor = await pageFor('supervisor')
      await expect(guide(supervisor)).toBeVisible()
      await expect(
        supervisor.getByRole('button', { name: '编辑项目信息', exact: true }),
      ).toBeVisible()
      await expect(
        supervisor.getByRole('button', { name: /^推进阶段/ }),
      ).toHaveCount(0)
      await supervisor
        .getByRole('tab', { name: '样机齐套', exact: true })
        .click()
      await expect(
        supervisor.getByRole('button', { name: '集中回复', exact: true }),
      ).toHaveCount(0)
      await expect(
        supervisor.getByRole('button', { name: '集中确认完成', exact: true }),
      ).toHaveCount(0)

      const buyer = await pageFor('procurement', projectUrl('bom'))
      const outsider = await pageFor('otherTech', projectUrl('bom'))
      for (const page of [buyer, outsider]) {
        await expect(page.locator('.npi-project-summary')).toHaveCount(0)
        await expect(
          page.getByRole('tab', { name: 'ERP BOM', exact: true }),
        ).toHaveCount(0)
        await expect(guide(page)).toHaveCount(0)
        await expect(
          page.getByRole('table', { name: '完整BOM明细' }),
        ).toHaveCount(0)
      }
      await call('procurement', `/projects/${projectId}`, 'GET', undefined, 403)
      await call('otherTech', `/projects/${projectId}`, 'GET', undefined, 403)

      await advance(tech, 'manufacturing', '制造准备')
      const mfg = await pageFor(
        'manufacturing',
        projectUrl('manufacturing', 'manufacturing'),
      )
      await expect(
        mfg.getByRole('region', { name: '项目任务工作页' }),
      ).toBeVisible()
      await expect(
        mfg.getByRole('table', { name: '完整BOM明细' }),
      ).toBeVisible()
      await replyAndCompletePart(buyer, 'procurement')
      await replyAndCompletePart(mfg, 'manufacturing')
      await tech.reload()
      await expect(guide(tech)).toContainText('制造')
      await tech.screenshot({
        path: 'runtime/test-evidence/workflow-manufacturing-desktop.png',
        fullPage: true,
      })
      await advance(tech, 'prototype', '样机制作')
      await tech.reload()
      await tech.setViewportSize({ width: 390, height: 844 })
      await expect(guide(tech)).toBeVisible()
      assert.ok(
        await tech.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        'mobile page must not overflow horizontally',
      )
      await tech.screenshot({
        path: 'runtime/test-evidence/workflow-prototype-mobile.png',
        fullPage: true,
      })
      await advance(tech, 'test', '样机试验')
      await advance(tech, 'completed', '完成')
      await expect(tech.getByRole('button', { name: /^推进阶段/ })).toHaveCount(
        0,
      )
      await expect(
        tech.getByRole('button', { name: '编辑项目信息', exact: true }),
      ).toHaveCount(0)
      await expect(guide(tech)).toContainText(/只读|归档|完成/)
      await tech.reload()
      await expectTab(tech, 'overview', '概览')
      await mfg.reload()
      await expect(
        mfg.getByRole('button', { name: '集中回复', exact: true }),
      ).toHaveCount(0)
      await expect(
        mfg.getByRole('button', { name: '集中确认完成', exact: true }),
      ).toHaveCount(0)
      const final = await detail()
      assert.equal(final.currentNpiStage, 'completed')
      assert.equal(
        final.untrackedBomCount,
        0,
        'every current BOM row must have a delivery task',
      )
      assert.equal(
        final.items.filter(
          (r: any) => r.sourceType === 'ERP_BOM' && r.actualCompleteDate,
        ).length,
        3,
      )
      assert.equal(
        final.events.filter((e: any) => e.action === 'STAGE_CHANGED').length,
        4,
      )
      assert.deepEqual(errors, [])
    } finally {
      for (const context of contexts) await context.close()
      await browser.close()
      server.kill()
      closeSync(log)
    }
  })
} finally {
  await closeDatabase()
}
