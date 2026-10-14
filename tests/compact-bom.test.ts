import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { deliveryFixture } from './helpers/delivery-fixture'
const f = await deliveryFixture('hd_compact_bom')
const probe = createServer()
await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
const address = probe.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((r) => probe.close(() => r()))
const root = 'http://localhost:' + port
mkdirSync('runtime/test-evidence', { recursive: true })
const log = openSync('runtime/compact-bom-server.log', 'w')
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
  const c = await browser.newContext({ viewport: { width: 1440, height: 960 } })
  await c.addCookies([
    { name: 'session', value: f.actors.manufacturing!.token, url: root },
  ])
  const p = await c.newPage(),
    errors: string[] = []
  p.on('pageerror', (e) => errors.push(e.message))
  const id = await f.project()
  await f.importBom(id, 65)
  const url = `${root}/npi?view=projects&project=${id}&tab=bom`
  await test('BOM has compact rows, a focused grid, and complete details without row action clutter', async () => {
    await p.goto(url)
    const rows = p.locator('[data-bom-row]')
    await expect(rows).toHaveCount(65)
    assert((await rows.first().boundingBox())!.height <= 36)
    await expect(rows.first().getByRole('button')).toHaveCount(2)
    await expect(
      p.getByRole('button', { name: '转交采购', exact: true }),
    ).toHaveCount(0)
    await p.getByLabel('查看PART-0第6行明细', { exact: true }).click()
    const d = p.getByRole('dialog')
    await expect(d).toContainText('规格0')
    await expect(d).toContainText('首次承诺')
    await expect(
      d.getByRole('button', { name: '转交采购', exact: true }),
    ).toBeVisible()
    await p.keyboard.press('Escape')
    await p.getByRole('button', { name: '专注明细', exact: true }).click()
    await expect(p.locator('.npi-project-summary')).toBeHidden()
    const metrics = await p.locator('.npi-bom-grid').evaluate((el) => {
      const b = el.getBoundingClientRect()
      return {
        height: b.height,
        visibleRows: [...el.querySelectorAll('tbody tr')].filter((r) => {
          const t = r.getBoundingClientRect()
          return t.top >= b.top && t.bottom <= Math.min(b.bottom, innerHeight)
        }).length,
      }
    })
    assert(metrics.visibleRows >= 16, JSON.stringify(metrics))
    writeFileSync(
      'runtime/test-evidence/compact-metrics.json',
      JSON.stringify(metrics, null, 2),
    )
    await p.screenshot({
      path: 'runtime/test-evidence/compact-bom-desktop.png',
    })
  })
  await test('Shift selection carries only selected parts into reply; Enter and Ctrl+D preserve dates and reschedule reasons', async () => {
    await p.getByLabel('选择PART-0第6行', { exact: true }).check()
    await p
      .getByLabel('选择PART-4第10行', { exact: true })
      .click({ modifiers: ['Shift'] })
    await expect(p.locator('.npi-bom-selection')).toContainText('已选 5 项')
    await p.getByLabel('生产完成时间快速回复', { exact: true }).click()
    const d = p.getByRole('dialog'),
      dates = d.locator('tbody input[type=date]')
    await expect(dates).toHaveCount(5)
    await expect(d).toContainText('已选 5 项')
    await dates.nth(0).fill('2026-11-10')
    await dates.nth(0).press('Enter')
    await expect(dates.nth(1)).toBeFocused()
    await dates.nth(1).press('Control+d')
    await expect(dates.nth(1)).toHaveValue('2026-11-10')
    await dates.nth(1).press('Shift+Enter')
    await expect(dates.nth(0)).toBeFocused()
    assert((await d.locator('tbody tr').first().boundingBox())!.height <= 42)
    await d.getByLabel('统一填写日期', { exact: true }).fill('2026-11-10')
    await d.getByRole('button', { name: '统一填入', exact: true }).click()
    await p.screenshot({
      path: 'runtime/test-evidence/compact-quick-desktop.png',
    })
    await d.getByRole('button', { name: '提交 5 项回复', exact: true }).click()
    await expect(d.getByRole('status')).toContainText('已回复 5')
    assert.equal(
      (await f.detail(id)).items.filter((r: any) => r.currentCommittedDate)
        .length,
      5,
    )
    await dates.nth(0).fill('2026-11-12')
    await expect(
      d.getByRole('button', { name: '提交 1 项回复', exact: true }),
    ).toBeDisabled()
    await d.getByLabel('统一改期原因', { exact: true }).fill('供应计划调整')
    await d.getByRole('button', { name: '提交 1 项回复', exact: true }).click()
    await expect(d.getByRole('status')).toContainText('已回复 1')
    const changed = (await f.detail(id)).items.find(
      (r: any) => r.currentCommittedDate === '2026-11-12',
    )
    assert.equal(changed.firstCommittedDate, '2026-11-10')
    await d.getByRole('button', { name: '关闭', exact: true }).click()
  })
  await test('Cross-page selection and two batches reply to 61 remaining tasks without losing hidden drafts', async () => {
    await p.getByLabel('生产完成时间快速回复', { exact: true }).click()
    const d = p.getByRole('dialog')
    await expect(d.locator('tbody tr')).toHaveCount(50)
    await d.getByLabel('每页显示', { exact: true }).selectOption('25')
    await d.getByRole('button', { name: '选择前50项', exact: true }).click()
    await expect(d).toContainText('已选 50 项')
    await d.getByLabel('统一填写日期', { exact: true }).fill('2026-11-15')
    await d.getByRole('button', { name: '统一填入', exact: true }).click()
    await d.getByLabel('搜索快速回复部件', { exact: true }).fill('PART-64')
    await expect(d).toContainText('50 项在当前筛选外')
    await d.getByLabel('搜索快速回复部件', { exact: true }).fill('')
    await d.getByRole('button', { name: '提交 50 项回复', exact: true }).click()
    await expect(d.getByRole('status').first()).toContainText('已回复 50')
    await expect(d.locator('tbody tr')).toHaveCount(11)
    await d.getByRole('button', { name: '选择前50项', exact: true }).click()
    await d.getByRole('button', { name: '统一填入', exact: true }).click()
    await d.getByRole('button', { name: '提交 11 项回复', exact: true }).click()
    await expect(d).toContainText('已回复 11')
    assert.equal(
      (await f.detail(id)).items.filter((r: any) => r.currentCommittedDate)
        .length,
      66,
    )
    await d.getByRole('button', { name: '关闭', exact: true }).click()
  })
  await test('A large selection continues with the unsaved batch and never reselects submitted parts', async () => {
    const project2 = await f.project()
    await f.importBom(project2, 65)
    await p.goto(`${root}/npi?view=projects&project=${project2}&tab=bom`)
    await p.getByLabel('选择本页可分配任务', { exact: true }).check()
    await p.getByLabel('生产完成时间快速回复', { exact: true }).click()
    const d = p.getByRole('dialog')
    await expect(d).toContainText('仅显示从 BOM 带入的 65 项')
    await expect(d).toContainText('已选 50 项')
    await d.getByLabel('统一填写日期', { exact: true }).fill('2026-11-16')
    await d.getByRole('button', { name: '统一填入', exact: true }).click()
    await d.getByRole('button', { name: '提交 50 项回复', exact: true }).click()
    await expect(d).toContainText('已选 15 项')
    await expect(d.locator('tbody tr')).toHaveCount(15)
    await expect(d.locator('tbody input[type=date]').first()).toBeFocused()
    await d.getByRole('button', { name: '统一填入', exact: true }).click()
    await d.getByRole('button', { name: '提交 15 项回复', exact: true }).click()
    await expect(d).toContainText('已选 0 项')
    assert.equal(
      (await f.detail(project2)).items.filter(
        (r: any) => r.currentCommittedDate,
      ).length,
      65,
    )
    await d.getByRole('button', { name: '关闭', exact: true }).click()
  })
  await test('Compact BOM remains usable on mobile without page overflow', async () => {
    await p.setViewportSize({ width: 390, height: 844 })
    await p.goto(url)
    await p.getByRole('button', { name: '完整BOM', exact: true }).click()
    await expect(p.locator('[data-bom-row]')).toHaveCount(65)
    assert(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    await p.getByLabel('查看PART-0第6行明细', { exact: true }).click()
    await expect(p.getByRole('dialog')).toContainText('规格0')
    await p.keyboard.press('Escape')
    await p.screenshot({ path: 'runtime/test-evidence/compact-bom-mobile.png' })
  })
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await delay(250)
  closeSync(log)
  await f.closeDatabase()
}
