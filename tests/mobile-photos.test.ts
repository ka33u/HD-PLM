import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
import {
  lifecyclePayload,
  photoForm,
  processPhoto,
} from './helpers/lifecycle-fixture'
const f = await deliveryFixture('hd_mobile_photos')
const { users } = await import('../src/lib/db/schema/users')
const { hashPassword } = await import('../src/lib/auth/accounts')
const password = 'Phone-test-' + crypto.randomUUID(),
  email = 'phone-' + crypto.randomUUID() + '@example.invalid'
await f.db
  .update(users)
  .set({ email, passwordHash: await hashPassword(password) })
  .where(eq(users.id, f.actors.technical!.id))
const pid = await f.project(),
  id = crypto.randomUUID()
await f.call('technical', `/projects/${pid}/lifecycle/${id}`, 'PUT', {
  ...lifecyclePayload('prototype'),
  action: 'draft',
  expectedVersion: 0,
})
const life = async () =>
  (await f.call('technical', `/projects/${pid}/lifecycle`)).records.find(
    (r: any) => r.id === id,
  )
const files = () => f.call('technical', `/files/lifecycle/${id}`)
let server: ReturnType<typeof spawn> | undefined,
  log: number | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await test('API rejects photo-free submission, ignores archived images, and keeps the current owner constraint', async () => {
    let r = await life()
    const blocked = await f.call(
      'technical',
      `/projects/${pid}/lifecycle/${id}`,
      'PUT',
      { ...r, expectedVersion: r.version, action: 'submit' },
      422,
    )
    assert.match(blocked.error, /照片/)
    await f.call(
      'manufacturing',
      `/files/lifecycle/${id}`,
      'POST',
      photoForm(r.version),
      403,
    )
    const photo = await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      photoForm(r.version),
      201,
    )
    r = await life()
    await f.call('technical', `/file-archive/${photo.id}`, 'POST', {
      reason: '测试旧照片被归档后不能满足提交',
      expectedRecordVersion: r.version,
    })
    r = await life()
    await f.call(
      'technical',
      `/projects/${pid}/lifecycle/${id}`,
      'PUT',
      { ...r, expectedVersion: r.version, action: 'submit' },
      422,
    )
    assert.equal((await files()).recordVersion, r.version)
  })
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const addr = probe.address()
  assert(addr && typeof addr !== 'string')
  const port = addr.port
  await new Promise<void>((r) => probe.close(() => r()))
  const root = `http://localhost:${port}`,
    target = `/npi?view=projects&project=${pid}&tab=overview`
  mkdirSync('runtime/test-evidence', { recursive: true })
  log = openSync('runtime/mobile-photo-server.log', 'w')
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage(),
    errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await test('mobile login returns to the project and remembers only the opted-in email', async () => {
    await page.goto(root + '/login?redirect=' + encodeURIComponent(target))
    await page.getByLabel('邮箱', { exact: true }).fill(email)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByLabel('记住邮箱', { exact: true }).check()
    await page.getByLabel('显示密码', { exact: true }).check()
    await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute(
      'type',
      'text',
    )
    assert.equal(
      await page
        .getByLabel('密码', { exact: true })
        .evaluate((e) => getComputedStyle(e).fontSize),
      '16px',
    )
    await page.screenshot({
      path: 'runtime/test-evidence/mobile-photo-login.png',
      mask: [
        page.getByLabel('邮箱', { exact: true }),
        page.getByLabel('密码', { exact: true }),
      ],
    })
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(
      page.getByRole('button', { name: /查看流程记录 样机确认验证/ }),
    ).toBeVisible()
    assert.equal(new URL(page.url()).searchParams.get('project'), pid)
    assert.equal(
      await page.evaluate(() => localStorage.getItem('npi-login-email')),
      email,
    )
    assert(
      !JSON.stringify(
        await page.evaluate(() => ({ ...localStorage })),
      ).includes(password),
    )
    await page
      .getByRole('button', { name: /查看流程记录 样机确认验证/ })
      .click()
    await page.getByRole('button', { name: '照片与报告', exact: true }).click()
    await expect(page.getByLabel('拍照选择')).toHaveAttribute(
      'capture',
      'environment',
    )
  })
  await test('two-photo batch survives a lost committed reply and retry saves exactly two files', async () => {
    await page.getByLabel('相册多选', { exact: true }).setInputFiles([
      { name: '样机整体.png', mimeType: 'image/png', buffer: processPhoto },
      { name: '样机铭牌.png', mimeType: 'image/png', buffer: processPhoto },
    ])
    await expect(
      page.getByRole('button', { name: '上传照片（2）', exact: true }),
    ).toBeEnabled()
    await page.getByLabel('照片 1 说明').fill('2026-11-07 样机01 整体')
    await expect(
      page.getByRole('button', { name: '提交结论', exact: true }),
    ).toBeDisabled()
    let intercepted = false
    await page.route(`**/api/v1/npi/files/lifecycle/${id}`, async (route) => {
      if (route.request().method() === 'POST' && !intercepted) {
        intercepted = true
        await route.fetch()
        await route.abort('failed')
      } else await route.continue()
    })
    await page
      .getByRole('button', { name: '上传照片（2）', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: '重试未确认照片（1）', exact: true }),
    ).toBeEnabled()
    assert.equal(
      (await files()).files.filter((x: any) => !x.archivedAt).length,
      2,
    )
    await page
      .getByRole('button', { name: '重试未确认照片（1）', exact: true })
      .click()
    await expect(
      page.getByText('本批 2 张照片已全部上传，可在下方查看。'),
    ).toBeVisible()
    assert.equal(
      (await files()).files.filter((x: any) => !x.archivedAt).length,
      2,
    )
    await expect(
      page.getByRole('button', { name: '提交结论', exact: true }),
    ).toBeEnabled()
    await page.screenshot({
      path: 'runtime/test-evidence/mobile-photos-uploaded.png',
    })
    const dialog = page.getByRole('dialog')
    assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1))
    await page
      .getByRole('button', {
        name: '查看照片：2026-11-07 样机01 整体',
        exact: true,
      })
      .click()
    const lightbox = page.getByRole('dialog').last()
    await expect(
      lightbox.getByRole('button', { name: '关闭预览', exact: true }),
    ).toBeVisible()
    await lightbox
      .getByRole('button', { name: '关闭预览', exact: true })
      .click()
    await page.getByRole('button', { name: '清除预览', exact: true }).click()
    await page.unroute(`**/api/v1/npi/files/lifecycle/${id}`)
  })
  await test('expired login keeps the queue and resumes after authenticating the same owner', async () => {
    await page.getByLabel('相册多选', { exact: true }).setInputFiles({
      name: '装配检查.png',
      mimeType: 'image/png',
      buffer: processPhoto,
    })
    await expect(
      page.getByRole('button', { name: '上传照片（1）', exact: true }),
    ).toBeEnabled()
    await context.clearCookies()
    await page
      .getByRole('button', { name: '上传照片（1）', exact: true })
      .click()
    const auth = page.getByRole('form', { name: '继续上传登录' })
    await expect(auth).toBeVisible()
    await expect(page.locator('.npi-photo-item')).toHaveCount(1)
    await auth.getByLabel('密码', { exact: true }).fill(password)
    await auth
      .getByRole('button', { name: '登录并保留照片', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: '重试未确认照片（1）', exact: true }),
    ).toBeEnabled()
    await page
      .getByRole('button', { name: '重试未确认照片（1）', exact: true })
      .click()
    await expect(
      page.getByText('本批 1 张照片已全部上传，可在下方查看。'),
    ).toBeVisible()
    assert.equal(
      (await files()).files.filter((x: any) => !x.archivedAt).length,
      3,
    )
    await page.getByRole('button', { name: '清除预览', exact: true }).click()
  })
  await test('large camera image is resized, unsupported formats explain the fix, and final submission freezes files', async () => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 4000
      canvas.height = 3000
      const c = canvas.getContext('2d')!
      c.fillStyle = '#eee'
      c.fillRect(0, 0, 4000, 3000)
      c.fillStyle = '#123456'
      c.font = '150px sans-serif'
      c.fillText('SAMPLE-01 1460 rpm', 100, 300)
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    await page.getByLabel('拍照选择').setInputFiles({
      name: 'camera.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    })
    await expect(
      page.getByRole('button', { name: '上传照片（1）', exact: true }),
    ).toBeEnabled()
    const dimensions = await page
      .locator('.npi-photo-item > img')
      .evaluate((e: HTMLImageElement) => [e.naturalWidth, e.naturalHeight])
    assert.deepEqual(dimensions, [2560, 1920])
    await page
      .getByRole('button', { name: '上传照片（1）', exact: true })
      .click()
    await expect(
      page.getByText('本批 1 张照片已全部上传，可在下方查看。'),
    ).toBeVisible()
    assert(
      (await files()).files.some(
        (x: any) => x.name === 'camera.jpg' && x.size < 2 * 1024 * 1024,
      ),
    )
    await page.getByRole('button', { name: '清除预览', exact: true }).click()
    await page.getByLabel('相册多选', { exact: true }).setInputFiles({
      name: 'image.heic',
      mimeType: 'image/heic',
      buffer: Buffer.from('unsupported fixture'),
    })
    await expect(page.getByText(/HEIC 请先转换为 JPG/)).toBeVisible()
    await page.getByRole('button', { name: '提交结论', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    assert.equal((await life()).status, 'submitted')
    await page
      .getByRole('button', { name: /查看流程记录 样机确认验证/ })
      .click()
    await expect(
      page.getByRole('button', { name: '拍照', exact: true }),
    ).toHaveCount(0)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    assert.deepEqual(errors, [])
  })
  await test('forced password change also returns to the originally requested project', async () => {
    await f.db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, f.actors.technical!.id))
    const second = await browser!.newContext({
        viewport: { width: 390, height: 844 },
      }),
      p = await second.newPage()
    await p.goto(root + '/login?redirect=' + encodeURIComponent(target))
    await p.getByLabel('邮箱', { exact: true }).fill(email)
    await p.getByLabel('密码', { exact: true }).fill(password)
    await p.getByRole('button', { name: '登录', exact: true }).click()
    await expect(p.getByLabel('原密码', { exact: true })).toBeVisible()
    await p.getByLabel('原密码', { exact: true }).fill(password)
    await p.getByLabel('新密码', { exact: true }).fill(password + 'Changed')
    await p.getByLabel('确认新密码', { exact: true }).fill(password + 'Changed')
    await p.getByRole('button', { name: '保存新密码', exact: true }).click()
    await p.getByRole('link', { name: '进入工作空间 →', exact: true }).click()
    await expect(
      p.getByRole('button', { name: /查看流程记录 样机确认验证/ }),
    ).toBeVisible()
    assert.equal(new URL(p.url()).searchParams.get('project'), pid)
    await second.close()
  })
  await context.close()
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  if (log !== undefined) closeSync(log)
  await f.closeDatabase()
}
