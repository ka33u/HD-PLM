import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
test('first-run setup supports desktop, mobile and remote initialization states', async ({
  page,
}) => {
  let access = 'local'
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, json: { setup: { required: true, access } } }),
  )
  for (const viewport of [
    { width: 1440, height: 1050 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/login')
    await expect(
      page.getByRole('heading', { name: '创建管理员账号', exact: true }),
    ).toBeVisible()
    await expect(page.getByLabel('管理员姓名', { exact: true })).toBeVisible()
    await expect(page.getByLabel('确认密码', { exact: true })).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  access = 'token'
  await page.reload()
  await expect(page.getByLabel('初始化密钥', { exact: false })).toBeVisible()
  access = 'unavailable'
  await page.reload()
  await expect(page.getByRole('status')).toContainText('请在服务器本机')
  await expect(
    page.getByRole('button', { name: '创建管理员并进入系统', exact: true }),
  ).toHaveCount(0)
})
test('built application paints login on desktop and phone without split context', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"请先登录"}',
    }),
  )
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/login')
    await expect(
      page.getByRole('heading', { name: '登录工作空间' }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: '登录', exact: true }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
  expect(errors).toEqual([])
  const scripts = readdirSync('dist/client/assets')
    .filter((f) => /^index-.*\.js$/.test(f))
    .map((f) => readFileSync('dist/client/assets/' + f, 'utf8'))
    .join('')
  expect(scripts.split('账号上下文未加载').length - 1).toBe(1)
  expect(scripts).not.toMatch(
    /useToast must be used within ToastProvider|useSidebar must be used/,
  )
})
test('authenticated first paint uses the same account provider', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'smoke',
          name: '测试人员',
          email: 'test@example.com',
          role: 'technical',
          mustChangePassword: false,
        },
      },
    }),
  )
  await page.goto('/account')
  await expect(
    page.getByRole('heading', { name: '测试人员', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '修改密码', exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('原密码', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
