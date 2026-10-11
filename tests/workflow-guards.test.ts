// SPDX-License-Identifier: AGPL-3.0-or-later
// Real requests against a fresh isolated database; no formal project is touched.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_workflow_guards')
const root = 'http://localhost:3493'
process.env.BASE_URL = root
const { db, closeDatabase } = await import('../src/lib/db')
const { users } = await import('../src/lib/db/schema/users')
const s = await import('../src/lib/db/schema/npi')
const { createSession } = await import('../src/lib/auth/session')
const { app } = await import('../src/server/app')
const { seedNpiConfig } = await import('../src/lib/npi/service')
await migrate(db, { migrationsFolder: 'migrations' })
await seedNpiConfig()

const actors: Record<string, { id: string; token: string }> = {}
for (const role of [
  'technical',
  'manufacturing',
  'procurement',
  'supervisor',
  'admin',
  'outsideBuyer',
  'sharedBuyer',
]) {
  const [u] = await db
    .insert(users)
    .values({
      email: crypto.randomUUID() + '@workflow.test.invalid',
      name: '流程验证-' + role,
      mustChangePassword: false,
    })
    .returning()
  await db.insert(s.npiUserRoles).values({
    userId: u!.id,
    role: (role === 'outsideBuyer' || role === 'sharedBuyer'
      ? 'procurement'
      : role) as 'technical',
  })
  actors[role] = { id: u!.id, token: (await createSession(u!.id)).sessionToken }
}
async function call(
  role: string,
  path: string,
  method = 'GET',
  data?: unknown,
  status = 200,
): Promise<any> {
  const a = actors[role]!,
    form = data instanceof FormData
  const response = await app.request(root + '/api/v1/npi' + path, {
    method,
    headers: {
      cookie: 'session=' + a.token,
      origin: root,
      'x-npi-actor': a.id,
      ...(form ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : form ? data : JSON.stringify(data),
  })
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}
let projectId = ''
const detail = () => call('technical', `/projects/${projectId}`)
async function importBom(qty: number) {
  const workbook = new ExcelJS.Workbook(),
    sheet = workbook.addWorksheet('母件结构表-多阶')
  sheet.getCell('A4').value = 'GUARD-MOTOR'
  sheet.getCell('B4').value = '流程回归电机'
  sheet.getCell('C4').value = 'GUARD-250M'
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
  for (let i = 0; i < 4; i++)
    sheet.getRow(i + 6).values = [
      '+',
      (i + 1) * 10,
      'GUARD-' + i,
      '受控部件' + i,
      '规格' + i,
      qty,
      '只',
      '外购',
      '采购',
    ]
  const form = new FormData()
  form.set(
    'file',
    new File(
      [new Uint8Array(await workbook.xlsx.writeBuffer())],
      'workflow.xlsx',
    ),
  )
  const preview = await call(
    'technical',
    `/projects/${projectId}/bom/import-preview`,
    'POST',
    form,
  )
  await call(
    'technical',
    `/projects/${projectId}/bom/import`,
    'POST',
    { previewToken: preview.previewToken },
    201,
  )
  return (await call('technical', `/projects/${projectId}/bom/tree`))
    .rows as any[]
}
let tracks: any[] = [],
  firstCompleted: any,
  completionRequest: any
try {
  projectId = (
    await call(
      'technical',
      '/projects',
      'POST',
      {
        name: 'BOM换版协同验证',
        motorModel: 'GUARD-250M',
        technicalOwnerId: actors.technical!.id,
        manufacturingOwnerId: actors.manufacturing!.id,
        requiredKitDate: '2026-11-20',
        prototypeRequiredDate: '2026-11-28',
      },
      201,
    )
  ).id
  await call('admin', '/departments', 'POST', {
    name: '采购协同验证组',
    role: 'procurement',
    memberIds: [actors.procurement!.id, actors.sharedBuyer!.id],
    expectedVersion: 0,
    reason: '验证同组回复权限',
  })
  const rows = await importBom(1)
  for (const row of rows)
    tracks.push(
      await call('technical', `/bom-items/${row.id}/tracking`, 'PATCH', {
        expectedVersion: 0,
        ownerId: actors.procurement!.id,
        requiredDate: '2026-11-20',
        trackingEnabled: true,
        affectsKit: true,
      }),
    )

  await test('Current BOM accepts authorized departmental replies and records the actual actor', async () => {
    tracks[0] = await call(
      'sharedBuyer',
      `/tracking/${tracks[0].id}/promise`,
      'POST',
      {
        expectedVersion: tracks[0].version,
        committedDate: '2026-11-10',
      },
    )
    assert.equal(tracks[0].firstCommittedDate, '2026-11-10')
    assert.equal(
      (await detail()).history.find((h: any) => h.objectId === tracks[0].id)
        .changedBy,
      actors.sharedBuyer!.id,
    )
    completionRequest = {
      expectedVersion: tracks[3].version,
      actualCompleteDate: '2026-09-01',
    }
    firstCompleted = await call(
      'procurement',
      `/tracking/${tracks[3].id}/complete`,
      'POST',
      completionRequest,
    )
    await importBom(2)
    assert.equal((await detail()).bomReviewCount, 3)
  })

  await test('Single replies and completions cannot bypass stale BOM review, including administrator or same-department requests', async () => {
    const before = await detail()
    for (const role of ['procurement', 'sharedBuyer', 'admin']) {
      const promise = await call(
        role,
        `/tracking/${tracks[0].id}/promise`,
        'POST',
        {
          expectedVersion: tracks[0].version,
          committedDate: '2026-11-12',
          reason: '旧页面尝试回复',
        },
        409,
      )
      assert.equal(promise.code, 'BOM_REVIEW_REQUIRED')
      const complete = await call(
        role,
        `/tracking/${tracks[1].id}/complete`,
        'POST',
        {
          expectedVersion: tracks[1].version,
          actualCompleteDate: '2026-09-01',
        },
        409,
      )
      assert.equal(complete.code, 'BOM_REVIEW_REQUIRED')
    }
    for (const role of ['supervisor', 'outsideBuyer', 'manufacturing']) {
      await call(
        role,
        `/tracking/${tracks[0].id}/promise`,
        'POST',
        {
          expectedVersion: tracks[0].version,
          committedDate: '2026-11-12',
          reason: '越权回复',
        },
        403,
      )
      await call(
        role,
        `/tracking/${tracks[1].id}/complete`,
        'POST',
        {
          expectedVersion: tracks[1].version,
          actualCompleteDate: '2026-09-01',
        },
        403,
      )
    }
    const after = await detail()
    assert.deepEqual(after.items, before.items)
    assert.deepEqual(after.history, before.history)
    assert.deepEqual(after.events, before.events)
    assert.equal(after.bomReviewCount, 3)
    assert.equal(after.kit.predictionComplete, false)
  })

  await test('Successful completed-item retries survive later BOM revisions without rewriting history', async () => {
    const before = await detail()
    const retry = await call(
      'sharedBuyer',
      `/tracking/${tracks[3].id}/complete`,
      'POST',
      completionRequest,
    )
    assert.equal(retry.version, firstCompleted.version)
    assert.equal(retry.actualCompleteDate, '2026-09-01')
    await call(
      'sharedBuyer',
      `/tracking/${tracks[3].id}/complete`,
      'POST',
      {
        ...completionRequest,
        actualCompleteDate: '2026-09-02',
      },
      400,
    )
    assert.deepEqual((await detail()).events, before.events)
    assert.equal((await detail()).bomReviewCount, 3)
  })

  await test('Batch replies roll back earlier valid work when a later item needs BOM review', async () => {
    const external = await call(
      'technical',
      `/projects/${projectId}/external-items`,
      'POST',
      {
        name: '仍可正常采购的BOM外物料',
        qty: '1',
        trackingType: 'purchase',
        ownerId: actors.procurement!.id,
        requiredDate: '2026-11-20',
        affectsKit: true,
      },
      201,
    )
    // Batch sorts by UUID. Ensure at least one valid row is processed before the rejected row.
    const rejectedId = [...tracks.slice(0, 3)].sort((a, b) =>
      b.id.localeCompare(a.id),
    )[0].id
    const [valid] = await db
      .insert(s.npiTrackingItems)
      .values({
        id: '00000000-0000-4000-8000-000000000000',
        programId: projectId,
        sourceType: 'EXTERNAL',
        name: '确定排序的事务验证物料',
        qty: '1',
        trackingType: 'purchase',
        ownerId: actors.procurement!.id,
        requiredDate: '2026-11-20',
        affectsKit: false,
      })
      .returning()
    assert.ok(
      valid!.id < rejectedId,
      'fixture must save a valid row before rejected row',
    )
    const rejected = tracks.find((r) => r.id === rejectedId)
    const before = await detail()
    for (const operation of ['promise', 'complete']) {
      const result = await call(
        'sharedBuyer',
        '/tracking/batch-reply',
        'POST',
        {
          operation,
          reason: '验证事务回滚',
          items: [valid!, rejected].map((r) => ({
            id: r.id,
            expectedVersion: r.version,
            date: operation === 'promise' ? '2026-11-12' : '2026-09-01',
          })),
        },
        409,
      )
      assert.equal(result.code, 'BOM_REVIEW_REQUIRED')
    }
    assert.deepEqual((await detail()).items, before.items)
    assert.deepEqual((await detail()).history, before.history)
    assert.deepEqual((await detail()).events, before.events)
    const promise = await call(
      'sharedBuyer',
      `/tracking/${external.id}/promise`,
      'POST',
      {
        expectedVersion: external.version,
        committedDate: '2026-11-12',
      },
    )
    await call('sharedBuyer', `/tracking/${external.id}/complete`, 'POST', {
      expectedVersion: promise.version,
      actualCompleteDate: '2026-09-01',
    })
  })

  await test('Manufacturing nodes remain independent of BOM review and reply auditing stays transactional', async () => {
    for (const node of (await detail()).items.filter(
      (r: any) => r.sourceType === 'MANUFACTURING',
    )) {
      const promise = await call(
        'manufacturing',
        `/tracking/${node.id}/promise`,
        'POST',
        {
          expectedVersion: node.version,
          committedDate: '2026-11-12',
        },
      )
      await call('manufacturing', `/tracking/${node.id}/complete`, 'POST', {
        expectedVersion: promise.version,
        actualCompleteDate: '2026-09-01',
      })
    }
    const review = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
    )
    const candidate = review.items.find((r: any) => r.item.id === tracks[0].id)
    const migrated = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
      'POST',
      {
        action: 'migrate',
        trackingItemId: candidate.item.id,
        targetBomItemId: candidate.suggestedId,
        expectedVersion: candidate.item.version,
        expectedProjectVersion: review.projectVersion,
        activeImportId: review.activeImportId,
        reason: '核对数量后保留原承诺并继续采购',
      },
    )
    const before = await detail()
    await db.execute(
      sql`create function test_workflow_audit_failure() returns trigger language plpgsql as $$ begin raise exception 'workflow audit rollback'; end; $$`,
    )
    await db.execute(
      sql`create trigger test_workflow_audit before insert on npi_events for each row execute function test_workflow_audit_failure()`,
    )
    try {
      await call(
        'sharedBuyer',
        `/tracking/${migrated.id}/promise`,
        'POST',
        {
          expectedVersion: migrated.version,
          committedDate: '2026-11-13',
          reason: '审计异常不得部分写入',
        },
        500,
      )
      await call(
        'sharedBuyer',
        `/tracking/${migrated.id}/complete`,
        'POST',
        {
          expectedVersion: migrated.version,
          actualCompleteDate: '2026-09-01',
        },
        500,
      )
    } finally {
      await db.execute(sql`drop trigger test_workflow_audit on npi_events`)
      await db.execute(sql`drop function test_workflow_audit_failure()`)
    }
    assert.deepEqual((await detail()).items, before.items)
    assert.deepEqual((await detail()).history, before.history)
    tracks[0] = await call(
      'sharedBuyer',
      `/tracking/${migrated.id}/promise`,
      'POST',
      {
        expectedVersion: migrated.version,
        committedDate: '2026-11-13',
        reason: '核对新版后正常改期',
      },
    )
    assert.equal(tracks[0].firstCommittedDate, '2026-11-10')
    await call('sharedBuyer', `/tracking/${migrated.id}/complete`, 'POST', {
      expectedVersion: tracks[0].version,
      actualCompleteDate: '2026-09-01',
    })
    assert.equal((await detail()).bomReviewCount, 2)
  })

  await test('Five-stage completion preserves existing gates, retires obsolete work and leaves successful completion retries harmless', async () => {
    for (const stage of ['manufacturing', 'prototype', 'test']) {
      const current = await detail()
      await call(
        'supervisor',
        `/projects/${projectId}/stage`,
        'PATCH',
        {
          expectedVersion: current.version,
          currentNpiStage: stage,
          drawingCompleteDate: '2026-09-01',
        },
        403,
      )
      await call('technical', `/projects/${projectId}/stage`, 'PATCH', {
        expectedVersion: current.version,
        currentNpiStage: stage,
        drawingCompleteDate: '2026-09-01',
      })
    }
    const before = await detail()
    await call(
      'technical',
      `/projects/${projectId}/stage`,
      'PATCH',
      {
        expectedVersion: before.version,
        currentNpiStage: 'completed',
      },
      400,
    )
    assert.equal((await detail()).currentNpiStage, 'test')
    const review = await call(
      'technical',
      `/projects/${projectId}/bom/reconciliation`,
    )
    for (const row of review.items) {
      const retired = await call(
        'technical',
        `/projects/${projectId}/bom/reconciliation`,
        'POST',
        {
          action: 'retire',
          trackingItemId: row.item.id,
          expectedVersion: row.item.version,
          expectedProjectVersion: review.projectVersion,
          activeImportId: review.activeImportId,
          reason: '设计确认取消旧版跟踪，保留历史',
        },
      )
      await call(
        'sharedBuyer',
        `/tracking/${retired.id}/complete`,
        'POST',
        {
          expectedVersion: retired.version,
          actualCompleteDate: '2026-09-01',
        },
        400,
      )
    }
    const ready = await detail()
    assert.equal(ready.bomReviewCount, 0)
    await call('technical', `/projects/${projectId}/stage`, 'PATCH', {
      expectedVersion: ready.version,
      currentNpiStage: 'completed',
    })
    const finished = await detail()
    assert.equal(finished.currentNpiStage, 'completed')
    await call(
      'sharedBuyer',
      `/tracking/${firstCompleted.id}/complete`,
      'POST',
      completionRequest,
    )
    assert.deepEqual((await detail()).events, finished.events)
    assert.equal(
      (await call('sharedBuyer', '/workbench/quick-replies?kind=procurement'))
        .items.length,
      0,
    )
  })
} finally {
  await closeDatabase()
}
