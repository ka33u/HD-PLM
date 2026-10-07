// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { db } from '../db'
import * as s from '../db/schema/npi'
import { defaultTemplate } from './bom'
import { normalizeBomQuantity } from './bom-quantity'
import { carryUnchangedTracking } from './bom-carry'
import { NpiError, dateValue, textValue } from './domain'
import {
  event,
  getActor,
  loadProject,
  uuidValue,
  versionCheck,
} from './service'
import type { BomRow } from './bom'

export async function reviseBom(
  userId: string,
  id: string,
  input: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const actor = await getActor(userId, tx, true)
    const project = await loadProject(tx, id, actor, true)
    if (
      actor.role !== 'admin' &&
      (actor.role !== 'technical' || actor.id !== project.technicalOwnerId)
    )
      throw new NpiError(
        'NPI_PERMISSION_DENIED',
        '仅技术负责人或管理员可修订BOM',
        403,
      )
    versionCheck(
      project.version,
      input.expectedProjectVersion,
      'BOM_VERSION_CONFLICT',
    )
    if (
      !project.activeBomImportId ||
      input.importId !== project.activeBomImportId
    )
      throw new NpiError(
        'BOM_VERSION_CONFLICT',
        '只能修订当前BOM，请刷新版本',
        409,
      )
    const reason = textValue(input.reason, '修订原因', 2000)
    const [source] = await tx
      .select()
      .from(s.npiBomImports)
      .where(eq(s.npiBomImports.id, project.activeBomImportId))
    const entries = await tx
      .select()
      .from(s.npiBomItems)
      .where(eq(s.npiBomItems.importId, project.activeBomImportId))
    const rows = entries.map((e) => e.row).sort((a, b) => a.rowNo - b.rowNo)
    const target = rows.find((r) => r.id === uuidValue(input.bomItemId))
    if (!target) throw new NpiError('BOM_NOT_FOUND', '当前BOM中没有该物料', 404)
    let next = rows.map((r) => ({ ...r })),
      removed: string[] = []
    if (input.action === 'remove') {
      const ids = new Set([target.id])
      for (const row of rows)
        if (row.parentId && ids.has(row.parentId)) ids.add(row.id)
      removed = [...ids]
      if (input.expectedRemovedCount !== ids.size)
        throw new NpiError(
          'BOM_VERSION_CONFLICT',
          '请确认包含下级物料的移除数量',
          409,
        )
      next = next.filter((r) => !ids.has(r.id))
    } else if (input.action === 'edit') {
      const data = input.row
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new NpiError('VALIDATION_ERROR', '请输入物料资料')
      const values = data as Record<string, unknown>
      const changed = next.find((r) => r.id === target.id)!
      for (const [field, label, max, optional] of [
        ['materialCode', '物料编码', 200, false],
        ['materialName', '物料名称', 255, false],
        ['specification', '规格', 2000, true],
        ['unit', '单位', 100, true],
        ['supplyType', '供应类型', 200, true],
        ['issueDepartment', '领料部门', 200, true],
        ['warehouse', '仓库', 200, true],
        ['remark', '备注', 2000, true],
      ] as const)
        if (values[field] !== undefined)
          changed[field] = textValue(values[field], label, max, optional)
      if (values.qty !== undefined)
        changed.qty = normalizeBomQuantity(String(values.qty)).value
      if (values.effectiveDate !== undefined)
        changed.effectiveDate = dateValue(
          values.effectiveDate,
          '生效日期',
          true,
        )
      if (JSON.stringify(changed) === JSON.stringify(target))
        throw new NpiError('VALIDATION_ERROR', '没有需要保存的修改')
    } else throw new NpiError('VALIDATION_ERROR', '请选择修改或移除物料')
    const ids = new Map(next.map((r) => [r.id, randomUUID()]))
    const revised = next.map((r) => ({
      ...r,
      id: ids.get(r.id)!,
      parentId: r.parentId ? ids.get(r.parentId)! : null,
    }))
    const [last] = await tx
      .select({ versionNo: s.npiBomImports.versionNo })
      .from(s.npiBomImports)
      .where(eq(s.npiBomImports.programId, id))
      .orderBy(desc(s.npiBomImports.versionNo))
      .limit(1)
    const versionNo = last!.versionNo + 1
    // Export a new workbook representing the edited rows; the imported original
    // remains attached to its immutable old version.
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet(defaultTemplate.sheetName)
    sheet.getCell('A4').value = source!.mother.code
    sheet.getCell('B4').value = source!.mother.name
    sheet.getCell('C4').value = source!.mother.spec
    const mapping = Object.entries(defaultTemplate.fieldMapping)
    sheet.getRow(5).values = mapping.map(([, label]) => label)
    revised.forEach((row, index) => {
      sheet.getRow(6 + index).values = mapping.map(([key]) =>
        key === 'level'
          ? '+'.repeat(row.level)
          : String(row[key as keyof BomRow] ?? ''),
      )
    })
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    const [record] = await tx
      .insert(s.npiBomImports)
      .values({
        programId: id,
        versionNo,
        templateId: defaultTemplate.id,
        mother: source!.mother,
        sheetName: defaultTemplate.sheetName,
        rowCount: revised.length,
        maxLevel: Math.max(0, ...revised.map((r) => r.level)),
        sourceName: `BOM-在线修订-V${versionNo}.xlsx`,
        sourceBase64: bytes.toString('base64'),
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        templateSnapshot: defaultTemplate,
        importedBy: actor.id,
      })
      .returning({ id: s.npiBomImports.id })
    for (let i = 0; i < revised.length; i += 100)
      await tx.insert(s.npiBomItems).values(
        revised.slice(i, i + 100).map((row) => ({
          id: row.id,
          importId: record!.id,
          parentId: row.parentId,
          level: row.level,
          materialCode: row.materialCode,
          row,
        })),
      )
    const carriedCount = await carryUnchangedTracking(
      tx,
      id,
      project.activeBomImportId,
      revised,
      actor.id,
    )
    await tx
      .update(s.npiProjects)
      .set({ activeBomImportId: record!.id, version: project.version + 1 })
      .where(eq(s.npiProjects.programId, id))
    await event(tx, actor, id, record!.id, 'BOM_REVISED', {
      reason,
      action: input.action,
      versionNo,
      previousImportId: source!.id,
      carriedCount,
      before: target,
      after: next.find((r) => r.id === target.id) || null,
      removed,
    })
    return {
      importId: record!.id,
      versionNo,
      rowCount: revised.length,
      carriedCount,
    }
  })
}
