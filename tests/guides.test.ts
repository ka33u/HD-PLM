// SPDX-License-Identifier: AGPL-3.0-or-later
// Real session, binary-download and browser regression in an isolated database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rename, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
import { navigationFor } from '../src/components/npi/navigation'
import type { GuideCatalog } from '../src/lib/npi/guide-types'

const f = await deliveryFixture('hd_guides')
const { app } = await import('../src/server/app')
const { users } = await import('../src/lib/db/schema/users')
const { createSession } = await import('../src/lib/auth/session')
const request = (path: string, role?: string) =>
  app.request(`http://localhost:3490/api/v1/npi${path}`, {
    headers: role ? { cookie: `session=${f.actors[role]!.token}` } : {},
  })
let server: ReturnType<typeof spawn> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try {
  await test('catalog, original files and every preview require a current NPI session', async () => {
    for (const path of [
      '/guides',
      '/process-guide',
      '/guides/design/download/pptx',
      '/guides/design/download/pdf',
      '/guides/design/pages/1',
    ])
      assert.equal((await request(path)).status, 401, path)
    const [unassigned] = await f.db
      .insert(users)
      .values({
        email: 'no-role@guides.test.invalid',
        name: '未分配岗位',
        mustChangePassword: false,
      })
      .returning()
    const session = await createSession(unassigned!.id)
    assert.equal(
      (
        await app.request('http://localhost:3490/api/v1/npi/guides', {
          headers: { cookie: 'session=' + session.sessionToken },
        })
      ).status,
      403,
    )
    await f.db
      .update(users)
      .set({ active: false })
      .where(eq(users.id, f.actors.outsider!.id))
    assert.equal(
      (await request('/guides/design/pages/1', 'outsider')).status,
      401,
    )
    await f.db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, f.actors.nextMfg!.id))
    assert.equal(
      (await request('/guides/design/download/pptx', 'nextMfg')).status,
      403,
    )
  })

  await test('all five roles can read all three SOPs and download byte-identical originals', async () => {
    for (const role of [
      'admin',
      'supervisor',
      'technical',
      'manufacturing',
      'procurement',
    ]) {
      assert(navigationFor(role).includes('guides'))
      const catalog = (await f.call(role, '/guides')) as GuideCatalog
      assert.deepEqual(
        catalog.guides.map((x) => x.pages.length),
        [17, 12, 11],
      )
      assert(!('assets' in catalog.guides[0]!))
      for (const guide of catalog.guides) {
        for (const format of ['pptx', 'pdf']) {
          const r = await request(
            `/guides/${guide.id}/download/${format}`,
            role,
          )
          assert.equal(r.status, 200)
          assert.match(
            r.headers.get('content-disposition')!,
            /^attachment;.*filename\*=UTF-8''/,
          )
          assert.equal(r.headers.get('cache-control'), 'no-store')
          assert.deepEqual(
            Buffer.from(await r.arrayBuffer()),
            await readFile(`docs/sop/${guide.id}.${format}`),
          )
        }
      }
      assert.equal((await request('/process-guide', role)).status, 200)
    }
    const { guides } = (await f.call('technical', '/guides')) as GuideCatalog
    for (const guide of guides) {
      for (let i = 1; i <= guide.pages.length; i++) {
        const r = await request(`/guides/${guide.id}/pages/${i}`, 'procurement')
        assert.equal(r.status, 200)
        assert.equal(r.headers.get('content-type'), 'image/webp')
        assert.match(r.headers.get('content-disposition')!, /^inline;/)
        assert.deepEqual(
          Buffer.from(await r.arrayBuffer()),
          await readFile(`docs/sop/${guide.id}/${i}.webp`),
        )
      }
    }
  })

  await test('unknown paths and page numbers cannot read arbitrary files; missing assets have a readable error', async () => {
    for (const path of [
      '/guides/__proto__/download/pptx',
      '/guides/constructor/pages/1',
      '/guides/design/download/docx',
      '/guides/design/pages/0',
      '/guides/design/pages/18',
      '/guides/design/pages/1.5',
      '/guides/design/pages/-1',
      '/guides/design/pages/01',
      '/guides/design/pages/1%2F..%2F..%2F.env',
    ])
      assert.equal((await request(path, 'technical')).status, 404, path)
    const path = 'docs/sop/procurement/1.webp'
    await rename(path, path + '.test-backup')
    try {
      const r = await request('/guides/procurement/pages/1', 'procurement')
      assert.equal(r.status, 503)
      assert.equal((await r.json()).code, 'DOCUMENT_NOT_FOUND')
    } finally {
      await rename(path + '.test-backup', path)
    }
  })

  await test('department users can navigate, read, zoom and download on desktop and mobile', async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const address = probe.address()
    assert(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((r) => probe.close(() => r()))
    const root = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['dist/server.mjs'], {
      env: {
        ...process.env,
        BASE_URL: root,
        HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: 'pipe',
    })
    let logs = ''
    server.stderr?.on('data', (x) => {
      logs += x
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(root + '/api/health')
          .then((r) => r.ok)
          .catch(() => false)
      ) {
        ready = true
        break
      }
      if (server.exitCode !== null) throw new Error(logs)
      await delay(100)
    }
    assert(ready, logs)
    browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
    await mkdir('runtime/guides-qa', { recursive: true })
    for (const [role, id, department, count] of [
      ['technical', 'design', '设计部', 17],
      ['manufacturing', 'production', '生产部', 12],
      ['procurement', 'procurement', '采购部', 11],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      })
      await context.addCookies([
        { name: 'session', value: f.actors[role]!.token, url: root },
      ])
      let page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(root + '/npi')
      await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name: '流程与 SOP', exact: true })
        .click()
      await expect(page.locator('.npi-guide-card').first()).toContainText(
        department,
      )
      await page.screenshot({
        path: `runtime/guides-qa/${id}-catalog.png`,
        fullPage: true,
      })
      const card = page.getByRole('article').filter({
        has: page.getByRole('heading', { name: `${department}软件操作 SOP` }),
      })
      const dl = page.waitForEvent('download')
      await card.getByRole('button', { name: '下载 PPT', exact: true }).click()
      const download = await dl
      assert.equal(
        download.suggestedFilename(),
        `${department}软件操作SOP.pptx`,
      )
      const path = await download.path()
      assert(path)
      assert.deepEqual(
        await readFile(path),
        await readFile(`docs/sop/${id}.pptx`),
      )
      await card.getByRole('button', { name: '在线查看', exact: true }).click()
      await expect(
        page.getByRole('button', { name: '上一页', exact: true }),
      ).toBeDisabled()
      await expect
        .poll(() =>
          page
            .locator('.npi-guide-canvas img')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBe(2000)
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      await expect(page.getByLabel('选择页码')).toHaveValue('2')
      await page.getByLabel('选择页码').selectOption('4')
      await page.reload()
      await expect(page.getByLabel('选择页码')).toHaveValue('4')
      await expect
        .poll(() =>
          page
            .locator('.npi-guide-canvas img')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBe(2000)
      await page.screenshot({
        path: `runtime/guides-qa/${id}-reader.png`,
        fullPage: true,
      })
      await page.getByLabel('选择页码').selectOption(String(count))
      await expect(
        page.getByRole('button', { name: '下一页', exact: true }),
      ).toBeDisabled()
      await page.close()
      page = await context.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(root + `/npi?view=guides&guide=${id}&page=4`)
      await expect(page.getByLabel('选择页码')).toHaveValue('4')
      await expect
        .poll(() =>
          page
            .locator('.npi-guide-canvas img')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBe(2000)
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      await page
        .locator('.npi-guide-canvas img')
        .evaluate((img) => (img as HTMLImageElement).decode())
      await page.screenshot({
        path: `runtime/guides-qa/${id}-mobile.png`,
        fullPage: true,
      })
      await page.getByRole('button', { name: '放大查看', exact: true }).click()
      assert(
        await page
          .locator('.npi-guide-canvas')
          .evaluate((el) => el.scrollWidth > el.clientWidth),
      )
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      await page.getByRole('button', { name: '适应屏幕', exact: true }).click()
      // A failed preview remains recoverable rather than silently blank.
      await page.route('**/guides/' + id + '/pages/5?**', (route) =>
        route.abort(),
      )
      await page.getByLabel('选择页码').selectOption('5')
      await expect(
        page.getByRole('button', { name: '重新加载本页' }),
      ).toBeVisible()
      await page.unroute('**/guides/' + id + '/pages/5?**')
      await page.getByRole('button', { name: '重新加载本页' }).click()
      await expect
        .poll(() =>
          page
            .locator('.npi-guide-canvas img')
            .evaluate((img) => (img as HTMLImageElement).naturalWidth),
        )
        .toBe(2000)
      await page.getByRole('button', { name: '返回文件目录' }).click()
      const docx = page.waitForEvent('download')
      await page.getByRole('button', { name: '下载流程文件' }).click()
      assert.equal(
        (await docx).suggestedFilename(),
        '设计部新品跟踪管理程序.docx',
      )
      // Download failures stay on the page and expose a readable message.
      await page.route('**/guides/' + id + '/download/pdf', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: '测试文件暂不可用' }),
        }),
      )
      await page
        .locator(`.npi-guide-${id}`)
        .getByRole('button', { name: '下载 PDF', exact: true })
        .click()
      await expect(page.getByRole('alert')).toContainText('测试文件暂不可用')
      if (role === 'technical') {
        const projectId = await f.project()
        await page.goto(
          root + `/npi?view=projects&project=${projectId}&tab=overview`,
        )
        await page
          .locator('.npi-lifecycle-heading')
          .getByRole('button', { name: '流程与 SOP', exact: true })
          .click()
        await expect(page.locator('.npi-guide-card')).toHaveCount(3)
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
  })
} finally {
  await browser?.close()
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((r) => server!.once('exit', () => r()))
    server.kill('SIGTERM')
    await exited
  }
  await f.closeDatabase()
}
