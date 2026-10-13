// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq, inArray, sql } from 'drizzle-orm'
import * as s from '../db/schema/npi'
import type { TransactionClient } from '../db'

// Called under the project lock, in the same transaction as a BOM activation.
// Changed old tasks must be reviewed before creating tasks for the same code.
export async function ensureBomDeliveryTasks(
  tx: TransactionClient,
  projectId: string,
) {
  const [project] = await tx
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, projectId))
  if (!project?.activeBomImportId || project.currentNpiStage === 'completed')
    return 0
  const rows = await tx
    .select()
    .from(s.npiBomItems)
    .where(eq(s.npiBomItems.importId, project.activeBomImportId))
  const tasks = await tx
    .select({
      item: s.npiTrackingItems,
      importId: s.npiBomItems.importId,
      code: s.npiBomItems.materialCode,
    })
    .from(s.npiTrackingItems)
    .innerJoin(
      s.npiBomItems,
      eq(s.npiBomItems.id, s.npiTrackingItems.bomItemId),
    )
    .where(eq(s.npiTrackingItems.programId, projectId))
  const occupied = new Set(tasks.map((t) => t.item.bomItemId))
  const reviewCodes = new Set(
    tasks
      .filter(
        (t) =>
          t.importId !== project.activeBomImportId &&
          !t.item.actualCompleteDate &&
          (t.item.trackingEnabled || t.item.affectsKit),
      )
      .map((t) => t.code),
  )
  const inactive = tasks
    .filter(
      (t) =>
        t.importId === project.activeBomImportId &&
        (!t.item.trackingEnabled || !t.item.affectsKit),
    )
    .map((t) => t.item.id)
  if (inactive.length)
    await tx
      .update(s.npiTrackingItems)
      .set({
        trackingEnabled: true,
        affectsKit: true,
        version: sql`${s.npiTrackingItems.version} + 1`,
      })
      .where(inArray(s.npiTrackingItems.id, inactive))
  const missing = rows.filter(
    (row) => !occupied.has(row.id) && !reviewCodes.has(row.materialCode),
  )
  for (let i = 0; i < missing.length; i += 100)
    await tx.insert(s.npiTrackingItems).values(
      missing.slice(i, i + 100).map(({ id, row }) => ({
        programId: projectId,
        bomItemId: id,
        sourceType: 'ERP_BOM',
        trackingType: 'material',
        name: row.materialName,
        specification: row.specification,
        qty: row.qty,
        unit: row.unit,
        ownerId: project.manufacturingOwnerId,
        requiredDate: project.requiredKitDate,
        trackingEnabled: true,
        affectsKit: true,
      })),
    )
  return missing.length
}
