// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, eq, inArray } from 'drizzle-orm'
import * as s from '../db/schema/npi'
import { bomDiff } from './bom'
import type { BomRow } from './bom'
import type { TransactionClient } from '../db'

export async function carryUnchangedTracking(
  tx: TransactionClient,
  projectId: string,
  oldImportId: string | null,
  rows: BomRow[],
  actorId: string,
) {
  if (!oldImportId) return 0
  const old = await tx
    .select()
    .from(s.npiBomItems)
    .where(eq(s.npiBomItems.importId, oldImportId))
  const differences = bomDiff(
    old.map((r) => r.row),
    rows,
  )
  const byNext = new Map(
    differences.filter((d) => d.after).map((d) => [d.after!.id, d]),
  )
  const unchanged = new Map(
    differences
      .filter((d) => {
        if (d.type !== 'UNCHANGED') return false
        // An ancestor's quantity or definition change can affect this component's
        // requirement even when the component row itself is byte-for-byte unchanged.
        let parentId = d.after!.parentId
        while (parentId) {
          const parent = byNext.get(parentId)
          if (parent?.type !== 'UNCHANGED') return false
          parentId = parent.after!.parentId
        }
        return true
      })
      .map((d) => [d.before!.id, d.after!]),
  )
  if (!unchanged.size) return 0
  const tracks = await tx
    .select()
    .from(s.npiTrackingItems)
    .where(
      and(
        eq(s.npiTrackingItems.programId, projectId),
        inArray(s.npiTrackingItems.bomItemId, [...unchanged.keys()]),
      ),
    )
    .for('update')
  for (const track of tracks) {
    const next = unchanged.get(track.bomItemId!)!
    await tx
      .update(s.npiTrackingItems)
      .set({ bomItemId: next.id, version: track.version + 1 })
      .where(eq(s.npiTrackingItems.id, track.id))
    await tx.insert(s.npiEvents).values({
      actorId,
      programId: projectId,
      objectId: track.id,
      action: 'BOM_TRACKING_CARRIED',
      detail: {
        reason: '位置、编码、数量与资料完全一致，延续原跟踪及全部承诺',
        before: { bomItemId: track.bomItemId },
        after: { bomItemId: next.id },
      },
    })
  }
  return tracks.length
}
