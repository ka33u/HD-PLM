import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { deliveryFixture } from './helpers/delivery-fixture'
const f = await deliveryFixture('hd_project_workbench')
const { projects } = await import('../src/lib/db/schema/projects')
const fields = {
  motorType: '三相异步电动机',
  orderQuantity: '12',
  motorModel: 'YE5-250M-4',
  technicalOwnerId: f.actors.technical!.id,
  manufacturingOwnerId: f.actors.manufacturing!.id,
  requiredKitDate: '2026-11-20',
  prototypeRequiredDate: '2026-11-28',
}
let id = '',
  second = '',
  part: any,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  server: ReturnType<typeof spawn> | undefined,
  log: number | undefined
try {
  await test('motor types persist, reject invalid orders and unauthorized edits, and preserve existing options', async () => {
    const meta = await f.call('admin', '/meta')
    assert.deepEqual(
      meta.motorTypes.map((t: any) => t.name),
      [
        '三相异步电动机',
        '永磁同步电动机',
        '磁阻电机',
        '直驱电机',
        '零部件代工',
      ],
    )
    for (const qty of ['0', '-1', '1.5', '1000000', '', {}, true])
      await f.call(
        'technical',
        '/projects',
        'POST',
        { ...fields, orderQuantity: qty },
        422,
      )
    await f.call(
      'technical',
      '/projects',
      'POST',
      { ...fields, motorType: '不存在' },
      422,
    )
    await f.call(
      'technical',
      '/motor-types',
      'POST',
      { name: '伺服电机', enabled: true, expectedVersion: 0 },
      403,
    )
    const option = await f.call('admin', '/motor-types', 'POST', {
      name: '伺服电机',
      enabled: true,
      expectedVersion: 0,
    })
    await f.call(
      'admin',
      '/motor-types',
      'POST',
      { name: '伺服电机', enabled: true, expectedVersion: 0 },
      409,
    )
    await f.call('admin', '/motor-types', 'POST', {
      ...option,
      enabled: false,
      expectedVersion: option.version,
    })
    await f.call(
      'technical',
      '/projects',
      'POST',
      { ...fields, motorType: '伺服电机' },
      422,
    )
    await f.call(
      'admin',
      '/motor-types',
      'POST',
      { ...option, enabled: true, expectedVersion: option.version },
      409,
    )
    id = (await f.call('technical', '/projects', 'POST', fields, 201)).id
    const d = await f.importBom(id, 110)
    assert.equal(d.profile.motorType, fields.motorType)
    assert.equal(d.profile.orderQuantity, '12')
    assert.equal(
      d.items.find((i: any) => i.sourceType === 'WHOLE_MACHINE').qty,
      '12',
    )
    assert(
      d.items
        .filter((i: any) => i.sourceType === 'ERP_BOM')
        .every((i: any) => i.qty === '1'),
    )
  })
  await test('plan preview updates whole-machine quantity only and inheritance starts a new order', async () => {
    const d = await f.detail(id),
      payload = {
        expectedVersion: d.version,
        reason: '订单增加八台',
        orderQuantity: '20',
      }
    const preview = await f.call(
      'supervisor',
      `/projects/${id}/change-preview`,
      'POST',
      payload,
    )
    assert(
      preview.changes.some(
        (c: any) => c.key === 'orderQuantity' && c.after === '20',
      ),
    )
    assert.equal(preview.tracking[0].qtyAfter, '20')
    await f.call('supervisor', `/projects/${id}/plan`, 'PATCH', {
      ...payload,
      expectedSnapshot: preview.expectedSnapshot,
    })
    const next = await f.detail(id)
    assert.equal(
      next.items.find((i: any) => i.sourceType === 'WHOLE_MACHINE').qty,
      '20',
    )
    assert(
      next.items
        .filter((i: any) => i.sourceType === 'ERP_BOM')
        .every((i: any) => i.qty === '1'),
    )
    const inherit = {
      ...fields,
      code: 'WB-NEW-ORDER',
      orderQuantity: '3',
      copyBom: true,
      copyExternal: true,
    }
    const ip = await f.call(
      'technical',
      `/projects/${id}/inheritance-preview`,
      'POST',
      inherit,
    )
    second = (
      await f.call(
        'technical',
        `/projects/${id}/inherit`,
        'POST',
        {
          ...inherit,
          expectedSnapshot: ip.expectedSnapshot,
        },
        201,
      )
    ).id
    assert.equal((await f.detail(second)).profile.orderQuantity, '3')
    const legacy = await f.project()
    await f.db
      .update(projects)
      .set({ attributes: { npi: true } })
      .where(eq(projects.id, legacy))
    const old = await f.detail(legacy)
    assert.equal(old.name, '直接交付电机')
    assert.equal(old.profile.orderQuantity, '')
    assert.equal(old.profile.motorType, '')
  })
  await test('project workbenches keep department scope, protect full-project APIs, and expose only assigned BOM rows to buyers', async () => {
    const d = await f.detail(id),
      parts = d.items.filter((i: any) => i.sourceType === 'ERP_BOM')
    part = parts[0]
    await f.call('manufacturing', `/projects/${id}/bom/assign`, 'POST', {
      items: [{ id: part.bomItemId, expectedVersion: part.version }],
      ownerId: f.actors.procurement!.id,
      reason: '外购转采购',
    })
    const buyer = await f.call(
      'buyerPeer',
      '/workbench/projects?kind=procurement',
    )
    assert.deepEqual(
      buyer.projects.map((p: any) => p.id),
      [id],
    )
    assert.equal(buyer.items.length, 0)
    assert.equal(buyer.rows.length, 0)
    const scoped = await f.call(
      'buyerPeer',
      `/workbench/projects?kind=procurement&projectId=${id}`,
    )
    assert.equal(scoped.items.length, 1)
    assert.equal(scoped.rows.length, 1)
    assert.equal(scoped.project.canOpenProject, false)
    assert.deepEqual(scoped.rows[0].rawData, {})
    await f.call('buyerPeer', `/projects/${id}`, 'GET', undefined, 403)
    await f.call(
      'buyerPeer',
      `/workbench/projects?kind=manufacturing&projectId=${id}`,
      'GET',
      undefined,
      403,
    )
    await f.call(
      'outsider',
      `/workbench/projects?kind=procurement&projectId=${id}`,
      'GET',
      undefined,
      404,
    )
    assert.equal(
      (await f.call('outsider', '/workbench/projects?kind=procurement'))
        .projects.length,
      0,
    )
    const shared = await f.call(
      'peer',
      `/workbench/projects?kind=manufacturing&projectId=${id}`,
    )
    assert.equal(shared.items.length, 110)
    assert.equal(shared.rows.length, 110)
    assert.equal(shared.project.orderQuantity, '20')
  })
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const address = probe.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((r) => probe.close(() => r()))
  const root = `http://localhost:${port}`
  mkdirSync('runtime/test-evidence', { recursive: true })
  log = openSync('runtime/project-workbench-server.log', 'w')
  server = spawn(process.execPath, ['dist/server.mjs'], {
    env: { ...process.env, PORT: String(port), BASE_URL: root },
    stdio: ['ignore', log, log],
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(root + '/api/health')).ok) break
    } catch {}
    await delay(200)
  }
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
  const errors: string[] = []
  async function page(role: string) {
    const c = await browser!.newContext({
      viewport: { width: 1440, height: 960 },
    })
    await c.addCookies([
      { name: 'session', value: f.actors[role]!.token, url: root },
    ])
    const p = await c.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    return p
  }
  await test('project cards lead to compact BOM; batch replies remain within the selected project and back/reload work', async () => {
    const p = await page('manufacturing')
    await p.goto(root + '/npi?view=manufacturing')
    await expect(p.locator('[data-workbench-project]')).toHaveCount(3)
    await expect(p.locator('[data-bom-row]')).toHaveCount(0)
    await expect(p.locator('[data-npi-item]')).toHaveCount(0)
    await p.screenshot({
      path: 'runtime/test-evidence/workbench-projects-desktop.png',
    })
    await p.locator(`[data-workbench-project="${id}"]`).click()
    await expect(p.locator('[data-bom-row]')).toHaveCount(100)
    assert(
      (await p.locator('[data-bom-row]').first().boundingBox())!.height <= 36,
    )
    await p
      .getByLabel('项目BOM分页', { exact: true })
      .getByRole('button', { name: '下一页', exact: true })
      .click()
    await expect(p.getByLabel('项目BOM分页', { exact: true })).toContainText(
      '第2/2页',
    )
    await expect(p.locator('[data-bom-row]')).toHaveCount(9)
    await p
      .getByLabel('项目BOM分页', { exact: true })
      .getByRole('button', { name: '首页', exact: true })
      .click()
    await p.locator('[data-bom-row] input[type=checkbox]').nth(0).check()
    await p
      .locator('[data-bom-row] input[type=checkbox]')
      .nth(2)
      .click({ modifiers: ['Shift'] })
    await p.getByRole('button', { name: '回复已选 3 项', exact: true }).click()
    const d = p.getByRole('dialog')
    await expect(d.locator('tbody tr')).toHaveCount(3)
    await d.getByLabel('统一填写日期', { exact: true }).fill('2026-11-10')
    await d.getByRole('button', { name: '统一填入', exact: true }).click()
    await d.getByRole('button', { name: '提交 3 项回复', exact: true }).click()
    await expect(d.getByRole('status')).toContainText('已回复 3')
    await d.getByRole('button', { name: '关闭', exact: true }).click()
    assert.equal(
      (await f.detail(second)).items.filter((i: any) => i.currentCommittedDate)
        .length,
      0,
    )
    await p.reload()
    await expect(
      p.getByRole('region', { name: '项目任务工作页' }),
    ).toBeVisible()
    await p.screenshot({
      path: 'runtime/test-evidence/workbench-bom-desktop.png',
    })
    await p
      .getByRole('button', { name: '返回生产项目列表', exact: true })
      .click()
    await expect(p.locator('[data-workbench-project]')).toHaveCount(3)
    await p.goBack()
    await expect(
      p.getByRole('region', { name: '项目任务工作页' }),
    ).toBeVisible()
    await p.goto(`${root}/npi?view=projects&project=${id}&tab=manufacturing`)
    await expect(p.locator('[data-npi-item]')).toHaveCount(50)
    assert(
      (await p.locator('[data-npi-item]').first().boundingBox())!.height <= 36,
    )
    await p
      .getByLabel('交付任务分页', { exact: true })
      .getByRole('button', { name: '下一页', exact: true })
      .click()
    await expect(p.getByLabel('交付任务分页', { exact: true })).toContainText(
      '第2/3页',
    )
    await p
      .getByLabel('交付任务分页', { exact: true })
      .getByRole('button', { name: '首页', exact: true })
      .click()
    await p
      .getByRole('button', { name: '查看整机完成任务详情', exact: true })
      .click()
    await expect(p.getByRole('dialog')).toContainText('20 台')
    await expect(
      p
        .getByRole('dialog')
        .getByRole('button', { name: '调整计划', exact: true }),
    ).toBeVisible()
    await p.keyboard.press('Escape')
    await p.screenshot({
      path: 'runtime/test-evidence/delivery-compact-desktop.png',
    })
    await p.setViewportSize({ width: 390, height: 844 })
    assert(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    await p.screenshot({
      path: 'runtime/test-evidence/delivery-compact-mobile.png',
    })
    await p.context().close()
  })
  await test('procurement and supervisor see project-first pages with scoped reply permissions', async () => {
    const p = await page('buyerPeer')
    await p.goto(root + '/npi?view=procurement')
    await expect(p.locator('[data-workbench-project]')).toHaveCount(1)
    await p.locator('[data-workbench-project]').click()
    await expect(p.locator('[data-bom-row]')).toHaveCount(1)
    await expect(
      p.getByRole('button', { name: '项目资料与分配', exact: true }),
    ).toHaveCount(0)
    await p.reload()
    await expect(p.locator('[data-bom-row]')).toHaveCount(1)
    await p
      .getByRole('button', { name: '批量回复完成时间', exact: true })
      .click()
    const d = p.getByRole('dialog')
    await expect(d.locator('tbody tr')).toHaveCount(1)
    await d.locator('tbody input[type=date]').fill('2026-11-12')
    await d.getByRole('button', { name: '提交 1 项回复', exact: true }).click()
    await expect(d.getByRole('status')).toContainText('已回复 1')
    await d.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(p.locator('[data-bom-row]')).toContainText('2026-11-12')
    await p.setViewportSize({ width: 390, height: 844 })
    assert(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    await p.screenshot({
      path: 'runtime/test-evidence/workbench-procurement-mobile.png',
    })
    await p.context().close()
    const s = await page('supervisor')
    await s.goto(root + `/npi?view=purchasing&project=${id}&tab=bom`)
    await expect(s.locator('[data-bom-row]')).toHaveCount(100)
    await expect(
      s.getByRole('button', { name: '批量回复完成时间', exact: true }),
    ).toHaveCount(0)
    await expect(s.getByRole('button', { name: /回复PART/ })).toHaveCount(0)
    await s.context().close()
  })
  await test('admins add reusable motor types; creation uses a dropdown and order quantity', async () => {
    const p = await page('admin')
    await p.goto(root + '/npi?view=data')
    await p.getByLabel('新增电机类型').fill('高效防爆电机')
    await p.getByRole('button', { name: '添加类型', exact: true }).click()
    await expect(p.getByRole('status')).toContainText('电机类型已添加')
    await p
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '新品项目', exact: true })
      .click()
    await p.getByRole('button', { name: '新建新品', exact: true }).click()
    const d = p.getByRole('dialog')
    await d.getByLabel('电机类型', { exact: true }).selectOption('高效防爆电机')
    await d.getByLabel('订单台数', { exact: true }).fill('24')
    await d.getByLabel('电机型号', { exact: true }).fill('YBX-NEW')
    await d
      .getByLabel('技术负责人', { exact: true })
      .selectOption(f.actors.technical!.id)
    await d
      .getByLabel('制造负责人', { exact: true })
      .selectOption(f.actors.manufacturing!.id)
    await d.getByLabel('要求齐套日期', { exact: true }).fill('2026-11-20')
    await d.getByLabel('样机要求日期', { exact: true }).fill('2026-11-28')
    await d.getByRole('button', { name: '保存', exact: true }).click()
    await expect(d).toHaveCount(0)
    const projects = (await f.call('admin', '/dashboard')).projects
    const created = projects.find((r: any) => r.motorModel === 'YBX-NEW')
    assert(created)
    assert.equal(created.profile.orderQuantity, '24')
    assert.equal(created.profile.motorType, '高效防爆电机')
    await p.context().close()
    assert.deepEqual(errors, [])
  })
  await test('procurement project issues remain reachable even before any parts are assigned', async () => {
    const issueProject = await f.project()
    await f.call(
      'technical',
      `/projects/${issueProject}/issues`,
      'POST',
      {
        title: '供应商确认工艺问题',
        description: '未分配采购件时先确认供应商工艺',
        severity: 'Medium',
        ownerId: f.actors.outsider!.id,
        targetDate: '2026-11-10',
      },
      201,
    )
    const work = await f.call(
      'outsider',
      `/workbench/projects?kind=procurement&projectId=${issueProject}`,
    )
    assert.equal(work.project.counts.issues, 1)
    assert.equal(work.items.length, 0)
    assert.equal(work.rows.length, 0)
    await f.call('outsider', `/projects/${issueProject}`, 'GET', undefined, 403)
    const p = await page('outsider')
    await p.goto(root + '/npi?view=procurement')
    await expect(p.locator('[data-workbench-project]')).toHaveCount(1)
    await p.locator('[data-workbench-project]').click()
    await expect(
      p.getByText('供应商确认工艺问题', { exact: true }),
    ).toBeVisible()
    await p.context().close()
    assert.deepEqual(errors, [])
  })
  await test('deleted projects disappear and stale BOM rows cannot be replied from workbenches', async () => {
    await f.importBom(id, 110, true)
    const next = await f.call(
      'buyerPeer',
      `/workbench/projects?kind=procurement&projectId=${id}`,
    )
    assert.equal(next.project.counts.review, 1)
    assert.equal(next.items[0].bomReference.current, false)
    assert.equal(next.rows.length, 0)
    const current = await f.detail(id)
    await f.call('technical', `/projects/${id}/trash`, 'POST', {
      action: 'delete',
      confirmCode: current.code,
      expectedVersion: current.version,
      reason: '隔离测试结束',
    })
    assert.equal(
      (await f.call('buyerPeer', '/workbench/projects?kind=procurement'))
        .projects.length,
      0,
    )
    await f.call(
      'buyerPeer',
      `/workbench/projects?kind=procurement&projectId=${id}`,
      'GET',
      undefined,
      404,
    )
  })
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  if (log !== undefined) closeSync(log)
  await f.closeDatabase()
}
