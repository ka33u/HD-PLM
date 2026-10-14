import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { deliveryFixture } from './helpers/delivery-fixture'
const f = await deliveryFixture('hd_delivery_browser')
const probe = createServer()
await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
const address = probe.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((r) => probe.close(() => r()))
const root = 'http://localhost:' + port
mkdirSync('runtime/test-evidence', { recursive: true })
const log = openSync('runtime/delivery-browser-server.log', 'w')
const server = spawn(process.execPath, ['dist/server.mjs'], {
  env: { ...process.env, PORT: String(port), BASE_URL: root },
  stdio: ['ignore', log, log],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(root + '/api/health')).ok) break
    } catch {}
    await delay(200)
  }
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
  const pages: Record<string, any> = {},
    errors: string[] = []
  for (const role of [
    'technical',
    'manufacturing',
    'procurement',
    'supervisor',
  ]) {
    const c = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    })
    await c.addCookies([
      { name: 'session', value: f.actors[role]!.token, url: root },
    ])
    const p = await c.newPage()
    p.on('pageerror', (e: Error) => errors.push(e.message))
    pages[role] = p
  }
  const id = await f.project()
  await f.importBom(id)
  const url = (tab = 'bom') =>
    `${root}/npi?view=projects&project=${id}&tab=${tab}`
  await test('Manufacturing owns all imported BOM rows and can batch transfer selected parts to procurement in the UI', async () => {
    const p = pages.manufacturing
    await p.goto(url())
    await expect(p.getByRole('table', { name: '完整BOM明细' })).toBeVisible()
    await p.getByLabel('选择PART-0第6行', { exact: true }).check()
    await p.getByLabel('选择PART-1第7行', { exact: true }).check()
    await p
      .getByRole('button', { name: '批量分配 / 转采购', exact: true })
      .click()
    const d = p.getByRole('dialog')
    await d
      .getByLabel('回复责任人', { exact: true })
      .selectOption(f.actors.procurement!.id)
    await d
      .getByLabel('分配原因', { exact: true })
      .fill('外购零件交由采购统一回复')
    await d.getByRole('button', { name: '保存', exact: true }).click()
    await expect(d).toHaveCount(0)
    assert.equal(
      (await f.detail(id)).items.filter(
        (i: any) => i.ownerId === f.actors.procurement!.id,
      ).length,
      2,
    )
    await p.screenshot({
      path: 'runtime/test-evidence/delivery-bom-desktop.png',
      fullPage: true,
    })
  })
  await test('Tooling can be added manually, saves once, and joins the same delivery list; dirty forms preserve input', async () => {
    const p = pages.technical
    await p.goto(url('manufacturing'))
    await p
      .getByRole('button', { name: '添加零件 / 工装', exact: true })
      .click()
    const d = p.getByRole('dialog')
    await d.getByLabel('明细类别', { exact: true }).selectOption('tooling')
    await d.getByLabel('明细名称', { exact: true }).fill('装配定位工装')
    await p.keyboard.press('Escape')
    await expect(d).toContainText('明细尚未保存')
    await d.getByRole('button', { name: '继续填写', exact: true }).click()
    await expect(d.getByLabel('明细名称', { exact: true })).toHaveValue(
      '装配定位工装',
    )
    await d.getByRole('button', { name: '保存', exact: true }).click()
    await expect(d).toHaveCount(0)
    await expect(p.getByText('装配定位工装', { exact: true })).toBeVisible()
    assert.equal(
      (await f.detail(id)).items.filter((i: any) => i.sourceType === 'TOOLING')
        .length,
      1,
    )
    await expect(p.getByText('集中回复', { exact: true })).toHaveCount(0)
    await expect(p.getByText('重点跟踪', { exact: true })).toHaveCount(0)
    await p.screenshot({
      path: 'runtime/test-evidence/delivery-list-desktop.png',
      fullPage: true,
    })
  })
  await test('Production replies to whole machine, parts and tooling together; procurement replies only to transferred parts', async () => {
    for (const [role, count] of [
      ['manufacturing', 4],
      ['procurement', 2],
    ] as const) {
      const p = pages[role]
      await p.goto(root + '/npi?view=' + role)
      await p.locator(`[data-workbench-project="${id}"]`).click()
      await p
        .getByRole('button', { name: '批量回复完成时间', exact: true })
        .click()
      const d = p.getByRole('dialog')
      await expect(d.locator('tbody input[type=date]')).toHaveCount(count)
      if (role === 'manufacturing') await expect(d).toContainText('整机完成')
      await d.getByLabel('本页可回复', { exact: true }).check()
      await d.getByLabel('统一填写日期', { exact: true }).fill('2026-11-10')
      await d.getByRole('button', { name: '统一填入', exact: true }).click()
      await p.keyboard.press('Escape')
      await expect(d).toContainText('填写未提交')
      await d.getByRole('button', { name: '继续填写', exact: true }).click()
      await d
        .getByRole('button', { name: `提交 ${count} 项回复`, exact: true })
        .click()
      await expect(d.getByRole('status')).toContainText(`已回复 ${count}`)
      await d
        .getByRole('button', {
          name: role === 'procurement' ? '实际到货' : '实际完成',
          exact: true,
        })
        .click()
      await d.getByLabel('本页可回复', { exact: true }).check()
      await d.getByLabel('统一填写日期', { exact: true }).fill('2026-09-01')
      await d.getByRole('button', { name: '统一填入', exact: true }).click()
      await d
        .getByRole('button', {
          name: `确认 ${count} 项已实际完成`,
          exact: true,
        })
        .click()
      await expect(d.getByRole('status')).toContainText(
        `已确认实际完成 ${count}`,
      )
      await d.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(d).toHaveCount(0)
    }
    assert.ok(
      (await f.detail(id)).items.every(
        (i: any) =>
          i.currentCommittedDate === '2026-11-10' &&
          i.actualCompleteDate === '2026-09-01',
      ),
    )
  })
  await test('Supervisor cannot reply; delivery layout fits mobile and navigation survives reload', async () => {
    const p = pages.supervisor
    await p.goto(url('manufacturing'))
    await expect(
      p.getByRole('tab', { name: '交付任务', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(
      p.getByRole('button', { name: '快速回复完成时间', exact: true }),
    ).toHaveCount(0)
    await p.setViewportSize({ width: 390, height: 844 })
    await p.reload()
    await expect(
      p.getByRole('tab', { name: '交付任务', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    await p.screenshot({
      path: 'runtime/test-evidence/delivery-mobile.png',
      fullPage: true,
    })
    assert.deepEqual(errors, [])
  })
} finally {
  await browser?.close()
  server.kill()
  closeSync(log)
  await f.closeDatabase()
}
