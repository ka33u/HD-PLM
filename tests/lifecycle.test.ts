import test from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { deliveryFixture } from './helpers/delivery-fixture'
import {
  lifecyclePayload,
  processPdf,
  processPhoto,
  photoForm,
} from './helpers/lifecycle-fixture'
import { lifecycleDefinitions } from '../src/lib/npi/lifecycle'
import { projectMatchesFilter } from '../src/lib/npi/project-dashboard'
import { today } from '../src/lib/npi/domain'
import type { LifecycleKind } from '../src/lib/npi/lifecycle'
const f = await deliveryFixture('hd_lifecycle')
const { app } = await import('../src/server/app')
let projectId = await f.project(),
  server: ReturnType<typeof spawn> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  log: number | undefined
const life = (id = projectId, role = 'technical') =>
  f.call(role, `/projects/${id}/lifecycle`)
const record = async (id: string, pid = projectId) =>
  (await life(pid)).records.find((r: any) => r.id === id)
async function save(
  kind: LifecycleKind,
  action = 'submit',
  result = 'pass',
  pid = projectId,
) {
  const id = crypto.randomUUID(),
    payload = lifecyclePayload(kind, result)
  await f.call('technical', `/projects/${pid}/lifecycle/${id}`, 'PUT', {
    ...payload,
    expectedVersion: 0,
    action: action === 'submit' ? 'draft' : action,
  })
  if (action === 'submit') {
    await photo(id, pid)
    await submit(id, {}, pid)
  }
  return id
}
async function photo(id: string, pid = projectId) {
  return f.call(
    'technical',
    `/files/lifecycle/${id}`,
    'POST',
    photoForm((await record(id, pid)).version),
    201,
  )
}
function upload(
  version: number,
  category = 'report',
  conclusion = 'pass',
  analysis = '逐项对照约定限值，试验数据及工况完整，未发现影响判定的偏差。',
) {
  const form = new FormData()
  form.set(
    'file',
    new File([processPdf], '现场试验报告.pdf', { type: 'application/pdf' }),
  )
  form.set('requestId', crypto.randomUUID())
  form.set('category', category)
  form.set('expectedRecordVersion', String(version))
  form.set('analysis', analysis)
  form.set('conclusion', conclusion)
  return form
}
async function submit(
  id: string,
  overrides = {},
  pid = projectId,
  status = 200,
) {
  const r = await record(id, pid)
  return f.call(
    'technical',
    `/projects/${pid}/lifecycle/${id}`,
    'PUT',
    { ...r, expectedVersion: r.version, action: 'submit', ...overrides },
    status,
  )
}
async function advance(stage: string, status = 200) {
  const p = await f.detail(projectId)
  return f.call(
    'technical',
    `/projects/${projectId}/stage`,
    'PATCH',
    {
      expectedVersion: p.version,
      currentNpiStage: stage,
      drawingCompleteDate: today(),
    },
    status,
  )
}
async function closeIssue(id: string) {
  for (const toState of ['InProgress', 'Resolved', 'Verified', 'Closed']) {
    const all = await f.call('technical', `/projects/${projectId}/issues`),
      issue = all.find((r: any) => r.id === id)
    await f.call('technical', `/issues/${id}/transition`, 'POST', {
      expectedVersion: issue.version,
      expectedModifiedAt: issue.modifiedAt,
      toState,
      comments: '已定位原因并完成整改，复测依据和验证结果确认。',
    })
  }
}
try {
  await test('only the current project owner writes records; drafts, versions and stage gates are enforced', async () => {
    await f.importBom(projectId, 2)
    const id = crypto.randomUUID(),
      payload = {
        ...lifecyclePayload('design'),
        expectedVersion: 0,
        action: 'draft',
      }
    for (const role of ['admin', 'supervisor', 'manufacturing', 'peer'])
      await f.call(
        role,
        `/projects/${projectId}/lifecycle/${id}`,
        'PUT',
        payload,
        403,
      )
    await f.call(
      'procurement',
      `/projects/${projectId}/lifecycle`,
      'GET',
      undefined,
      403,
    )
    await f.call('technical', `/projects/${projectId}/lifecycle/${id}`, 'PUT', {
      ...payload,
      data: { fields: {}, measurements: [] },
      performedDate: '',
    })
    await submit(id, {}, projectId, 422)
    await advance('manufacturing', 409)
    await photo(id)
    const old = await record(id)
    await f.call('technical', `/projects/${projectId}/lifecycle/${id}`, 'PUT', {
      ...payload,
      expectedVersion: old.version,
      action: 'submit',
    })
    await f.call(
      'technical',
      `/projects/${projectId}/lifecycle/${id}`,
      'PUT',
      { ...payload, expectedVersion: old.version },
      409,
    )
    const frozen = await record(id)
    await f.call(
      'technical',
      `/projects/${projectId}/lifecycle/${id}`,
      'PUT',
      { ...payload, expectedVersion: frozen.version },
      409,
    )
    assert((await life()).gate.blockers.length === 0)
    await advance('manufacturing')
    await save('manufacturing')
    await advance('prototype')
    await save('prototype')
    await advance('test')
  })
  await test('report upload requires analysis and conclusion, preserves retry identity, and failed tests generate one issue', async () => {
    const id = await save('test', 'draft', 'fail')
    await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      upload(1, 'report', 'fail', ''),
      422,
    )
    await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      upload(1, 'report', ''),
      422,
    )
    assert.equal(
      (await f.call('technical', `/files/lifecycle/${id}`)).files.length,
      0,
    )
    await f.call(
      'manufacturing',
      `/files/lifecycle/${id}`,
      'POST',
      upload(1),
      403,
    )
    const form = upload(
      1,
      'report',
      'fail',
      '转速超出约定限值，排查供电与参数设置后复测。',
    )
    const file = await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      form,
      201,
    )
    const same = await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      form,
      201,
    )
    assert.equal(file.id, same.id)
    assert.equal((await record(id)).version, 2)
    await photo(id)
    const r = await record(id)
    await submit(id, {
      data: {
        ...r.data,
        measurements: [
          { ...r.data.measurements[0], measured: '1500', verdict: 'fail' },
        ],
      },
    })
    const signed = await record(id)
    assert(signed.issueId)
    await f.call(
      'technical',
      `/projects/${projectId}/lifecycle/${id}`,
      'PUT',
      { ...r, expectedVersion: r.version, action: 'submit' },
      409,
    )
    assert.equal(
      (await f.call('technical', `/projects/${projectId}/issues`)).length,
      1,
    )
    await advance('trial', 409)
    await f.call(
      'technical',
      `/file-archive/${file.id}`,
      'POST',
      { reason: '试图覆盖已提交原报告', expectedRecordVersion: signed.version },
      400,
    )
    await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      upload(signed.version),
      400,
    )
    const passed = await save('test', 'draft')
    await f.call(
      'technical',
      `/files/lifecycle/${passed}`,
      'POST',
      upload(1),
      201,
    )
    await photo(passed)
    await submit(passed)
    await advance('trial', 409)
    await closeIssue(signed.issueId)
    const planned = await save('test', 'draft')
    await advance('trial', 409)
    await f.call(
      'technical',
      `/projects/${projectId}/lifecycle/${planned}`,
      'PUT',
      {
        expectedVersion: 1,
        action: 'cancel',
        reason: '相同试验已由上一份完整记录覆盖，取消重复计划',
      },
    )
    await advance('trial')
  })
  await test('customer follow-up, evidence and closure are separate from completion; no open issues or unfinished parts can be hidden', async () => {
    const trial = await save('trial', 'draft', 'continue')
    await submit(trial, {}, projectId, 422)
    await f.call(
      'technical',
      `/files/lifecycle/${trial}`,
      'POST',
      upload(1, 'evidence'),
      201,
    )
    await photo(trial)
    await submit(trial)
    const signed = await record(trial)
    assert(signed.issueId)
    const finalTrial = await save('trial', 'draft')
    await f.call(
      'technical',
      `/files/lifecycle/${finalTrial}`,
      'POST',
      upload(1, 'evidence'),
      201,
    )
    await photo(finalTrial)
    await submit(finalTrial)
    await save('closure')
    await advance('completed', 409)
    await closeIssue(signed.issueId)
    await advance('completed', 409)
    const p = await f.detail(projectId)
    await f.call('manufacturing', '/tracking/batch-reply', 'POST', {
      operation: 'complete',
      items: p.items.map((i: any) => ({
        id: i.id,
        expectedVersion: i.version,
        date: today(),
      })),
    })
    await advance('completed')
    assert.equal((await f.detail(projectId)).currentNpiStage, 'completed')
    assert.equal((await life()).canWrite, false)
    await f.call(
      'technical',
      `/projects/${projectId}/lifecycle/${crypto.randomUUID()}`,
      'PUT',
      { ...lifecyclePayload('test'), expectedVersion: 0, action: 'draft' },
      400,
    )
    assert.equal(
      (await life()).records.filter(
        (r: any) => r.kind === 'test' && r.status === 'submitted',
      ).length,
      2,
    )
  })
  await test('trial exemption needs a documented basis; report audit failures roll back files, versions and derived issues', async () => {
    const pid = await f.project(),
      id = await save('trial', 'draft', 'not_applicable', pid)
    await submit(id, {}, pid, 422)
    await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      upload(1, 'evidence'),
      201,
    )
    const r = await record(id, pid)
    await submit(
      id,
      {
        data: {
          ...r.data,
          fields: {
            summary: '代工件按客户确认检验交付，不进行整机客户试用。',
            waiverReason: '合同范围为零部件代工',
            customerConfirmation: '客户确认函 TEST-01',
          },
        },
      },
      pid,
    )
    assert.equal((await record(id, pid)).result, 'not_applicable')
    const fail = await save('test', 'draft', 'fail', pid)
    await f.db.execute(
      sql`create function fail_lifecycle_audit() returns trigger as $$ begin if NEW.action in ('FILE_UPLOADED','LIFECYCLE_SUBMITTED') then raise exception 'isolated lifecycle audit failure'; end if; return NEW; end; $$ language plpgsql`,
    )
    await f.db.execute(
      sql`create trigger lifecycle_audit_failure before insert on npi_events for each row execute function fail_lifecycle_audit()`,
    )
    await f.call(
      'technical',
      `/files/lifecycle/${fail}`,
      'POST',
      upload(1),
      500,
    )
    assert.equal((await record(fail, pid)).version, 1)
    assert.equal(
      (await f.call('technical', `/files/lifecycle/${fail}`)).files.length,
      0,
    )
    await f.db.execute(sql`drop trigger lifecycle_audit_failure on npi_events`)
    await f.call(
      'technical',
      `/files/lifecycle/${fail}`,
      'POST',
      upload(1, 'report', 'fail'),
      201,
    )
    await photo(fail, pid)
    await f.db.execute(
      sql`create trigger lifecycle_audit_failure before insert on npi_events for each row execute function fail_lifecycle_audit()`,
    )
    await submit(fail, {}, pid, 500)
    assert.equal((await record(fail, pid)).status, 'draft')
    assert.equal(
      (await f.call('technical', `/projects/${pid}/issues`)).length,
      0,
    )
    await f.db.execute(sql`drop trigger lifecycle_audit_failure on npi_events`)
    await f.db.execute(sql`drop function fail_lifecycle_audit()`)
    const invalid = await record(fail, pid)
    await submit(
      fail,
      {
        result: 'pass',
        data: {
          ...invalid.data,
          measurements: [{ ...invalid.data.measurements[0], verdict: 'fail' }],
        },
      },
      pid,
      422,
    )
  })
  await test('handover and trash re-evaluate record and file access; inheritance never copies lifecycle results', async () => {
    const pid = await f.project(),
      id = await save('test', 'draft', 'pass', pid)
    const file = await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      upload(1),
      201,
    )
    await photo(id, pid)
    const { users } = await import('../src/lib/db/schema/users'),
      { createSession } = await import('../src/lib/auth/session')
    const [u] = await f.db
      .insert(users)
      .values({
        email: crypto.randomUUID() + '@lifecycle.test.invalid',
        name: '新项目负责人',
        mustChangePassword: false,
      })
      .returning()
    await f.db
      .insert(f.s.npiUserRoles)
      .values({ userId: u!.id, role: 'technical' })
    f.actors.nextTech = {
      id: u!.id,
      token: (await createSession(u!.id)).sessionToken,
    }
    const before = await f.detail(pid),
      change = {
        expectedVersion: before.version,
        technicalOwnerId: u!.id,
        reason: '负责人交接',
      }
    const preview = await f.call(
      'technical',
      `/projects/${pid}/change-preview`,
      'POST',
      change,
    )
    await f.call('technical', `/projects/${pid}/plan`, 'PATCH', {
      ...change,
      expectedSnapshot: preview.expectedSnapshot,
    })
    await f.call(
      'technical',
      `/projects/${pid}/lifecycle`,
      'GET',
      undefined,
      403,
    )
    await f.call('technical', `/files/lifecycle/${id}`, 'GET', undefined, 403)
    assert.equal((await life(pid, 'nextTech')).canWrite, true)
    const r = (await life(pid, 'nextTech')).records[0]
    await f.call('nextTech', `/projects/${pid}/lifecycle/${id}`, 'PUT', {
      ...r,
      expectedVersion: r.version,
      action: 'submit',
    })
    const response = await app.request(
      `http://localhost:3490/api/v1/npi/file-content/${file.id}`,
      { headers: { cookie: 'session=' + f.actors.nextTech!.token } },
    )
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), processPdf)
    const inheritance = {
      code: 'LIFE-COPY-' + crypto.randomUUID(),
      name: '新订单',
      motorModel: 'LIFE-NEW',
      technicalOwnerId: u!.id,
      manufacturingOwnerId: f.actors.manufacturing!.id,
      requiredKitDate: '2026-12-01',
      prototypeRequiredDate: '2026-12-05',
      copyBom: true,
      copyExternal: true,
    }
    const ip = await f.call(
      'nextTech',
      `/projects/${pid}/inheritance-preview`,
      'POST',
      inheritance,
    )
    const copied = await f.call(
      'nextTech',
      `/projects/${pid}/inherit`,
      'POST',
      { ...inheritance, expectedSnapshot: ip.expectedSnapshot },
      201,
    )
    assert.equal((await life(copied.id, 'nextTech')).records.length, 0)
    assert.equal(
      (await f.call('nextTech', `/files/project/${copied.id}`)).files.length,
      0,
    )
    const p = await f.call('nextTech', `/projects/${pid}`)
    await f.call('nextTech', `/projects/${pid}/trash`, 'POST', {
      action: 'delete',
      confirmCode: p.code,
      expectedVersion: p.version,
      reason: '隔离验证删除访问',
    })
    await f.call(
      'nextTech',
      `/projects/${pid}/lifecycle`,
      'GET',
      undefined,
      404,
    )
    await f.call('nextTech', `/files/lifecycle/${id}`, 'GET', undefined, 404)
  })
  await test('homepage reminders clear when the current record is submitted', async () => {
    const pid = await f.project(),
      id = await save('design', 'draft', 'pass', pid)
    await f.db
      .update(f.s.npiLifecycleRecords)
      .set({ plannedDate: '2026-01-01' })
      .where(eq(f.s.npiLifecycleRecords.id, id))
    let d = await f.detail(pid)
    assert.equal(d.lifecycle.overdueCount, 1)
    assert.equal(d.lifecycle.pendingCount, 1)
    const dashboard = await f.call('technical', '/dashboard')
    const row = dashboard.projects.find((p: any) => p.id === pid)
    assert.equal(row.lifecycle.overdueCount, 1)
    assert.equal(projectMatchesFilter(row, 'risk', today()), true)
    assert.equal(projectMatchesFilter(row, 'overdue', today()), true)
    await photo(id, pid)
    await submit(id, {}, pid)
    d = await f.detail(pid)
    assert.equal(d.lifecycle.overdueCount, 0)
    assert.equal(d.lifecycle.pendingCount, 0)
  })
  await test('the signed-in process guide download matches the shipped Word file', async () => {
    const url = 'http://localhost:3490/api/v1/npi/process-guide'
    const response = await app.request(url, {
      headers: { cookie: 'session=' + f.actors.technical!.token },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type')!, /wordprocessingml/)
    assert.match(response.headers.get('Content-Disposition')!, /attachment/)
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      readFileSync('docs/设计部新品跟踪管理程序.docx'),
    )
    const denied = await app.request(url)
    assert.equal(denied.status, 401)
  })
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const address = probe.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((r) => probe.close(() => r()))
  const root = `http://localhost:${port}`
  mkdirSync('runtime/test-evidence', { recursive: true })
  log = openSync('runtime/lifecycle-server.log', 'w')
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
  await test('browser: five project tabs, owner-only onsite test entry, report analysis, immutable review and mobile layout', async () => {
    const pid = await f.project(),
      context = await browser!.newContext({
        viewport: { width: 1440, height: 960 },
      })
    await context.addCookies([
      { name: 'session', value: f.actors.technical!.token, url: root },
    ])
    const p = await context.newPage(),
      errors: string[] = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${root}/npi?view=projects&project=${pid}&tab=overview`)
    await expect(p.getByRole('tablist').first().getByRole('tab')).toHaveCount(5)
    await expect(
      p
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name: 'BOM管理', exact: true }),
    ).toHaveCount(0)
    await expect(
      p
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name: '报表看板', exact: true }),
    ).toHaveCount(0)
    await p.screenshot({
      path: 'runtime/test-evidence/lifecycle-project-desktop.png',
      fullPage: true,
    })
    await p.getByRole('button', { name: '新增记录', exact: true }).click()
    const d = p.getByRole('dialog')
    await d.getByLabel('记录类型', { exact: true }).selectOption('test')
    await d.getByLabel('记录标题', { exact: true }).fill('现场温升试验 01')
    await d.getByLabel('计划日期', { exact: true }).fill(today())
    await d.getByLabel('实际记录日期', { exact: true }).fill(today())
    const payload = lifecyclePayload('test')
    for (const field of lifecycleDefinitions.test.fields)
      await d
        .getByLabel(field.label, { exact: true })
        .fill(payload.data.fields[field.key]!)
    await d.getByRole('button', { name: '添加测项', exact: true }).click()
    for (const [label, value] of [
      ['测项名称1', '绕组温升'],
      ['测项要求1', '按技术协议判定'],
      ['实测结果1', '65'],
      ['测项单位1', 'K'],
    ])
      await d.getByLabel(label!, { exact: true }).fill(value!)
    await d.getByLabel('测项判定1', { exact: true }).selectOption('pass')
    await d.getByLabel('结论', { exact: true }).selectOption('pass')
    await d
      .getByLabel('分析与最终结论说明', { exact: true })
      .fill(
        '供电、负载和环境符合已确认方案，温升满足协议指标，同意进入后续验证。',
      )
    // Simulate a lost response after the server committed the first save.
    await p.route(
      `**/api/v1/npi/projects/${pid}/lifecycle/*`,
      async (route) => {
        await route.fetch()
        await route.abort('failed')
      },
      { times: 1 },
    )
    await d.getByRole('button', { name: '保存草稿', exact: true }).click()
    await expect(
      d.getByRole('button', { name: '核对服务器记录', exact: true }),
    ).toBeVisible()
    p.once('dialog', (dialog) => dialog.accept())
    await d.getByRole('button', { name: '核对服务器记录', exact: true }).click()
    assert.equal((await life(pid)).records.length, 1)

    await expect(d.getByLabel('选择文件或照片', { exact: true })).toBeVisible()
    await d
      .getByLabel('报告分析', { exact: true })
      .fill(
        '对照试验曲线和现场条件核查，65K 的实测温升满足协议限值，未发现需降额的偏差。',
      )
    await d.getByLabel('报告结论', { exact: true }).selectOption('pass')
    await d.getByLabel('选择文件或照片', { exact: true }).setInputFiles({
      name: '现场报告.pdf',
      mimeType: 'application/pdf',
      buffer: processPdf,
    })
    await d.getByRole('button', { name: '上传资料', exact: true }).click()
    await expect(
      d.getByRole('button', { name: '上传资料', exact: true }),
    ).toBeEnabled()
    await expect(d.getByText('现场报告.pdf', { exact: true })).toBeVisible()
    await p.screenshot({
      path: 'runtime/test-evidence/lifecycle-report-analysis.png',
    })
    await d.getByLabel('相册多选', { exact: true }).setInputFiles({
      name: '现场照片.png',
      mimeType: 'image/png',
      buffer: processPhoto,
    })
    await d.getByRole('button', { name: '上传照片（1）', exact: true }).click()
    await expect(
      d.getByText('本批 1 张照片已全部上传，可在下方查看。', { exact: true }),
    ).toBeVisible()
    await expect(
      d.getByRole('button', { name: '提交结论', exact: true }),
    ).toBeEnabled()
    await d.getByRole('button', { name: '提交结论', exact: true }).click()
    await expect(d).toHaveCount(0)
    await p
      .getByRole('button', {
        name: '查看流程记录 现场温升试验 01',
        exact: true,
      })
      .click()
    await expect(
      d.getByRole('button', { name: '提交结论', exact: true }),
    ).toHaveCount(0)
    await expect(d.getByLabel('现场地点', { exact: true })).toBeDisabled()
    await d.getByRole('button', { name: '关闭', exact: true }).click()
    await p.setViewportSize({ width: 390, height: 844 })
    assert(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    await p.screenshot({
      path: 'runtime/test-evidence/lifecycle-project-mobile.png',
      fullPage: true,
    })
    await p.getByRole('tab', { name: '资料与记录', exact: true }).click()
    await p.getByRole('button', { name: '承诺与动态', exact: true }).click()
    await p.reload()
    await expect(
      p.getByRole('tab', { name: '资料与记录', exact: true }),
    ).toHaveAttribute('data-state', 'active')
    assert.deepEqual(errors, [])
    await context.close()
    const supervisor = await browser!.newContext()
    await supervisor.addCookies([
      { name: 'session', value: f.actors.supervisor!.token, url: root },
    ])
    const view = await supervisor.newPage()
    await view.goto(`${root}/npi?view=projects&project=${pid}&tab=overview`)
    await expect(
      view.getByRole('button', { name: '新增记录', exact: true }),
    ).toHaveCount(0)
    await expect(view.getByRole('button', { name: /推进阶段/ })).toHaveCount(0)
    await supervisor.close()
  })
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  if (log !== undefined) closeSync(log)
  await f.closeDatabase()
}
