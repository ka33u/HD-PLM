// Continuous browser journey: no seeded accounts, sessions, projects or stage conclusions.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect, type Page } from '@playwright/test'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import ExcelJS from 'exceljs'
import { freshTestDatabase } from './helpers/fresh-database'
import {
  lifecycleDefinitions,
  type LifecycleKind,
} from '../src/lib/npi/lifecycle'
import {
  lifecyclePayload,
  processPdf,
  processPhoto,
} from './helpers/lifecycle-fixture'
import { today } from '../src/lib/npi/domain'

process.env.DATABASE_URL = await freshTestDatabase('hd_full_journey')
process.env.ATTACHMENT_ROOT = mkdtempSync(join(tmpdir(), 'hd-full-journey-'))
delete process.env.SETUP_TOKEN
const { db, closeDatabase } = await import('../src/lib/db')
const { seedNpiConfig } = await import('../src/lib/npi/service')
await migrate(db, { migrationsFolder: 'migrations' })
await seedNpiConfig()
const probe = createServer()
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
const address = probe.address()
assert(address && typeof address !== 'string')
const root = `http://localhost:${address.port}`
await new Promise<void>((resolve) => probe.close(() => resolve()))
const evidence = 'runtime/test-evidence/full-journey'
mkdirSync(evidence, { recursive: true })
const log = openSync(evidence + '/server.log', 'w')
const server = spawn(process.execPath, ['dist/server.mjs'], {
  env: {
    ...process.env,
    BASE_URL: root,
    HOST: '127.0.0.1',
    PORT: String(address.port),
  },
  stdio: ['ignore', log, log],
})
const people = Object.fromEntries(
  Object.entries({
    admin: '管理员',
    supervisor: '主管',
    technical: '设计负责人',
    otherTech: '设计同事',
    manufacturing: '生产负责人',
    mfgPeer: '生产同事',
    procurement: '采购负责人',
    buyerPeer: '采购同事',
  }).map(([key, name]) => [
    key,
    {
      name: '模拟-' + name,
      email: key.toLowerCase() + '@journey.test.invalid',
      password: 'Journey-' + crypto.randomUUID(),
      id: '',
    },
  ]),
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const pages: Record<string, Page> = {},
  errors: string[] = [],
  checkpoints: string[] = []
let projectId = '',
  currentStep = ''
const day = today(),
  due = today(new Date(Date.now() + 14 * 86400000))
const path = (tab = 'overview') =>
  `${root}/npi?view=projects&project=${projectId}&tab=${tab}`
async function read(page: Page, url: string) {
  const r = await page.request.get(root + '/api/v1/npi' + url)
  assert.equal(r.status(), 200, await r.text())
  return r.json()
}
async function identity(key: string, page: Page) {
  const r = await page.request.get(root + '/api/auth/me')
  assert.equal(r.status(), 200)
  people[key]!.id = (await r.json()).user.id
}
async function login(key: string, mobile = false) {
  const context = await browser!.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (e) => errors.push(key + ': ' + e.message))
  await page.goto(root + '/login')
  await page.getByLabel('邮箱', { exact: true }).fill(people[key]!.email)
  await page.getByLabel('密码', { exact: true }).fill(people[key]!.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '登录工作空间', exact: true }),
  ).toHaveCount(0)
  await identity(key, page)
  pages[key] = page
  return page
}
async function step(name: string, run: () => Promise<void>) {
  currentStep = name
  await run()
  checkpoints.push(name)
  writeFileSync(
    evidence + '/checkpoints.json',
    JSON.stringify(checkpoints, null, 2),
  )
  console.log('PASS journey: ' + name)
}
async function record(
  kind: LifecycleKind,
  title: string,
  result: 'pass' | 'fail' = 'pass',
) {
  const page = pages.technical!
  await page.getByRole('tab', { name: '项目流程', exact: true }).click()
  await page.getByRole('button', { name: '新增记录', exact: true }).click()
  const d = page.getByRole('dialog')
  await d.getByLabel('记录类型', { exact: true }).selectOption(kind)
  await d.getByLabel('记录标题', { exact: true }).fill(title)
  await d.getByLabel('计划日期', { exact: true }).fill(day)
  await d.getByLabel('实际记录日期', { exact: true }).fill(day)
  const payload = lifecyclePayload(kind, result)
  if (kind === 'test')
    Object.assign(payload.data.fields, {
      sampleId: '模拟样机 HD-J-001 / 图纸 V1 / BOM V1',
      basis: '模拟技术协议：绕组温升不超过80K，额定负载持续2小时',
      location: '模拟试验台01',
      witnesses: '模拟设计负责人、模拟试验记录员',
      environment: '25℃、相对湿度60%、卧式安装、风冷',
      powerLoad: '380V / 50Hz / 额定负载 / 持续2小时',
      instruments: '模拟测温仪T01，校准记录TEST-01有效',
      observations:
        result === 'fail'
          ? '温升85K，超过约定限值；停止试验并检查冷却通道。'
          : '整改后温升65K，连续运行平稳，无异常噪声。',
    })
  if (kind === 'trial')
    Object.assign(payload.data.fields, {
      customerContact: '模拟客户A / 联系人张工',
      sampleId: 'HD-J-001 / BOM V1',
      conditions: '380V、额定负载、累计运行48小时',
      feedback: '模拟客户确认运行正常，验收依据 TEST-CUSTOMER-01',
    })
  for (const field of lifecycleDefinitions[kind].fields)
    await d
      .getByLabel(field.label, { exact: true })
      .fill(payload.data.fields[field.key]!)
  if (kind === 'test') {
    await d.getByRole('button', { name: '添加测项', exact: true }).click()
    for (const [label, value] of [
      ['测项名称1', '绕组温升'],
      ['测项要求1', '≤80'],
      ['实测结果1', result === 'fail' ? '85' : '65'],
      ['测项单位1', 'K'],
    ])
      await d.getByLabel(label!, { exact: true }).fill(value!)
    await d.getByLabel('测项判定1', { exact: true }).selectOption(result)
  }
  await d.getByLabel('结论', { exact: true }).selectOption(result)
  await d
    .getByLabel('分析与最终结论说明', { exact: true })
    .fill(
      result === 'fail'
        ? '模拟验证：温升超过约定限值，应整改冷却通道后复测。'
        : '模拟验证：逐项核对记录和实测依据，满足本阶段要求。',
    )
  if (result === 'fail') {
    await d
      .getByLabel('后续措施', { exact: true })
      .fill('检查冷却通道并重新试验，原报告保留。')
    await d.getByLabel('下次跟进日期', { exact: true }).fill(due)
  }
  await d.getByRole('button', { name: '保存并添加照片', exact: true }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    d.getByRole('button', { name: '相册多选', exact: true }).click(),
  ])
  await chooser.setFiles({
    name: kind + '-模拟现场.png',
    mimeType: 'image/png',
    buffer: processPhoto,
  })
  await d.getByRole('button', { name: '上传照片（1）', exact: true }).click()
  await expect(
    d.getByText('本批 1 张照片已全部上传，可在下方查看。', { exact: true }),
  ).toBeVisible()
  if (kind === 'test' || kind === 'trial') {
    if (!(await d.getByLabel('选择文件或照片', { exact: true }).isVisible()))
      await d.getByText('上传报告或其他文件', { exact: true }).click()
    await d
      .getByLabel('文件分类', { exact: true })
      .selectOption(kind === 'test' ? 'report' : 'evidence')
    if (kind === 'test') {
      await d
        .getByLabel('报告分析', { exact: true })
        .fill(
          result === 'fail'
            ? '实测85K超过80K限值，不能判为通过，整改后复测。'
            : '整改后同工况实测65K，低于80K限值，原超限报告保持留存。',
        )
      await d.getByLabel('报告结论', { exact: true }).selectOption(result)
    }
    await d.getByLabel('选择文件或照片', { exact: true }).setInputFiles({
      name: kind === 'test' ? title + '.pdf' : '模拟客户反馈确认.pdf',
      mimeType: 'application/pdf',
      buffer: processPdf,
    })
    await d.getByRole('button', { name: '上传资料', exact: true }).click()
    await expect(
      d.getByRole('button', { name: '上传资料', exact: true }),
    ).toBeEnabled()
  }
  await d.getByRole('button', { name: '提交结论', exact: true }).click()
  await expect(d).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '查看流程记录 ' + title, exact: true }),
  ).toBeVisible()
}
async function advance(stage: string, label: string) {
  const page = pages.technical!
  await page.getByRole('tab', { name: '项目流程', exact: true }).click()
  await page
    .getByRole('button', { name: '推进阶段 · ' + label, exact: true })
    .click()
  const d = page.getByRole('dialog')
  if (stage === 'manufacturing')
    await d.getByLabel('图纸实际完成日期', { exact: true }).fill(day)
  await d.getByRole('button', { name: '保存', exact: true }).click()
  await expect(d).toHaveCount(0)
  assert.equal(
    (await read(page, `/projects/${projectId}`)).currentNpiStage,
    stage,
  )
}

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(root + '/api/health')).ok) break
    } catch {}
    await delay(200)
  }
  browser = await chromium.launch(process.env.CI ? {} : { channel: 'chrome' })
  await test('Eight real accounts complete registration, departmental delivery, failed test remediation, trial and closure', async () => {
    await step('首次初始化管理员与新增主管', async () => {
      const admin = await browser!.newPage({
        viewport: { width: 1440, height: 1000 },
      })
      pages.admin = admin
      admin.on('pageerror', (e) => errors.push(e.message))
      await admin.goto(root)
      await admin
        .getByLabel('管理员姓名', { exact: true })
        .fill(people.admin!.name)
      await admin
        .getByLabel('登录邮箱', { exact: true })
        .fill(people.admin!.email)
      await admin
        .getByLabel('设置密码', { exact: true })
        .fill(people.admin!.password)
      await admin
        .getByLabel('确认密码', { exact: true })
        .fill(people.admin!.password)
      await admin
        .getByRole('button', { name: '创建管理员并进入系统', exact: true })
        .click()
      await expect(
        admin.getByRole('heading', { name: '新品驾驶舱', exact: true }),
      ).toBeVisible()
      await identity('admin', admin)
      await admin
        .getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('button', { name: '系统设置', exact: true })
        .click()
      await admin.getByRole('button', { name: '新增账号', exact: true }).click()
      const d = admin.getByRole('dialog')
      await d.getByLabel('姓名', { exact: true }).fill(people.supervisor!.name)
      await d.getByLabel('邮箱', { exact: true }).fill(people.supervisor!.email)
      await d.getByLabel('业务岗位', { exact: true }).selectOption('supervisor')
      await d
        .getByLabel('临时密码', { exact: true })
        .fill(people.supervisor!.password)
      await d.getByRole('button', { name: '保存', exact: true }).click()
      await expect(d).toHaveCount(0)
    })
    await step('六名成员自行注册并由管理员审核部门', async () => {
      const visitor = await browser!.newPage({
        viewport: { width: 390, height: 844 },
      })
      for (const [key, category] of [
        ['technical', 'technical'],
        ['otherTech', 'technical'],
        ['manufacturing', 'manufacturing'],
        ['mfgPeer', 'manufacturing'],
        ['procurement', 'procurement'],
        ['buyerPeer', 'procurement'],
      ]) {
        const person = people[key!]!
        await visitor.goto(root + '/register')
        await visitor.getByLabel('姓名', { exact: true }).fill(person.name)
        await visitor.getByLabel('邮箱', { exact: true }).fill(person.email)
        await visitor
          .getByLabel('部门类别', { exact: true })
          .selectOption(category!)
        await visitor
          .getByLabel('设置密码', { exact: true })
          .fill(person.password)
        await visitor
          .getByLabel('确认密码', { exact: true })
          .fill(person.password)
        await visitor
          .getByRole('button', { name: '提交注册申请', exact: true })
          .click()
        await expect(
          visitor.getByRole('heading', { name: '注册申请已提交', exact: true }),
        ).toBeVisible()
      }
      await visitor.context().close()
      const admin = pages.admin!
      await admin.getByRole('button', { name: '刷新账号', exact: true }).click()
      for (const key of [
        'technical',
        'otherTech',
        'manufacturing',
        'mfgPeer',
        'procurement',
        'buyerPeer',
      ]) {
        await admin
          .getByLabel('查找账号', { exact: true })
          .fill(people[key]!.email)
        await admin
          .getByRole('button', { name: '审核注册', exact: true })
          .click()
        await admin
          .getByRole('dialog')
          .getByRole('button', { name: '确认开通', exact: true })
          .click()
        await expect(admin.getByRole('dialog')).toHaveCount(0)
        await expect(admin.locator('tbody tr')).toContainText('已启用')
      }
      await admin.getByLabel('查找账号', { exact: true }).fill('')
      for (const key of [
        'technical',
        'otherTech',
        'manufacturing',
        'mfgPeer',
        'procurement',
        'buyerPeer',
      ])
        await login(key, key === 'buyerPeer')
      const supervisor = await login('supervisor')
      await expect(
        supervisor.getByRole('heading', { name: '修改密码', exact: true }),
      ).toBeVisible()
      await supervisor
        .getByLabel('原密码', { exact: true })
        .fill(people.supervisor!.password)
      people.supervisor!.password = 'Changed-' + crypto.randomUUID()
      await supervisor
        .getByLabel('新密码', { exact: true })
        .fill(people.supervisor!.password)
      await supervisor
        .getByLabel('确认新密码', { exact: true })
        .fill(people.supervisor!.password)
      await supervisor
        .getByRole('button', { name: '保存新密码', exact: true })
        .click()
      await expect(supervisor.getByRole('status')).toContainText('密码已修改')
      await supervisor
        .getByRole('link', { name: '进入工作空间 →', exact: true })
        .click()
    })
    await step(
      '新开通人员无需刷新即可分配项目，订单和整机编码一致',
      async () => {
        const admin = pages.admin!
        await admin
          .getByRole('navigation', { name: '主导航', exact: true })
          .getByRole('button', { name: '新品项目', exact: true })
          .click()
        await admin
          .getByRole('button', { name: '新建新品', exact: true })
          .click()
        const d = admin.getByRole('dialog')
        await expect(
          d
            .getByLabel('技术负责人', { exact: true })
            .locator('option[value="' + people.technical!.id + '"]'),
        ).toHaveCount(1)
        await expect(
          d
            .getByLabel('制造负责人', { exact: true })
            .locator('option[value="' + people.manufacturing!.id + '"]'),
        ).toHaveCount(1)
        await d
          .getByLabel('电机类型', { exact: true })
          .selectOption('三相异步电动机')
        await d.getByLabel('订单台数', { exact: true }).fill('2')
        await d.getByLabel('电机型号', { exact: true }).fill('YE5-模拟全流程')
        await d.getByLabel('电机编码', { exact: true }).fill('HD-J-MOTOR')
        await d
          .getByLabel('技术负责人', { exact: true })
          .selectOption(people.technical!.id)
        await d
          .getByLabel('制造负责人', { exact: true })
          .selectOption(people.manufacturing!.id)
        await d.getByLabel('要求齐套日期', { exact: true }).fill(due)
        await d.getByLabel('样机要求日期', { exact: true }).fill(due)
        await d.getByRole('button', { name: '保存', exact: true }).click()
        await expect(d).toHaveCount(0)
        projectId = (await read(admin, '/dashboard')).projects.find(
          (p: any) => p.motorModel === 'YE5-模拟全流程',
        ).id
        const project = await read(admin, `/projects/${projectId}`)
        assert.equal(project.profile.orderQuantity, '2')
        assert.equal(
          project.items.find((i: any) => i.sourceType === 'WHOLE_MACHINE')
            .motorCode,
          'HD-J-MOTOR',
        )
      },
    )
    await step(
      '设计负责人导入真实Excel，全部BOM默认交生产；主管调整计划',
      async () => {
        const page = pages.technical!
        await page.goto(path('bom'))
        const workbook = new ExcelJS.Workbook(),
          sheet = workbook.addWorksheet('母件结构表-多阶')
        sheet.getCell('A4').value = 'HD-J-MOTOR'
        sheet.getCell('B4').value = '模拟全流程电机'
        sheet.getCell('C4').value = 'YE5-模拟全流程'
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
        sheet.getRow(6).values = [
          '+',
          10,
          'HD-PART-0',
          '模拟机壳',
          '规格A',
          1,
          '只',
          '领用',
          '生产',
        ]
        sheet.getRow(7).values = [
          '+',
          20,
          'HD-PART-1',
          '模拟轴承',
          '规格B',
          2,
          '只',
          '外购',
          '采购',
        ]
        await page.getByLabel('上传ERP BOM', { exact: true }).setInputFiles({
          name: '模拟全流程BOM.xlsx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
        })
        await page
          .getByRole('button', { name: '解析预览', exact: true })
          .click()
        await expect(
          page.getByRole('table', { name: 'BOM导入预览', exact: true }),
        ).toContainText('模拟轴承')
        await page
          .getByRole('button', { name: '下一步：解析确认', exact: true })
          .click()
        await page
          .getByRole('button', { name: '确认导入为新版本', exact: true })
          .click()
        await expect(
          page.getByRole('table', { name: '完整BOM明细', exact: true }),
        ).toContainText('模拟机壳')
        const p = await read(page, `/projects/${projectId}`)
        assert.equal(
          p.items.filter(
            (i: any) =>
              i.sourceType === 'ERP_BOM' &&
              i.ownerId === people.manufacturing!.id,
          ).length,
          2,
        )
        const supervisor = pages.supervisor!
        await supervisor.goto(path())
        await supervisor
          .getByRole('button', { name: '编辑项目信息', exact: true })
          .click()
        const d = supervisor.getByRole('dialog')
        await d.getByText('计划日期与负责人', { exact: true }).click()
        await d
          .getByLabel('要求齐套日期', { exact: true })
          .fill(today(new Date(Date.now() + 15 * 86400000)))
        await d
          .getByLabel('样机要求日期', { exact: true })
          .fill(today(new Date(Date.now() + 16 * 86400000)))
        await d
          .getByLabel('变更原因', { exact: true })
          .fill('模拟主管统筹试制排期，承诺仍由生产采购回复。')
        await d.getByRole('button', { name: '预览变更', exact: true }).click()
        await d.getByRole('button', { name: '确认变更', exact: true }).click()
        await expect(d).toHaveCount(0)
        await expect(
          supervisor.getByRole('button', { name: '新增记录', exact: true }),
        ).toHaveCount(0)
        await expect(
          supervisor.getByRole('button', { name: /^推进阶段/ }),
        ).toHaveCount(0)
        await page.reload()
      },
    )
    await step('生产转采购、手动添加工装及BOM外件', async () => {
      const mfg = pages.manufacturing!
      await mfg.goto(root + '/npi?view=manufacturing')
      await expect(mfg.locator('[data-workbench-project]')).toHaveCount(1)
      await mfg.locator(`[data-workbench-project="${projectId}"]`).click()
      await mfg.getByLabel('选择HD-PART-1第7行', { exact: true }).check()
      await mfg
        .getByRole('button', { name: '分配已选 1 项', exact: true })
        .click()
      const d = mfg.getByRole('dialog')
      await d
        .getByLabel('回复责任人', { exact: true })
        .selectOption(people.procurement!.id)
      await d
        .getByLabel('分配原因', { exact: true })
        .fill('模拟外购轴承由采购负责供货。')
      await d.getByRole('button', { name: '保存', exact: true }).click()
      await expect(d).toHaveCount(0)
      const tech = pages.technical!
      await tech.goto(path('manufacturing'))
      for (const [category, name] of [
        ['tooling', '模拟定位工装'],
        ['material', '模拟BOM外接线件'],
      ]) {
        await tech
          .getByRole('button', { name: '添加零件 / 工装', exact: true })
          .click()
        const d = tech.getByRole('dialog')
        await d.getByLabel('明细类别', { exact: true }).selectOption(category!)
        await d.getByLabel('明细名称', { exact: true }).fill(name!)
        await d.getByRole('button', { name: '保存', exact: true }).click()
        await expect(d).toHaveCount(0)
        await expect(tech.getByText(name!, { exact: true })).toBeVisible()
      }
    })
    await step('设计确认、现场依据照片和阶段推进', async () => {
      const tech = pages.technical!
      await record('design', '模拟设计基线确认')
      await advance('manufacturing', '制造准备')
      for (const key of ['admin', 'supervisor', 'manufacturing']) {
        await pages[key]!.goto(path())
        await expect(
          pages[key]!.getByRole('button', { name: '新增记录', exact: true }),
        ).toHaveCount(0)
      }
      const outsider = pages.otherTech!
      await outsider.goto(path())
      await expect(
        outsider.getByRole('region', { name: '新品全流程跟踪', exact: true }),
      ).toHaveCount(0)
      assert.equal(
        (
          await outsider.request.get(root + `/api/v1/npi/projects/${projectId}`)
        ).status(),
        403,
      )
      await tech.screenshot({
        path: evidence + '/design-completed.png',
        fullPage: true,
      })
    })
    await step(
      '生产和采购同部门成员批量回复与确认完成，保留实际办理人',
      async () => {
        for (const [key, role, count] of [
          ['mfgPeer', 'manufacturing', 4],
          ['buyerPeer', 'procurement', 1],
        ] as const) {
          const page = pages[key]!
          await page.goto(root + '/npi?view=' + role)
          await expect(page.locator('[data-workbench-project]')).toHaveCount(1)
          await page.locator(`[data-workbench-project="${projectId}"]`).click()
          if (role === 'procurement') {
            await expect(page.locator('[data-bom-row]')).toHaveCount(1)
            assert.equal(
              (
                await page.request.get(
                  root + `/api/v1/npi/projects/${projectId}`,
                )
              ).status(),
              403,
            )
          }
          await page
            .getByRole('button', { name: '批量回复完成时间', exact: true })
            .click()
          const d = page.getByRole('dialog')
          await expect(d.locator('tbody input[type=date]')).toHaveCount(count)
          await d.getByLabel('本页可回复', { exact: true }).check()
          await d.getByLabel('统一填写日期', { exact: true }).fill(due)
          await d.getByRole('button', { name: '统一填入', exact: true }).click()
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
          await d.getByLabel('统一填写日期', { exact: true }).fill(day)
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
          if (role === 'procurement')
            await page.screenshot({
              path: evidence + '/procurement-mobile.png',
              fullPage: true,
            })
        }
        const project = await read(pages.technical!, `/projects/${projectId}`)
        assert.equal(project.items.length, 5)
        assert(
          project.items.every(
            (i: any) =>
              i.actualCompleteDate === day && i.firstCommittedDate === due,
          ),
        )
        assert(
          project.events.some((e: any) => e.actorId === people.mfgPeer!.id),
        )
        assert(
          project.events.some((e: any) => e.actorId === people.buyerPeer!.id),
        )
        await pages.technical!.reload()
        await record('manufacturing', '模拟试制准备核对')
        await advance('prototype', '样机制作')
        await record('prototype', '模拟样机与送试确认')
        await advance('test', '样机试验')
      },
    )
    await step('现场试验不通过，自动建问题、整改复测并闭环', async () => {
      const page = pages.technical!
      await record('test', '模拟温升超限初测', 'fail')
      let issues = await read(page, `/projects/${projectId}/issues`)
      assert.equal(issues.length, 1)
      assert.equal(issues[0].state, 'Open')
      await expect(
        page.getByRole('button', { name: '推进阶段 · 客户试用', exact: true }),
      ).toBeDisabled()
      await record('test', '模拟冷却整改后复测', 'pass')
      await expect(
        page.getByRole('button', { name: '推进阶段 · 客户试用', exact: true }),
      ).toBeDisabled()
      await page.getByRole('tab', { name: /^问题闭环/ }).click()
      await page
        .locator('.npi-issue-card')
        .filter({ hasText: issues[0].title })
        .click()
      const d = page.getByRole('dialog')
      for (const next of ['InProgress', 'Resolved', 'Verified', 'Closed']) {
        await d.getByLabel('推进状态', { exact: true }).selectOption(next)
        await d
          .getByLabel('处理说明', { exact: true })
          .fill('模拟整改：清理冷却通道，复测报告65K，核对现场条件后确认。')
        await d.getByRole('button', { name: '更新状态', exact: true }).click()
        await expect
          .poll(
            async () =>
              (await read(page, `/projects/${projectId}/issues`))[0].state,
          )
          .toBe(next)
      }
      await d.getByRole('button', { name: '关闭弹窗', exact: true }).click()
      await advance('trial', '客户试用')
      const records = (await read(page, `/projects/${projectId}/lifecycle`))
        .records
      assert.equal(
        records.filter(
          (r: any) => r.kind === 'test' && r.status === 'submitted',
        ).length,
        2,
      )
      assert(
        records.some(
          (r: any) => r.title === '模拟温升超限初测' && r.result === 'fail',
        ),
      )
    })
    await step('手机记录客户试用反馈、上传依据并定型结项', async () => {
      const page = pages.technical!
      await page.setViewportSize({ width: 390, height: 844 })
      await record('trial', '模拟客户连续运行反馈')
      await record('closure', '模拟定型与资料交接')
      await advance('completed', '定型结项')
      const final = await read(page, `/projects/${projectId}`)
      const records = (await read(page, `/projects/${projectId}/lifecycle`))
        .records
      assert.equal(records.length, 7)
      assert(records.every((r: any) => r.status === 'submitted'))
      assert.equal(final.currentNpiStage, 'completed')
      await expect(page.locator('.npi-process-notice')).toHaveCount(0)
      assert.equal(final.untrackedBomCount, 0)
      await expect(
        page.getByRole('button', { name: '新增记录', exact: true }),
      ).toHaveCount(0)
      await expect(
        page.getByRole('button', { name: '编辑项目信息', exact: true }),
      ).toHaveCount(0)
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      )
      const breadcrumb = await page.locator('.npi-breadcrumb').boundingBox()
      const accountLink = await page.locator('.account-shortcut').boundingBox()
      assert(breadcrumb && accountLink)
      assert(
        breadcrumb.x + breadcrumb.width < accountLink.x,
        '手机路径不得与账号入口重叠',
      )
      await page.screenshot({
        path: evidence + '/closed-mobile.png',
        fullPage: true,
      })
      for (const key of [
        'manufacturing',
        'mfgPeer',
        'procurement',
        'buyerPeer',
      ]) {
        await pages[key]!.reload()
        await expect(
          pages[key]!.getByRole('button', {
            name: '批量回复完成时间',
            exact: true,
          }),
        ).toHaveCount(0)
      }
    })
    await step('管理员停用成员后原会话立即失效，原业务审计仍保留', async () => {
      const admin = pages.admin!
      await admin
        .getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('button', { name: '系统设置', exact: true })
        .click()
      await admin
        .getByLabel('查找账号', { exact: true })
        .fill(people.buyerPeer!.email)
      await admin.getByRole('button', { name: '编辑账号', exact: true }).click()
      const d = admin.getByRole('dialog')
      await d.getByLabel('账号状态', { exact: true }).selectOption('false')
      await d
        .getByLabel('调整原因', { exact: true })
        .fill('模拟人员离岗，验证已登录设备和任务共享权限撤销。')
      await d.getByRole('button', { name: '保存', exact: true }).click()
      await expect(d).toHaveCount(0)
      await pages.buyerPeer!.reload()
      await expect(
        pages.buyerPeer!.getByRole('heading', {
          name: '登录工作空间',
          exact: true,
        }),
      ).toBeVisible()
      assert.equal(
        (
          await pages.buyerPeer!.request.get(root + '/api/v1/npi/meta')
        ).status(),
        401,
      )
      const final = await read(pages.technical!, `/projects/${projectId}`)
      assert(final.events.some((e: any) => e.actorId === people.buyerPeer!.id))
      assert.deepEqual(errors, [])
    })
  })
} catch (e) {
  throw e
} finally {
  for (const [key, page] of Object.entries(pages)) {
    if (page.isClosed()) continue
    await page
      .screenshot({
        path: `${evidence}/${key}-last.png`,
        fullPage: true,
        mask: [page.locator('input[type=password]')],
      })
      .catch(() => {})
  }
  writeFileSync(
    evidence + '/result.json',
    JSON.stringify(
      { currentStep, checkpoints, browserErrors: errors },
      null,
      2,
    ),
  )
  for (const context of browser?.contexts() || []) await context.close()
  await browser?.close()
  server.kill('SIGTERM')
  closeSync(log)
  await closeDatabase()
}
