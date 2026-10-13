import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { freshTestDatabase } from './fresh-database'
export async function deliveryFixture(
  prefix: string,
  migrationsFolder = 'migrations',
) {
  process.env.DATABASE_URL = await freshTestDatabase(prefix)
  process.env.ATTACHMENT_ROOT = mkdtempSync(
    join(tmpdir(), 'hd-delivery-files-'),
  )
  process.env.BASE_URL = 'http://localhost:3490'
  const { db, closeDatabase } = await import('../../src/lib/db')
  const { users } = await import('../../src/lib/db/schema/users')
  const s = await import('../../src/lib/db/schema/npi')
  const { createSession } = await import('../../src/lib/auth/session')
  const { app } = await import('../../src/server/app')
  const { seedNpiConfig } = await import('../../src/lib/npi/service')
  await migrate(db, { migrationsFolder })
  await seedNpiConfig()
  const actors: Record<string, { id: string; token: string }> = {}
  for (const [key, role] of Object.entries({
    technical: 'technical',
    manufacturing: 'manufacturing',
    procurement: 'procurement',
    supervisor: 'supervisor',
    admin: 'admin',
    peer: 'manufacturing',
    buyerPeer: 'procurement',
    outsider: 'procurement',
    nextMfg: 'manufacturing',
  })) {
    const [u] = await db
      .insert(users)
      .values({
        email: crypto.randomUUID() + '@delivery.test.invalid',
        name: '交付验证-' + key,
        mustChangePassword: false,
      })
      .returning()
    await db
      .insert(s.npiUserRoles)
      .values({ userId: u!.id, role: role as 'technical' })
    actors[key] = {
      id: u!.id,
      token: (await createSession(u!.id)).sessionToken,
    }
  }
  async function call(
    role: string,
    path: string,
    method = 'GET',
    data?: unknown,
    status = 200,
  ): Promise<any> {
    const form = data instanceof FormData
    const r = await app.request('http://localhost:3490/api/v1/npi' + path, {
      method,
      headers: {
        cookie: 'session=' + actors[role]!.token,
        origin: 'http://localhost:3490',
        'x-npi-actor': actors[role]!.id,
        ...(form ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : form ? data : JSON.stringify(data),
    })
    const json = await r.json()
    assert.equal(r.status, status, JSON.stringify(json))
    return json
  }
  const project = async () =>
    (
      await call(
        'technical',
        '/projects',
        'POST',
        {
          name: '直接交付电机',
          motorModel: 'YE5-250M-4 55kW',
          technicalOwnerId: actors.technical!.id,
          manufacturingOwnerId: actors.manufacturing!.id,
          requiredKitDate: '2026-11-20',
          prototypeRequiredDate: '2026-11-28',
        },
        201,
      )
    ).id as string
  const detail = (id: string) => call('technical', `/projects/${id}`)
  async function workbook(count = 4, changed = false) {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet('母件结构表-多阶')
    sheet.getCell('A4').value = 'MOTOR'
    sheet.getCell('B4').value = '直接交付电机'
    sheet.getCell('C4').value = 'YE5-250M-4 55kW'
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
    for (let i = 0; i < count; i++)
      sheet.getRow(i + 6).values = [
        '+',
        i + 1,
        'PART-' + i,
        '零部件' + i,
        '规格' + i,
        changed && i === 0 ? 2 : 1,
        '只',
        i % 2 ? '外购' : '领用',
        i % 2 ? '采购' : '金工',
      ]
    return new Uint8Array(await book.xlsx.writeBuffer())
  }
  async function importBom(id: string, count = 4, changed = false) {
    const form = new FormData()
    form.set(
      'file',
      new File([await workbook(count, changed)], 'delivery.xlsx'),
    )
    const preview = await call(
      'technical',
      `/projects/${id}/bom/import-preview`,
      'POST',
      form,
    )
    await call(
      'technical',
      `/projects/${id}/bom/import`,
      'POST',
      { previewToken: preview.previewToken },
      201,
    )
    return detail(id)
  }
  for (const [role, peer] of [
    ['manufacturing', 'peer'],
    ['procurement', 'buyerPeer'],
  ])
    await call('admin', '/departments', 'POST', {
      name: role + '交付组',
      role,
      memberIds: [actors[role!]!.id, actors[peer!]!.id],
      expectedVersion: 0,
      reason: '验证共同办理',
    })
  return {
    db,
    s,
    actors,
    call,
    project,
    detail,
    workbook,
    importBom,
    closeDatabase,
  }
}
