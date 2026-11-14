import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
import { photoForm, processPhoto } from './helpers/lifecycle-fixture'
import { today } from '../src/lib/npi/domain'
const f = await deliveryFixture('hd_quality_browser')
const { users } = await import('../src/lib/db/schema/users')
const { hashPassword } = await import('../src/lib/auth/accounts')
const email = 'quality-sop@example.invalid',
  password = 'Quality-test-' + crypto.randomUUID()
await f.db
  .update(users)
  .set({
    name: '质量检验员',
    email,
    passwordHash: await hashPassword(password),
  })
  .where(eq(users.id, f.actors.quality!.id))
await f.db
  .update(users)
  .set({ name: '设计项目负责人' })
  .where(eq(users.id, f.actors.technical!.id))
const pid = (
  await f.call(
    'technical',
    '/projects',
    'POST',
    {
      name: '永磁同步电动机',
      motorType: '永磁同步电动机',
      motorModel: 'TY-160M-4 15 kW',
      motorCode: 'HD-TY-160-001',
      orderQuantity: '3',
      technicalOwnerId: f.actors.technical!.id,
      manufacturingOwnerId: f.actors.manufacturing!.id,
      requiredKitDate: '2026-11-20',
      prototypeRequiredDate: '2026-11-28',
    },
    201,
  )
).id
await f.project()
await f.project()
let server: ReturnType<typeof spawn> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const save = (r: any, action = 'save') =>
  f.call('quality', `/quality/projects/${pid}`, 'POST', { ...r, action })
const latest = async (id: string) =>
  (await f.call('quality', `/quality/projects/${pid}`)).records.find(
    (r: any) => r.id === id,
  )
let incomingId = '',
  sampleId = ''
try {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const addr = probe.address()
  assert(addr && typeof addr !== 'string')
  const port = addr.port
  await new Promise<void>((r) => probe.close(() => r()))
  const root = `http://localhost:${port}`
  server = spawn(process.execPath, ['dist/server.mjs'], {
    env: { ...process.env, PORT: String(port), BASE_URL: root },
    stdio: 'ignore',
  })
  for (let i = 0; i < 80; i++) {
    if (
      await fetch(root + '/api/health')
        .then((r) => r.ok)
        .catch(() => false)
    )
      break
    await delay(150)
  }
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage()
  context.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mkdir('runtime/quality-qa', { recursive: true })
  await test('quality logs in to its own project workbench with clean navigation', async () => {
    await page.goto(root + '/login')
    await page.getByLabel('邮箱', { exact: true }).fill(email)
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '按项目维护检验与报告' }),
    ).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: '主导航' }).getByRole('button'),
    ).toHaveCount(2)
    await page.screenshot({
      path: 'runtime/quality-qa/01-projects.png',
      fullPage: true,
    })
    await page
      .locator('.quality-project')
      .filter({ hasText: 'TY-160M-4' })
      .click()
    await expect(
      page.getByRole('button', { name: '新增来料检验' }),
    ).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`view=quality&project=${pid}`))
    await page.reload()
    await expect(
      page.getByRole('button', { name: '新增来料检验' }),
    ).toBeVisible()
  })
  await test('incoming inspection saves fields, photos, submits, and closes an exception without replacing original result', async () => {
    await page.getByRole('button', { name: '新增来料检验' }).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByLabel('记录标题', { exact: true })
      .fill('驱动端轴承来料检验')
    await dialog.getByLabel('检验结论', { exact: true }).selectOption('fail')
    for (const [label, value] of Object.entries({
      物料编码: 'BRG-6208',
      '物料名称 / 规格': '深沟球轴承 6208-2RS',
      供应商: '演示供应商 A',
      来料批次: '20261114-A01',
      来料数量: '30',
      检验数量: '5',
      现场检验人: '质量检验员',
      '检验依据 / 验收标准':
        '采购技术要求 Q-6208：外观无磕碰，尺寸按图纸验收。',
      '检验项目、实测值与判定':
        '抽检 5 件：4 件合格，1 件外圈可见磕碰；隔离异常件并复核同批次。',
      异常说明与跟进安排: '采购联系供应商换货；质量部复检并补充处置结论。',
    }))
      await dialog.getByLabel(label, { exact: true }).fill(value)
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(dialog.getByText('保存成功', { exact: true })).toBeVisible()
    incomingId = (await f.call('quality', `/quality/projects/${pid}`))
      .records[0].id
    assert.notEqual(
      await dialog
        .getByRole('button', { name: '提交记录', exact: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgba(0, 0, 0, 0)',
    )
    await page.screenshot({ path: 'runtime/quality-qa/02-incoming-form.png' })
    await dialog
      .locator('input[type=file][multiple]')
      .setInputFiles({
        name: '来料外观.png',
        mimeType: 'image/png',
        buffer: processPhoto,
      })
    await dialog.getByRole('button', { name: /上传照片（1）/ }).click()
    await expect(dialog.getByText(/本批 1 张照片已全部上传/)).toBeVisible()
    await dialog.getByRole('button', { name: '提交记录', exact: true }).click()
    await expect(
      dialog.getByText('记录已提交。异常仅提醒，不拦截项目流程。'),
    ).toBeVisible()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await expect(page.locator('.quality-notice')).toContainText(
      '1 项异常待处理',
    )
    await page.screenshot({
      path: 'runtime/quality-qa/03-incoming-list.png',
      fullPage: true,
    })
    await page.getByRole('button', { name: '查看记录', exact: true }).click()
    await dialog.getByRole('button', { name: '填写处置并关闭异常' }).click()
    await dialog
      .getByLabel('处置措施与复验结论', { exact: true })
      .fill(
        '供应商已更换异常件，复检 5 件外观与尺寸均符合采购技术要求 Q-6208。原不合格判定保留。',
      )
    await dialog.locator('.quality-reason').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'runtime/quality-qa/04-resolution.png' })
    await dialog.getByRole('button', { name: '确认关闭异常' }).click()
    await expect(dialog.getByText('保存成功', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    assert.equal((await latest(incomingId)).result, 'fail')
    assert.equal((await latest(incomingId)).exceptionStatus, 'closed')
  })
  await test('process and sample records support report analysis and revision in the actual UI', async () => {
    let r = await save({
      id: crypto.randomUUID(),
      version: 0,
      kind: 'process',
      title: '转子装配首件检验',
      performedDate: today(),
      result: 'pass',
      data: {
        materialCode: 'ROTOR-160',
        materialName: '转子总成',
        operation: '轴承压装后跳动检查',
        batch: 'RT-20261114-01',
        location: '装配一线',
        inspector: '质量检验员',
        basis: '图纸要求径向跳动 ≤ 0.03 mm。',
        findings: '实测 0.018 / 0.021 / 0.019 mm，均符合要求。',
        action: '',
      },
    })
    await f.call(
      'quality',
      `/files/quality/${r.id}`,
      'POST',
      photoForm(r.version),
      201,
    )
    r = await latest(r.id)
    await save(r, 'submit')
    await page.reload()
    await page.getByRole('button', { name: /过程检验/ }).click()
    await page.screenshot({
      path: 'runtime/quality-qa/05-process.png',
      fullPage: true,
    })
    await page.getByRole('button', { name: '查看记录', exact: true }).click()
    await page.screenshot({ path: 'runtime/quality-qa/06-process-detail.png' })
    await page.getByRole('button', { name: '返回列表' }).click()
    await page.getByRole('button', { name: /样机报告/ }).click()
    await page
      .getByRole('button', { name: '新增样机报告', exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('电机编码', { exact: true })).toHaveValue(
      'HD-TY-160-001',
    )
    for (const [label, value] of Object.entries({
      记录标题: 'TY-160 首台样机检验报告',
      '样机编号 / 序列号': 'TY160-001',
      报告编号: 'QA-TY160-20261114',
      检验地点: '样机检验区',
      '检验依据 / 验收标准':
        '样机技术协议与图纸 TY-160，外观、装配与绝缘项目。',
      '检验项目、实测值与判定':
        '外观与接线核对通过；绝缘电阻实测 520 MΩ，符合协议 ≥ 100 MΩ。',
    }))
      await dialog.getByLabel(label, { exact: true }).fill(value)
    await dialog.getByLabel('检验结论', { exact: true }).selectOption('pass')
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(dialog.getByText('保存成功', { exact: true })).toBeVisible()
    sampleId = (
      await f.call('quality', `/quality/projects/${pid}`)
    ).records.find((x: any) => x.kind === 'sample').id
    await dialog
      .locator('input[type=file][multiple]')
      .setInputFiles({
        name: '样机标识.png',
        mimeType: 'image/png',
        buffer: processPhoto,
      })
    await dialog.getByRole('button', { name: /上传照片（1）/ }).click()
    await expect(dialog.getByText(/本批 1 张照片已全部上传/)).toBeVisible()
    const form = dialog.locator('.npi-file-upload')
    await form
      .locator('input[type=file]')
      .setInputFiles({
        name: '样机检验报告.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(
          '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
        ),
      })
    await form
      .locator('textarea[name=analysis]')
      .fill(
        '样机外观、装配与绝缘检验符合技术协议；与现场实测记录一致，可提供项目负责人作为试验准备依据。',
      )
    await form.locator('select[name=conclusion]').selectOption('pass')
    await form.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'runtime/quality-qa/07-report-upload.png' })
    await form.getByRole('button', { name: /上传/ }).click()
    await expect(
      dialog.getByText('资料已上传成功，无需重复上传。'),
    ).toBeVisible()
    await dialog.getByRole('button', { name: '提交记录', exact: true }).click()
    await expect(
      dialog.getByText('记录已提交。异常仅提醒，不拦截项目流程。'),
    ).toBeVisible()
    await dialog.getByRole('button', { name: '撤回编辑' }).click()
    await dialog
      .getByLabel('修改 / 作废原因', { exact: true })
      .fill('追加样机复检报告，保留原报告与分析。')
    await dialog.getByRole('button', { name: '确认撤回编辑' }).click()
    await expect(dialog.getByText('保存成功', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '返回列表' }).click()
  })
  await test('project owner reads quality records but cannot write; phone uploads preserve the compact layout', async () => {
    const tech = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    await tech.addCookies([
      { name: 'session', value: f.actors.technical!.token, url: root },
    ])
    tech.setDefaultTimeout(10000)
    const owner = await tech.newPage()
    await owner.goto(root + `/npi?view=projects&project=${pid}&tab=quality`)
    await expect(owner.getByRole('heading', { name: /质量记录/ })).toBeVisible()
    await expect(
      owner.getByRole('button', { name: '新增来料检验' }),
    ).toHaveCount(0)
    await owner.screenshot({
      path: 'runtime/quality-qa/08-owner.png',
      fullPage: true,
    })
    const mobile = await browser!.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })
    await mobile.addCookies([
      { name: 'session', value: f.actors.quality!.token, url: root },
    ])
    mobile.setDefaultTimeout(10000)
    const phone = await mobile.newPage()
    await phone.goto(root + `/npi?view=quality&project=${pid}`)
    await expect(
      phone.getByRole('button', { name: '新增来料检验' }),
    ).toBeVisible()
    await phone.screenshot({
      path: 'runtime/quality-qa/09-mobile-list.png',
      fullPage: true,
    })
    assert(
      await phone.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    await phone.getByRole('button', { name: /样机报告/ }).click()
    await phone.getByRole('button', { name: '继续填写' }).click()
    await phone.locator('.npi-photo-upload').scrollIntoViewIfNeeded()
    await expect(phone.getByLabel('拍照选择')).toHaveAttribute(
      'capture',
      'environment',
    )
    await phone
      .locator('input[type=file][multiple]')
      .setInputFiles({
        name: '手机补拍.png',
        mimeType: 'image/png',
        buffer: processPhoto,
      })
    await phone.getByRole('button', { name: /上传照片（1）/ }).click()
    await expect(phone.getByText(/本批 1 张照片已全部上传/)).toBeVisible()
    await phone
      .getByRole('button', { name: '清除预览' })
      .click()
      .catch(() => {})
    await phone.locator('.npi-photo-upload').scrollIntoViewIfNeeded()
    await phone.screenshot({ path: 'runtime/quality-qa/10-mobile-upload.png' })
    await phone.getByRole('button', { name: '提交记录', exact: true }).click()
    await expect(
      phone.getByText('记录已提交。异常仅提醒，不拦截项目流程。'),
    ).toBeVisible()
    assert.deepEqual(errors, [])
  })
} finally {
  if (browser)
    for (const c of browser.contexts())
      for (const p of c.pages())
        await p
          .screenshot({
            path: 'runtime/quality-qa/debug-' + c.pages().indexOf(p) + '.png',
          })
          .catch(() => {})
  await browser?.close()
  server?.kill('SIGTERM')
  if (server?.exitCode === null)
    await new Promise((r) => server!.once('exit', r))
  await f.closeDatabase()
}
