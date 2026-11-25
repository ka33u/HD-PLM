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
  await test('empty records never block advancing; owner, sequence, dates and versions still apply', async () => {
    assert.equal((await f.detail(projectId)).lifecycle.pendingCount, 0)
    assert.deepEqual((await life()).gate.blockers, [])
    const p = await f.detail(projectId)
    for (const role of ['admin', 'supervisor', 'manufacturing', 'quality']) {
      await f.call(
        role,
        `/projects/${projectId}/stage`,
        'PATCH',
        {
          expectedVersion: p.version,
          currentNpiStage: 'manufacturing',
          drawingCompleteDate: today(),
        },
        403,
      )
      await f.call(
        role,
        `/projects/${projectId}/lifecycle/${crypto.randomUUID()}`,
        'PUT',
        { ...lifecyclePayload('design'), expectedVersion: 0, action: 'record' },
        403,
      )
    }
    await advance('prototype', 400)
    await f.call(
      'technical',
      `/projects/${projectId}/stage`,
      'PATCH',
      {
        expectedVersion: p.version,
        currentNpiStage: 'manufacturing',
        drawingCompleteDate: '2099-01-01',
      },
      422,
    )
    await advance('manufacturing')
    await f.call(
      'technical',
      `/projects/${projectId}/stage`,
      'PATCH',
      { expectedVersion: p.version, currentNpiStage: 'prototype' },
      409,
    )
    await advance('design', 400)
    await advance('prototype')
    await advance('test')
    await advance('trial')
    assert.equal((await life()).records.length, 0)
    await advance('completed', 409) // The whole-machine delivery remains unfinished.
    const all = await f.detail(projectId)
    await f.call('manufacturing', '/tracking/batch-reply', 'POST', {
      operation: 'complete',
      items: all.items.map((i: any) => ({
        id: i.id,
        expectedVersion: i.version,
        date: today(),
      })),
    })
    await advance('completed')
    assert.equal((await f.detail(projectId)).currentNpiStage, 'completed')
    await f.call(
      'technical',
      `/projects/${projectId}/lifecycle/${crypto.randomUUID()}`,
      'PUT',
      { ...lifecyclePayload('closure'), expectedVersion: 0, action: 'record' },
      400,
    )
  })
  await test('all six record kinds save with just title, date and content; files, results and detailed forms are optional', async () => {
    const pid = await f.project()
    for (const kind of [
      'design',
      'manufacturing',
      'prototype',
      'test',
      'trial',
      'closure',
    ]) {
      const id = crypto.randomUUID(),
        payload = {
          kind,
          title: kind + '简要记录',
          performedDate: today(),
          data: { fields: { summary: '已核对当前进展，下周继续跟踪。' } },
          expectedVersion: 0,
          action: 'record',
        }
      await f.call(
        'technical',
        `/projects/${pid}/lifecycle/${id}`,
        'PUT',
        { ...payload, performedDate: '2099-01-01' },
        422,
      )
      await f.call(
        'technical',
        `/projects/${pid}/lifecycle/${id}`,
        'PUT',
        { ...payload, data: { fields: { summary: '  ' } } },
        422,
      )
      await f.call(
        'technical',
        `/projects/${pid}/lifecycle/${id}`,
        'PUT',
        payload,
      )
      const r = await record(id, pid)
      assert.equal(r.status, 'recorded')
      assert.equal(r.result, '')
      assert.equal(r.files, 0)
      assert.deepEqual(r.missing, [])
    }
    assert.deepEqual((await life(pid)).gate.blockers, [])
    assert.equal((await f.detail(pid)).lifecycle.pendingCount, 0)
    assert.equal(
      (await f.call('technical', `/projects/${pid}/issues`)).length,
      0,
    )
  })
  await test('historical failures and unfinished drafts do not block progression; no conclusion creates an issue', async () => {
    const pid = await f.project(),
      id = await save('test', 'draft', 'fail', pid)
    await submit(id, {}, pid)
    const r = await record(id, pid)
    assert.equal(r.result, 'fail')
    assert.equal(r.issueId, null)
    await save('design', 'draft', 'continue', pid)
    for (const stage of ['manufacturing', 'prototype', 'test', 'trial']) {
      assert.deepEqual((await life(pid)).gate.blockers, [])
      const p = await f.detail(pid)
      await f.call('technical', `/projects/${pid}/stage`, 'PATCH', {
        expectedVersion: p.version,
        currentNpiStage: stage,
        drawingCompleteDate: today(),
      })
    }
    assert.equal(
      (await f.call('technical', `/projects/${pid}/issues`)).length,
      0,
    )
    await f.call(
      'technical',
      `/projects/${pid}/lifecycle/${id}`,
      'PUT',
      { ...r, expectedVersion: r.version, action: 'record' },
      409,
    )
  })
  await test('saved records are editable with optional attachments, optimistic versions and audited voiding', async () => {
    const pid = await f.project(),
      id = await save('test', 'draft', 'pass', pid),
      old = await record(id, pid)
    await f.call('technical', `/projects/${pid}/lifecycle/${id}`, 'PUT', {
      ...old,
      data: { fields: { summary: '简化编辑，原测项仍留存' } },
      expectedVersion: old.version,
      action: 'record',
    })
    let r = await record(id, pid)
    assert.deepEqual(r.data.measurements, old.data.measurements)
    assert.equal(r.data.fields.location, old.data.fields.location)
    const form = photoForm(r.version),
      file = await f.call(
        'technical',
        `/files/lifecycle/${id}`,
        'POST',
        form,
        201,
      )
    assert.equal(
      (await f.call('technical', `/files/lifecycle/${id}`, 'POST', form, 201))
        .id,
      file.id,
    )
    await f.call(
      'manufacturing',
      `/files/lifecycle/${id}`,
      'POST',
      photoForm(r.version),
      403,
    )
    await f.call(
      'technical',
      `/projects/${pid}/lifecycle/${id}`,
      'PUT',
      { ...r, expectedVersion: r.version, action: 'record' },
      409,
    )
    r = await record(id, pid)
    const results = await Promise.allSettled(
      [1, 2].map((n) =>
        f.call('technical', `/projects/${pid}/lifecycle/${id}`, 'PUT', {
          ...r,
          title: '并发修改' + n,
          expectedVersion: r.version,
          action: 'record',
        }),
      ),
    )
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1)
    r = await record(id, pid)
    await f.call('technical', `/file-archive/${file.id}`, 'POST', {
      reason: '替换模糊照片',
      expectedRecordVersion: r.version,
    })
    r = await record(id, pid)
    await f.call(
      'technical',
      `/projects/${pid}/lifecycle/${id}`,
      'PUT',
      { expectedVersion: r.version, action: 'cancel' },
      422,
    )
    await f.call('technical', `/projects/${pid}/lifecycle/${id}`, 'PUT', {
      expectedVersion: r.version,
      action: 'cancel',
      reason: '重复记录，保留原始内容',
    })
    assert.equal((await record(id, pid)).status, 'cancelled')
    await f.call(
      'technical',
      `/files/lifecycle/${id}`,
      'POST',
      photoForm(r.version + 1),
      400,
    )
    const events = await f.db
      .select()
      .from(f.s.npiEvents)
      .where(eq(f.s.npiEvents.objectId, id))
    assert(
      events.some((e) => e.action === 'LIFECYCLE_SAVED' && e.detail.before),
    )
    assert(events.some((e) => e.action === 'LIFECYCLE_CANCELLED'))
  })
  await test('manual issue closure, delivery completion and BOM review still protect project closure', async () => {
    projectId = await f.project()
    await f.importBom(projectId, 2)
    for (const stage of ['manufacturing', 'prototype', 'test'])
      await advance(stage)
    const issue = await f.call(
      'technical',
      `/projects/${projectId}/issues`,
      'POST',
      {
        title: '绕组温升偏高',
        description: '需调整冷却通道后复测。',
        severity: 'High',
        ownerId: f.actors.technical!.id,
        targetDate: today(),
      },
      201,
    )
    await advance('trial', 409)
    await closeIssue(issue.id)
    await advance('trial')
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
    // Simulate an unassigned current BOM row, independently of process notes.
    const task = p.items.find((i: any) => i.bomItemId)
    await f.db
      .update(f.s.npiTrackingItems)
      .set({ trackingEnabled: false, affectsKit: false })
      .where(eq(f.s.npiTrackingItems.id, task.id))
    await advance('completed', 409)
    await f.db
      .update(f.s.npiTrackingItems)
      .set({ trackingEnabled: true, affectsKit: true })
      .where(eq(f.s.npiTrackingItems.id, task.id))
    await advance('completed')
    assert.equal((await life()).records.length, 0)
  })
  await test('a failed audit atomically rolls back record and attachment changes', async () => {
    const pid = await f.project(),
      id = await save('design', 'record', '', pid),
      r = await record(id, pid)
    await f.db.execute(
      sql`create function fail_lifecycle_audit() returns trigger as $$ begin if NEW.action in ('FILE_UPLOADED','LIFECYCLE_SAVED') then raise exception 'isolated audit failure'; end if; return NEW; end; $$ language plpgsql`,
    )
    await f.db.execute(
      sql`create trigger lifecycle_audit_failure before insert on npi_events for each row execute function fail_lifecycle_audit()`,
    )
    try {
      await f.call(
        'technical',
        `/projects/${pid}/lifecycle/${id}`,
        'PUT',
        {
          ...r,
          title: '不会保存',
          expectedVersion: r.version,
          action: 'record',
        },
        500,
      )
      await f.call(
        'technical',
        `/files/lifecycle/${id}`,
        'POST',
        photoForm(r.version),
        500,
      )
      assert.equal((await record(id, pid)).version, r.version)
      assert.equal(
        (await f.call('technical', `/files/lifecycle/${id}`)).files.length,
        0,
      )
    } finally {
      await f.db.execute(
        sql`drop trigger lifecycle_audit_failure on npi_events`,
      )
      await f.db.execute(sql`drop function fail_lifecycle_audit()`)
    }
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
} finally {
  await f.closeDatabase()
}
