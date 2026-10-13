import test from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
const f = await deliveryFixture('hd_delivery'),
  { db, call, actors, detail } = f
let id = '',
  parts: any[] = [],
  whole: any
const batch = (
  items: any[],
  date = '2026-11-10',
  operation = 'promise',
  reason = '',
) => ({
  operation,
  reason,
  items: items.map((i) => ({ id: i.id, expectedVersion: i.version, date })),
})
try {
  await test('Every BOM row defaults to manufacturing, including purchased and non-critical rows; only one whole machine is created', async () => {
    id = await f.project()
    let d = await detail(id)
    assert.equal(d.items.length, 1)
    whole = d.items[0]
    assert.equal(whole.sourceType, 'WHOLE_MACHINE')
    assert.equal(whole.requiredDate, '2026-11-28')
    d = await f.importBom(id)
    parts = d.items.filter((i: any) => i.sourceType === 'ERP_BOM')
    assert.equal(parts.length, 4)
    assert.equal(d.untrackedBomCount, 0)
    assert.ok(
      parts.every(
        (i) =>
          i.ownerId === actors.manufacturing!.id &&
          i.trackingEnabled &&
          i.affectsKit,
      ),
    )
    assert.equal(
      (await call('procurement', '/workbench/procurement')).items.length,
      0,
    )
    assert.equal((await call('peer', '/workbench/materials')).items.length, 5)
    assert.equal(
      (
        await call(
          'manufacturing',
          `/projects/${id}/manufacturing-plan`,
          'PUT',
          {},
          409,
        )
      ).code,
      'NODE_REPLIES_RETIRED',
    )
    await call(
      'manufacturing',
      `/projects/${id}/manufacturing-completion`,
      'POST',
      {},
      409,
    )
    await call(
      'technical',
      `/bom-items/${parts[0].bomItemId}/tracking`,
      'PATCH',
      {
        expectedVersion: parts[0].version,
        ownerId: actors.manufacturing!.id,
        requiredDate: '2026-11-20',
        trackingEnabled: false,
      },
      422,
    )
  })
  await test('Large BOMs create a task for every row', async () => {
    const project = await f.project()
    const d = await f.importBom(project, 5000)
    assert.equal(
      d.items.filter((i: any) => i.sourceType === 'ERP_BOM').length,
      5000,
    )
    assert.equal(d.untrackedBomCount, 0)
    // Exclude this isolated stress project from the following workbench cases.
    await f.call('technical', `/projects/${project}/trash`, 'POST', {
      action: 'delete',
      confirmCode: d.code,
      expectedVersion: d.version,
      reason: '大BOM自动任务验证完成',
    })
  })
  await test('Batch transfer is owner-scoped, versioned, atomic and revokes the former owner immediately', async () => {
    const payload = {
      items: parts
        .slice(0, 2)
        .map((i) => ({ id: i.bomItemId, expectedVersion: i.version })),
      ownerId: actors.procurement!.id,
      reason: '外购转采购',
    }
    await call(
      'procurement',
      `/projects/${id}/bom/assign`,
      'POST',
      payload,
      403,
    )
    await call(
      'technical',
      `/projects/${id}/bom/assign`,
      'POST',
      {
        ...payload,
        items: [
          payload.items[0],
          { ...payload.items[1], expectedVersion: 999 },
        ],
      },
      409,
    )
    assert.ok(
      (await detail(id)).items
        .filter((i: any) => i.sourceType === 'ERP_BOM')
        .every((i: any) => i.ownerId === actors.manufacturing!.id),
    )
    await call('supervisor', `/projects/${id}/bom/assign`, 'POST', payload)
    parts = (await detail(id)).items.filter(
      (i: any) => i.sourceType === 'ERP_BOM',
    )
    assert.equal(
      (await call('buyerPeer', '/workbench/procurement')).items.length,
      2,
    )
    const buyer = parts.find((i) => i.ownerId === actors.procurement!.id)
    await call(
      'manufacturing',
      `/tracking/${buyer.id}/promise`,
      'POST',
      { expectedVersion: buyer.version, committedDate: '2026-11-10' },
      403,
    )
    await call(
      'outsider',
      `/tracking/${buyer.id}/promise`,
      'POST',
      { expectedVersion: buyer.version, committedDate: '2026-11-10' },
      403,
    )
    await call(
      'supervisor',
      `/tracking/${buyer.id}/promise`,
      'POST',
      { expectedVersion: buyer.version, committedDate: '2026-11-10' },
      403,
    )
  })
  await test('Tooling and external parts share manual creation, department work, idempotency and full kit participation', async () => {
    for (const [category, trackingType, role] of [
      ['tooling', 'material', 'manufacturing'],
      ['tooling', 'purchase', 'procurement'],
      ['material', 'material', 'manufacturing'],
    ]) {
      const payload = {
        category,
        trackingType,
        name: category === 'tooling' ? '定位工装-' + role : 'BOM外试验件',
        qty: '2',
        unit: '套',
        ownerId: actors[role!]!.id,
        requiredDate: '2026-11-15',
        affectsKit: false,
        requestId: crypto.randomUUID(),
      }
      const item = await call(
        'technical',
        `/projects/${id}/external-items`,
        'POST',
        payload,
        201,
      )
      assert.equal(
        item.sourceType,
        category === 'tooling' ? 'TOOLING' : 'EXTERNAL',
      )
      assert.equal(item.affectsKit, true)
      assert.equal(
        (
          await call(
            'technical',
            `/projects/${id}/external-items`,
            'POST',
            payload,
            201,
          )
        ).id,
        item.id,
      )
    }
    assert.equal(
      (await detail(id)).items.filter((i: any) => i.sourceType === 'TOOLING')
        .length,
      2,
    )
    assert.equal(
      (await call('buyerPeer', '/workbench/procurement')).items.length,
      3,
    )
  })
  await test('Whole machine, parts and tooling use the same fast replies; reasons, first promises, actors and rollback are preserved', async () => {
    let items = (
      await call('peer', '/workbench/quick-replies?kind=manufacturing')
    ).items
    assert.ok(items.some((i: any) => i.sourceType === 'WHOLE_MACHINE'))
    assert.ok(items.some((i: any) => i.sourceType === 'TOOLING'))
    await call('peer', '/tracking/batch-reply', 'POST', batch(items))
    let buys = (
      await call('buyerPeer', '/workbench/quick-replies?kind=procurement')
    ).items
    await call('buyerPeer', '/tracking/batch-reply', 'POST', batch(buys))
    items = (await call('peer', '/workbench/quick-replies?kind=manufacturing'))
      .items
    await call(
      'peer',
      '/tracking/batch-reply',
      'POST',
      batch(items, '2026-11-11'),
      400,
    )
    await db.execute(
      sql`create function fail_delivery_audit() returns trigger as $$ begin if NEW.action='PROMISE_CHANGED' then raise exception 'rollback'; end if; return NEW; end; $$ language plpgsql`,
    )
    await db.execute(
      sql`create trigger delivery_audit before insert on npi_events for each row execute function fail_delivery_audit()`,
    )
    await call(
      'peer',
      '/tracking/batch-reply',
      'POST',
      batch(items, '2026-11-11', 'promise', '统一改期'),
      500,
    )
    await db.execute(sql`drop trigger delivery_audit on npi_events`)
    assert.ok(
      (await detail(id)).items.every(
        (i: any) => i.currentCommittedDate === '2026-11-10',
      ),
    )
    await call(
      'peer',
      '/tracking/batch-reply',
      'POST',
      batch(items, '2026-11-11', 'promise', '统一改期'),
    )
    const d = await detail(id)
    assert.ok(d.items.every((i: any) => i.firstCommittedDate === '2026-11-10'))
    assert.ok(
      d.history.some(
        (h: any) => h.objectId === whole.id && h.changedBy === actors.peer!.id,
      ),
    )
    assert.equal(d.kit.predictedKitDate, '2026-11-11')
    assert.equal(d.kit.manufacturingCommittedKitDate, '2026-11-11')
  })
  await test('BOM replacement carries unchanged identities, blocks changed tasks and fills new rows after explicit review', async () => {
    const before = await detail(id),
      original = before.items.find(
        (i: any) => i.bomReference?.materialCode === 'PART-0',
      )
    let d = await f.importBom(id, 5, true)
    assert.equal(d.bomReviewCount, 1)
    assert.equal(d.untrackedBomCount, 1)
    for (const item of before.items.filter(
      (i: any) => i.bomReference?.materialCode !== 'PART-0',
    ))
      assert.ok(d.items.some((i: any) => i.id === item.id))
    const newPart = d.items.find(
      (i: any) => i.bomReference?.materialCode === 'PART-4',
    )
    assert.equal(newPart.ownerId, actors.manufacturing!.id)
    await call(
      'buyerPeer',
      `/tracking/${original.id}/promise`,
      'POST',
      {
        expectedVersion: original.version,
        committedDate: '2026-11-12',
        reason: '未复核',
      },
      409,
    )
    await call(
      'buyerPeer',
      `/tracking/${original.id}/complete`,
      'POST',
      { expectedVersion: original.version, actualCompleteDate: '2026-09-01' },
      409,
    )
    const review = await call(
        'technical',
        `/projects/${id}/bom/reconciliation`,
      ),
      r = review.items[0]
    await call('technical', `/projects/${id}/bom/reconciliation`, 'POST', {
      action: 'migrate',
      trackingItemId: r.item.id,
      targetBomItemId: r.suggestedId,
      expectedVersion: r.item.version,
      expectedProjectVersion: review.projectVersion,
      activeImportId: review.activeImportId,
      reason: '数量变化已经核对',
    })
    d = await detail(id)
    assert.equal(d.bomReviewCount, 0)
    assert.equal(d.untrackedBomCount, 0)
    assert.equal(
      d.items.find((i: any) => i.id === original.id).firstCommittedDate,
      original.firstCommittedDate,
    )
  })
  await test('Concurrent replies have one winner; completed retries do not duplicate history', async () => {
    let item = (await detail(id)).items.find(
      (i: any) => i.bomReference?.materialCode === 'PART-4',
    )
    const results = await Promise.allSettled(
      ['2026-11-12', '2026-11-13'].map((committedDate) =>
        call('manufacturing', `/tracking/${item.id}/promise`, 'POST', {
          expectedVersion: item.version,
          committedDate,
        }),
      ),
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    item = (await detail(id)).items.find((i: any) => i.id === item.id)
    const body = {
      expectedVersion: item.version,
      actualCompleteDate: '2026-09-01',
    }
    await call('peer', `/tracking/${item.id}/complete`, 'POST', body)
    await call('peer', `/tracking/${item.id}/complete`, 'POST', body)
    assert.equal(
      (await detail(id)).events.filter(
        (e: any) => e.objectId === item.id && e.action === 'COMPLETED',
      ).length,
      1,
    )
  })
  await test('All tasks must complete before closure; archived nodes are not required and the closed project is read-only', async () => {
    for (const next of ['manufacturing', 'prototype', 'test']) {
      const d = await detail(id)
      await call('technical', `/projects/${id}/stage`, 'PATCH', {
        currentNpiStage: next,
        expectedVersion: d.version,
        drawingCompleteDate: '2026-09-01',
      })
    }
    let d = await detail(id)
    await call(
      'technical',
      `/projects/${id}/stage`,
      'PATCH',
      { currentNpiStage: 'completed', expectedVersion: d.version },
      400,
    )
    for (const [role, kind] of [
      ['peer', 'manufacturing'],
      ['buyerPeer', 'procurement'],
    ]) {
      const items = (await call(role!, `/workbench/quick-replies?kind=${kind}`))
        .items
      await call(
        role!,
        '/tracking/batch-reply',
        'POST',
        batch(items, '2026-09-01', 'complete'),
      )
    }
    d = await detail(id)
    assert.equal(d.items.filter((i: any) => !i.actualCompleteDate).length, 0)
    await call('technical', `/projects/${id}/stage`, 'PATCH', {
      currentNpiStage: 'completed',
      expectedVersion: d.version,
    })
    assert.equal((await detail(id)).currentNpiStage, 'completed')
    assert.equal(
      (await call('peer', '/workbench/quick-replies?kind=manufacturing')).items
        .length,
      0,
    )
    await call(
      'peer',
      `/tracking/${whole.id}/promise`,
      'POST',
      { expectedVersion: 1, committedDate: '2026-11-20' },
      400,
    )
  })
} finally {
  await f.closeDatabase()
}
