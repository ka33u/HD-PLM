import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { sql } from 'drizzle-orm'
import { deliveryFixture } from './helpers/delivery-fixture'
const folder = mkdtempSync(join(tmpdir(), 'hd-pre-delivery-'))
cpSync('migrations', folder, { recursive: true })
const journal = JSON.parse(
  readFileSync(join(folder, 'meta/_journal.json'), 'utf8'),
)
journal.entries = journal.entries.filter((e: any) => e.idx < 3)
writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal))
const f = await deliveryFixture('hd_delivery_upgrade', folder)
try {
  await test('Upgrading existing four-node projects retains identities/history and fills all current BOM tasks exactly once', async () => {
    const id = await f.project(),
      d = await f.importBom(id),
      whole = d.items.find((i: any) => i.sourceType === 'WHOLE_MACHINE'),
      parts = d.items.filter((i: any) => i.sourceType === 'ERP_BOM')
    await f.call('manufacturing', `/tracking/${whole.id}/promise`, 'POST', {
      expectedVersion: whole.version,
      committedDate: '2026-11-18',
    })
    await f.db.execute(
      sql`update npi_tracking_items set source_type='MANUFACTURING', name='装配' where id=${whole.id}`,
    )
    await f.db.execute(
      sql`insert into npi_tracking_items (program_id,manufacturing_plan_id,source_type,tracking_type,name,owner_id,required_date,first_committed_date,current_committed_date) select program_id,manufacturing_plan_id,'MANUFACTURING','process','工艺',owner_id,'2026-11-10','2026-11-08','2026-11-09' from npi_tracking_items where id=${whole.id}`,
    )
    await f.db.execute(
      sql`delete from npi_tracking_items where id=${parts[0].id}`,
    )
    await f.db.execute(
      sql`update npi_tracking_items set tracking_enabled=false,affects_kit=false where id=${parts[1].id}`,
    )
    const orphan = await f.project()
    await f.db.execute(
      sql`delete from npi_tracking_items where program_id=${orphan}`,
    )
    await migrate(f.db, { migrationsFolder: 'migrations' })
    let upgraded = await f.detail(id)
    const w = upgraded.items.find((i: any) => i.id === whole.id)
    assert.equal(w.sourceType, 'WHOLE_MACHINE')
    assert.equal(w.currentCommittedDate, '2026-11-18')
    assert.equal(w.firstCommittedDate, '2026-11-18')
    assert.equal(
      upgraded.history.filter((h: any) => h.objectId === whole.id).length,
      1,
    )
    const node = upgraded.items.find((i: any) => i.sourceType === 'LEGACY_NODE')
    assert.equal(node.currentCommittedDate, '2026-11-09')
    assert.equal(node.trackingEnabled, false)
    assert.equal(node.affectsKit, false)
    const rows = upgraded.items.filter((i: any) => i.sourceType === 'ERP_BOM')
    assert.equal(rows.length, 4)
    assert.ok(
      rows.every(
        (i: any) =>
          i.trackingEnabled &&
          i.affectsKit &&
          i.ownerId === f.actors.manufacturing!.id,
      ),
    )
    assert.equal(upgraded.untrackedBomCount, 0)
    assert.equal(
      (await f.detail(orphan)).items.filter(
        (i: any) => i.sourceType === 'WHOLE_MACHINE',
      ).length,
      1,
    )
    await f.call(
      'manufacturing',
      `/tracking/${node.id}/promise`,
      'POST',
      { expectedVersion: node.version, committedDate: '2026-11-10' },
      400,
    )
    // Explicit SQL reapplication models the one-time legacy importer as well as retry safety.
    for (const q of readFileSync(
      'migrations/0003_direct_delivery_tasks.sql',
      'utf8',
    ).split('--> statement-breakpoint'))
      if (q.trim()) await f.db.execute(sql.raw(q))
    assert.deepEqual(
      (await f.detail(id)).items.map((i: any) => [i.id, i.version]).sort(),
      upgraded.items.map((i: any) => [i.id, i.version]).sort(),
    )
    await assert.rejects(() =>
      f.db.execute(
        sql`insert into npi_tracking_items (program_id,source_type,tracking_type,name,owner_id,required_date) values (${id},'WHOLE_MACHINE','assembly','重复整机',${f.actors.manufacturing!.id},'2026-11-28')`,
      ),
    )
  })
} finally {
  await f.closeDatabase()
}
