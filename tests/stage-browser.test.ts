import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
import { processPdf } from './helpers/lifecycle-fixture'
import { today } from '../src/lib/npi/domain'

const f = await deliveryFixture('hd_stage_browser')
const { users } = await import('../src/lib/db/schema/users')
await f.db
  .update(users)
  .set({ name: '项目负责人 陈工（演示）' })
  .where(eq(users.id, f.actors.technical!.id))
const pid = (
  await f.call(
    'technical',
    '/projects',
    'POST',
    {
      name: '永磁同步电动机',
      motorModel: 'TY-160M-4 15 kW',
      motorCode: 'HD-TY160-01',
      orderQuantity: 3,
      technicalOwnerId: f.actors.technical!.id,
      manufacturingOwnerId: f.actors.manufacturing!.id,
      requiredKitDate: today(),
      prototypeRequiredDate: today(),
    },
    201,
  )
).id
const probe = createServer()
await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
const address = probe.address()
assert(address && typeof address !== 'string')
const root = `http://127.0.0.1:${address.port}`
await new Promise<void>((r) => probe.close(() => r()))
const server = spawn(process.execPath, ['dist/server.mjs'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(address.port),
    BASE_URL: root,
  },
  stdio: 'pipe',
})
let logs = ''
server.stderr.on('data', (x) => (logs += x))
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const shots = 'runtime/stage-qa'
mkdirSync(shots, { recursive: true })
try {
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
  assert(ready, logs)
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  context.setDefaultTimeout(10000)
  await context.addCookies([
    { name: 'session', value: f.actors.technical!.token, url: root },
  ])
  const page = await context.newPage(),
    errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const url = `${root}/npi?view=projects&project=${pid}&tab=overview`
  await test('owner advances without records, confirms the next stage and cannot skip stages', async () => {
    await page.goto(url)
    const next = page.getByRole('button', {
      name: '推进阶段 · 制造准备',
      exact: true,
    })
    await expect(next).toBeEnabled()
    await page.screenshot({
      path: shots + '/01-stage-overview.png',
      fullPage: true,
    })
    await next.click()
    const d = page.getByRole('dialog')
    await expect(d.getByLabel('图纸实际完成日期', { exact: true })).toHaveValue(
      today(),
    )
    await page.screenshot({
      path: shots + '/02-stage-confirm.png',
      fullPage: true,
    })
    await d.getByRole('button', { name: '确认推进', exact: true }).click()
    await expect(d).toHaveCount(0)
    await expect(
      page.locator('.npi-lifecycle-steps [aria-current="step"]'),
    ).toHaveText('制造准备')
    assert.equal(
      (await f.call('technical', `/projects/${pid}/lifecycle`)).records.length,
      0,
    )
  })
  await test('minimal notes save without conclusions or files; lost replies are reconciled without duplication', async () => {
    await page.getByRole('button', { name: '新增记录', exact: true }).click()
    const d = page.getByRole('dialog')
    await expect(d.getByLabel('记录日期', { exact: true })).toHaveValue(today())
    await expect(d.getByLabel('结论', { exact: true })).toHaveCount(0)
    await expect(d.locator('textarea')).toHaveCount(1)
    await d.getByLabel('记录标题', { exact: true }).fill('试制准备进展')
    await d
      .getByLabel('记录内容', { exact: true })
      .fill('工艺已核对，工装正在准备；下周与生产确认试制安排。')
    await page.screenshot({
      path: shots + '/03-simple-record.png',
      fullPage: true,
    })
    let intercepted = false
    await page.route(
      `**/api/v1/npi/projects/${pid}/lifecycle/*`,
      async (route) => {
        if (route.request().method() === 'PUT' && !intercepted) {
          intercepted = true
          await route.fetch()
          await route.abort('failed')
        } else await route.continue()
      },
    )
    await d.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(
      d.getByRole('button', { name: '核对服务器记录' }),
    ).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await d.getByRole('button', { name: '核对服务器记录' }).click()
    await expect(d.getByRole('alert')).toHaveCount(0)
    await page.unroute(`**/api/v1/npi/projects/${pid}/lifecycle/*`)
    await d.getByRole('button', { name: '关闭', exact: true }).click()
    let records = (await f.call('technical', `/projects/${pid}/lifecycle`))
      .records
    assert.equal(records.length, 1)
    assert.equal(records[0].files, 0)
    assert.equal(records[0].status, 'recorded')
    await page.screenshot({
      path: shots + '/04-record-list.png',
      fullPage: true,
    })
    await page
      .getByRole('button', { name: '查看流程记录 试制准备进展', exact: true })
      .click()
    await d
      .getByLabel('记录内容', { exact: true })
      .fill('工装已准备完成，生产正在核对首件。')
    await d.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(d).toHaveCount(0)
    records = (await f.call('technical', `/projects/${pid}/lifecycle`)).records
    assert.equal(records.length, 1)
    assert.match(records[0].data.fields.summary, /首件/)
  })
  await test('mobile optional uploads can be added after a note is saved; unsaved text is protected', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page
      .getByRole('button', { name: '查看流程记录 试制准备进展', exact: true })
      .click()
    const d = page.getByRole('dialog')
    await page.screenshot({ path: shots + '/05-mobile-note.png' })
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    assert(await d.evaluate((e) => e.scrollWidth <= e.clientWidth + 1))
    await d
      .getByRole('button', { name: '照片与附件（选填）', exact: true })
      .click()
    await expect(d.getByLabel('拍照选择')).toHaveAttribute(
      'capture',
      'environment',
    )
    await d.getByText('上传报告或其他文件', { exact: true }).click()
    await expect(d.getByLabel('报告分析', { exact: true })).toHaveCount(0)
    await d.getByLabel('选择文件或照片', { exact: true }).setInputFiles({
      name: '准备进展.pdf',
      mimeType: 'application/pdf',
      buffer: processPdf,
    })
    await d.getByRole('button', { name: '上传资料', exact: true }).click()
    await expect(
      d.getByText('资料已上传成功，无需重复上传。', { exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: shots + '/06-mobile-files.png' })
    await d.getByLabel('记录内容', { exact: true }).fill('尚未保存的现场补充')
    page.once('dialog', (x) => x.dismiss())
    await d.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(d).toBeVisible()
    await d.getByRole('button', { name: '保存记录', exact: true }).click()
    await expect(d).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 1000 })
  })
  await test('closure still requires deliveries; notes at each phase are optional and closed projects are read-only', async () => {
    for (const label of ['样机制作', '样机试验', '客户试用']) {
      await page
        .getByRole('button', { name: '推进阶段 · ' + label, exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: '确认推进', exact: true })
        .click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    await expect(
      page.getByRole('button', { name: '推进阶段 · 定型结项', exact: true }),
    ).toBeDisabled()
    await page.screenshot({
      path: shots + '/07-closure-check.png',
      fullPage: true,
    })
    const p = await f.detail(pid)
    await f.call('manufacturing', '/tracking/batch-reply', 'POST', {
      operation: 'complete',
      items: p.items.map((i: any) => ({
        id: i.id,
        expectedVersion: i.version,
        date: today(),
      })),
    })
    await page.reload()
    await page
      .getByRole('button', { name: '推进阶段 · 定型结项', exact: true })
      .click()
    await page.screenshot({
      path: shots + '/08-closure-confirm.png',
      fullPage: true,
    })
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '确认推进', exact: true })
      .click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.locator('.npi-lifecycle-steps [aria-current="step"]'),
    ).toHaveText('定型结项')
    await expect(
      page.getByRole('button', { name: '新增记录', exact: true }),
    ).toHaveCount(0)
    assert.equal((await f.detail(pid)).currentNpiStage, 'completed')
    assert.equal(
      (await f.call('technical', `/projects/${pid}/lifecycle`)).records.length,
      1,
    )
    await page.screenshot({ path: shots + '/09-completed.png', fullPage: true })
    assert.deepEqual(errors, [])
  })
  await test('supervisor and production view the same records without editing or advancing', async () => {
    for (const role of ['supervisor', 'manufacturing']) {
      const c = await browser!.newContext({
        viewport: { width: 1440, height: 1000 },
      })
      await c.addCookies([
        { name: 'session', value: f.actors[role]!.token, url: root },
      ])
      const p = await c.newPage()
      p.setDefaultTimeout(10000)
      await p.goto(url)
      await expect(
        p.getByRole('button', {
          name: '查看流程记录 试制准备进展',
          exact: true,
        }),
      ).toBeVisible()
      await expect(
        p.getByRole('button', { name: '新增记录', exact: true }),
      ).toHaveCount(0)
      await expect(p.getByRole('button', { name: /推进阶段 ·/ })).toHaveCount(0)
      await c.close()
    }
  })
  await context.close()
} finally {
  await browser?.close()
  if (server.exitCode === null) {
    const exit = new Promise<void>((r) => server.once('exit', () => r()))
    server.kill('SIGTERM')
    await exit
  }
  await f.closeDatabase()
}
