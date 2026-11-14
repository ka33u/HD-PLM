import test from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
import {
  photoForm,
  seedLifecycleForLegacyTests,
} from './helpers/lifecycle-fixture'
import { today } from '../src/lib/npi/domain'
import {
  qualityFields,
  qualityCommonFields,
  type QualityKind,
} from '../src/lib/npi/quality'
const f = await deliveryFixture('hd_quality')
const { app } = await import('../src/server/app')
const { users } = await import('../src/lib/db/schema/users')
const { createSession } = await import('../src/lib/auth/session')
const { lifecycleGate } = await import('../src/lib/npi/lifecycle-service')
const pid = await f.project()
const payload = (kind: QualityKind = 'incoming') => ({
  id: crypto.randomUUID(),
  kind,
  title: qualityFields[kind][0]!.label + '检验',
  version: 0,
  performedDate: today(),
  result: 'pass',
  data: Object.fromEntries(
    [...qualityFields[kind], ...qualityCommonFields].map((x) => [
      x.key,
      x.key.includes('Quantity') || x.key === 'quantity'
        ? '2'
        : '测试依据与记录',
    ]),
  ),
})
const latest = async (id: string) =>
  (await f.call('quality', `/quality/projects/${pid}`)).records.find(
    (r: any) => r.id === id,
  )
const save = (r: any, action = 'save', status = 200, role = 'quality') =>
  f.call(role, `/quality/projects/${pid}`, 'POST', { ...r, action }, status)
const raw = (
  path: string,
  body?: unknown,
  actor: typeof f.actors.admin | null = f.actors.admin,
) =>
  app.request(
    'http://localhost:3490' + path,
    {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: 'http://localhost:3490',
        'content-type': 'application/json',
        ...(actor
          ? { cookie: 'session=' + actor.token, 'x-npi-actor': actor.id }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    {
      incoming: {
        socket: { remoteAddress: crypto.randomUUID(), remotePort: 12345 },
      },
    },
  )
try {
  await test('quality registration uses a department, requires approval, and cannot select elevated privileges', async () => {
    const choices = (await (await raw('/api/auth/register')).json()) as any
    const dept = choices.departments.find((d: any) => d.role === 'quality')
    assert(dept)
    const email = crypto.randomUUID() + '@quality.test.invalid',
      password = 'Quality-test-' + crypto.randomUUID()
    let response = await raw(
      '/api/auth/register',
      {
        name: '质量注册验证',
        email,
        password,
        confirmPassword: password,
        departmentId: dept.id,
        role: 'admin',
      },
      null,
    )
    assert.equal(response.status, 422)
    response = await raw(
      '/api/auth/register',
      {
        name: '质量注册验证',
        email,
        password,
        confirmPassword: password,
        departmentId: dept.id,
      },
      null,
    )
    assert.equal(response.status, 201, await response.text())
    let [u] = await f.db.select().from(users).where(eq(users.email, email))
    assert(!u!.active)
    response = await raw(`/api/accounts/${u!.id}/registration`, {
      decision: 'approve',
      departmentId: dept.id,
      expectedVersion: u!.version,
      reason: '质量岗位验证',
    })
    assert.equal(response.status, 200, await response.text())
    f.actors.registered = {
      id: u!.id,
      token: (await createSession(u!.id)).sessionToken,
    }
    assert.equal((await f.call('registered', '/meta')).actor.role, 'quality')
    assert(
      (await f.call('registered', '/quality/projects')).some(
        (p: any) => p.id === pid,
      ),
    )
  })
  await test('scope separates quality writing from planning, procurement and unrelated projects', async () => {
    await f.call('quality', `/projects/${pid}`, 'GET', undefined, 403)
    await f.call(
      'procurement',
      `/quality/projects/${pid}`,
      'GET',
      undefined,
      403,
    )
    await f.call('quality', '/projects', 'POST', {}, 403)
    for (const role of ['technical', 'manufacturing', 'supervisor']) {
      assert.equal(
        (await f.call(role, `/quality/projects/${pid}`)).canWrite,
        false,
      )
      await save(payload(), 'save', 403, role)
    }
    const noOwner = await f.call(
      'admin',
      '/projects',
      'POST',
      {
        name: '其他负责人项目',
        motorModel: '演示',
        technicalOwnerId: f.actors.admin!.id,
        manufacturingOwnerId: f.actors.nextMfg!.id,
        requiredKitDate: today(),
        prototypeRequiredDate: today(),
      },
      201,
    )
    await f.call(
      'technical',
      `/quality/projects/${noOwner.id}`,
      'GET',
      undefined,
      403,
    )
  })
  let r: any
  await test('incoming draft validates quantities, requires photos and permits colleagues to complete', async () => {
    await save(
      { ...payload(), data: { quantity: '1', sampleQuantity: '3' } },
      'save',
      422,
    )
    await save({ ...payload(), performedDate: '2099-01-01' }, 'save', 422)
    r = await save(payload())
    await save(r, 'submit', 422)
    await f.call(
      'technical',
      `/files/quality/${r.id}`,
      'POST',
      photoForm(r.version),
      403,
    )
    const form = photoForm(r.version)
    const file = await f.call(
      'quality',
      `/files/quality/${r.id}`,
      'POST',
      form,
      201,
    )
    const same = await f.call(
      'quality',
      `/files/quality/${r.id}`,
      'POST',
      form,
      201,
    )
    assert.equal(file.id, same.id)
    await save(r, 'submit', 409)
    r = await latest(r.id)
    const race = await Promise.allSettled([
      save(r, 'submit', 200, 'quality'),
      save(r, 'submit', 200, 'qualityPeer'),
    ])
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1)
    r = await latest(r.id)
    assert.equal(r.status, 'recorded')
    await save(r, 'save', 422)
    await f.call(
      'quality',
      `/files/quality/${r.id}`,
      'POST',
      photoForm(r.version),
      422,
    )
    assert.equal(
      (await f.call('technical', `/files/quality/${r.id}`)).canUpload,
      false,
    )
    assert.equal(
      (
        await raw(
          '/api/v1/npi/file-content/' + file.id,
          undefined,
          f.actors.technical,
        )
      ).status,
      200,
    )
    assert.equal(
      (await f.call('technical', `/files/project/${pid}`)).files.length,
      0,
    )
  })
  await test('sample report requires file, analysis and conclusion; archive/revision preserves evidence', async () => {
    let s = await save(payload('sample'))
    await f.call(
      'quality',
      `/files/quality/${s.id}`,
      'POST',
      photoForm(s.version),
      201,
    )
    s = await latest(s.id)
    await save(s, 'submit', 422)
    const form = new FormData()
    form.set(
      'file',
      new File(
        ['%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n'],
        '样机报告.pdf',
        { type: 'application/pdf' },
      ),
    )
    form.set('category', 'report')
    form.set('requestId', crypto.randomUUID())
    form.set('expectedRecordVersion', String(s.version))
    await f.call('quality', `/files/quality/${s.id}`, 'POST', form, 422)
    form.set('analysis', '样机各项实测值满足验收标准，未见异常。')
    form.set('conclusion', 'pass')
    const file = await f.call(
      'quality',
      `/files/quality/${s.id}`,
      'POST',
      form,
      201,
    )
    s = await latest(s.id)
    form.set('requestId', crypto.randomUUID())
    form.set('conclusion', 'fail')
    form.set('expectedRecordVersion', String(s.version))
    const failedReport = await f.call(
      'quality',
      `/files/quality/${s.id}`,
      'POST',
      form,
      201,
    )
    s = await latest(s.id)
    await save(s, 'submit', 422)
    await f.call('quality', `/file-archive/${failedReport.id}`, 'POST', {
      reason: '复检报告替代此前异常版，原件留存',
      expectedRecordVersion: s.version,
    })
    s = await latest(s.id)
    s = await save(s, 'submit')
    await save({ ...s, reason: '' }, 'reopen', 422)
    s = await save({ ...s, reason: '修订报告编号' }, 'reopen')
    await f.call('quality', `/file-archive/${file.id}`, 'POST', {
      reason: '旧版报告保留归档',
      expectedRecordVersion: s.version,
    })
    s = await latest(s.id)
    await save(s, 'submit', 422)
    assert.equal(
      (
        await raw(
          '/api/v1/npi/file-content/' + file.id,
          undefined,
          f.actors.quality,
        )
      ).status,
      200,
    )
    const history = await f.call('quality', `/quality/records/${s.id}/history`)
    assert(
      history.some(
        (h: any) =>
          h.action === 'QUALITY_REOPEN' && h.detail.reason === '修订报告编号',
      ),
    )
  })
  await test('quality abnormalities remind but never add blockers for any stage or closure', async () => {
    r = await save({ ...r, reason: '补充复检异常' }, 'reopen')
    r = await save(
      {
        ...r,
        result: 'fail',
        data: { ...r.data, action: '生产部返工，质量部复验' },
      },
      'submit',
    )
    assert.equal(
      (await f.call('technical', `/quality/projects/${pid}`)).openCount,
      1,
    )
    await seedLifecycleForLegacyTests(f.db, f.s, pid)
    await f.db
      .update(f.s.npiTrackingItems)
      .set({ actualCompleteDate: today() })
      .where(eq(f.s.npiTrackingItems.programId, pid))
    for (const stage of [
      'design',
      'manufacturing',
      'prototype',
      'test',
      'trial',
    ] as const) {
      await f.db
        .update(f.s.npiProjects)
        .set({ currentNpiStage: stage })
        .where(eq(f.s.npiProjects.programId, pid))
      const [p] = await f.db
        .select()
        .from(f.s.npiProjects)
        .where(eq(f.s.npiProjects.programId, pid))
      assert.deepEqual((await lifecycleGate(f.db, p!)).blockers, [], stage)
    }
    const p = await f.detail(pid)
    await f.call('technical', `/projects/${pid}/stage`, 'PATCH', {
      expectedVersion: p.version,
      currentNpiStage: 'completed',
      drawingCompleteDate: today(),
    })
    assert.equal(
      (await f.call('quality', `/quality/projects/${pid}`)).canWrite,
      false,
    )
    await save({ ...r, reason: '复验通过' }, 'resolve', 422)
  })
  await test('resolution, voiding, deletion and current role changes remain auditable and enforce access', async () => {
    await f.db
      .update(f.s.npiProjects)
      .set({ currentNpiStage: 'prototype' })
      .where(eq(f.s.npiProjects.programId, pid))
    r = await save(
      { ...r, reason: '返工后复验尺寸符合图纸 Q-01，附原异常原因已消除。' },
      'resolve',
      200,
      'qualityPeer',
    )
    assert.equal(r.exceptionStatus, 'closed')
    assert.equal(r.result, 'fail')
    r = await save({ ...r, reason: '重复录入，保留原报告' }, 'void')
    assert.equal(r.status, 'voided')
    await save(r, 'save', 422)
    await f.db
      .update(f.s.npiProjects)
      .set({ deletedAt: new Date() })
      .where(eq(f.s.npiProjects.programId, pid))
    await f.call('quality', `/quality/projects/${pid}`, 'GET', undefined, 404)
    assert(
      !(await f.call('quality', '/quality/projects')).some(
        (p: any) => p.id === pid,
      ),
    )
    await f.db
      .update(f.s.npiProjects)
      .set({ deletedAt: null })
      .where(eq(f.s.npiProjects.programId, pid))
    await f.db
      .update(f.s.npiUserRoles)
      .set({ role: 'procurement' })
      .where(eq(f.s.npiUserRoles.userId, f.actors.quality!.id))
    await f.call('quality', `/files/quality/${r.id}`, 'GET', undefined, 403)
  })
} finally {
  await f.closeDatabase()
}
