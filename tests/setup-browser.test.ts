import 'dotenv/config'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_setup_ui')
delete process.env.SETUP_TOKEN
const root = 'http://localhost:3495'
execFileSync(process.execPath, ['dist/setup.mjs'], {
  env: process.env,
  stdio: 'pipe',
})
mkdirSync('runtime/test-evidence', { recursive: true })
const log = openSync('runtime/test-evidence/setup-server.log', 'w')
const server = spawn(process.execPath, ['dist/server.mjs'], {
  stdio: ['ignore', log, log],
  env: { ...process.env, PORT: '3495', BASE_URL: root, HOST: '127.0.0.1' },
})
const browserServer = await chromium.launchServer({
  headless: true,
  ...(process.env.CI ? {} : { channel: 'chrome' }),
})
const browser = await chromium.connect(browserServer.wsEndpoint())
let failed = true
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
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  })
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
  })
  const page = await desktop.newPage(),
    phone = await mobile.newPage(),
    errors: string[] = []
  for (const p of [page, phone]) {
    p.on('pageerror', (error) => errors.push(error.message))
    await p.goto(root + '/npi')
    await expect(
      p.getByRole('heading', { name: '创建管理员账号', exact: true }),
    ).toBeVisible()
    await expect(p.getByLabel('初始化密钥', { exact: true })).toHaveCount(0)
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
  }
  await page.screenshot({
    path: 'runtime/test-evidence/setup-desktop.png',
    fullPage: true,
  })
  await phone.screenshot({
    path: 'runtime/test-evidence/setup-mobile.png',
    fullPage: true,
  })
  const email = crypto.randomUUID() + '@setup-ui.test.invalid',
    password = 'Chosen-' + crypto.randomUUID()
  await page.getByLabel('管理员姓名', { exact: true }).fill('首位管理员')
  await page.getByLabel('登录邮箱', { exact: true }).fill(email)
  await page.getByLabel('设置密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password + 'x')
  await page
    .getByRole('button', { name: '创建管理员并进入系统', exact: true })
    .click()
  await expect(page.getByRole('alert')).toHaveText('两次输入的密码不一致')
  await expect(page.getByLabel('设置密码', { exact: true })).toHaveAttribute(
    'type',
    'password',
  )
  await page.getByLabel('显示密码', { exact: true }).check()
  await expect(page.getByLabel('设置密码', { exact: true })).toHaveAttribute(
    'type',
    'text',
  )
  await page.getByLabel('显示密码', { exact: true }).uncheck()
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page
    .getByRole('button', { name: '创建管理员并进入系统', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: '新品驾驶舱', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('button', { name: '系统设置', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: '账号管理', exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('region', { name: '账号列表', exact: true })
      .locator('tbody tr'),
  ).toHaveCount(1)
  // A second visitor's already-open form must not create another administrator.
  await phone.getByLabel('管理员姓名', { exact: true }).fill('并发访问者')
  await phone
    .getByLabel('登录邮箱', { exact: true })
    .fill('other@setup-ui.test.invalid')
  await phone.getByLabel('设置密码', { exact: true }).fill(password)
  await phone.getByLabel('确认密码', { exact: true }).fill(password)
  await phone
    .getByRole('button', { name: '创建管理员并进入系统', exact: true })
    .click()
  await expect(phone.getByRole('alert')).toHaveText(
    '管理员已创建，请使用现有账号登录',
  )
  await phone
    .getByRole('button', { name: '刷新初始化状态', exact: true })
    .click()
  await expect(
    phone.getByRole('heading', { name: '登录工作空间', exact: true }),
  ).toBeVisible()
  await phone.getByLabel('邮箱', { exact: true }).fill(email)
  await phone.getByLabel('密码', { exact: true }).fill(password)
  await phone.getByRole('button', { name: '登录', exact: true }).click()
  await expect(
    phone.getByRole('heading', { name: '新品驾驶舱', exact: true }),
  ).toBeVisible()
  await page.getByRole('link', { name: '我的账号', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '登录工作空间', exact: true }),
  ).toBeVisible()
  assert.deepEqual(await (await fetch(root + '/api/auth/setup')).json(), {
    required: false,
    access: null,
  })
  assert.deepEqual(errors, [])
  console.log(
    'PASS: fresh desktop/mobile setup, password confirmation and visibility, automatic admin login, one account only, stale-form rejection, setup closure, subsequent login and logout.',
  )
  failed = false
} catch (error) {
  console.error(error)
  for (const [index, context] of browser.contexts().entries()) {
    const page = context.pages()[0]
    if (page)
      await page
        .screenshot({
          path: 'runtime/test-evidence/setup-failure-' + index + '.png',
          fullPage: true,
        })
        .catch(() => {})
  }
  throw error
} finally {
  server.kill('SIGTERM')
  closeSync(log)
  const deadline = setTimeout(() => process.exit(failed ? 1 : 0), 10000)
  await browser.close()
  await browserServer.close()
  clearTimeout(deadline)
}
