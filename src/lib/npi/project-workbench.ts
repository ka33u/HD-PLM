// SPDX-License-Identifier: AGPL-3.0-or-later
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import { projects } from '../db/schema/projects'
import { users } from '../db/schema/users'
import * as s from '../db/schema/npi'
import { getActor, uuidValue } from './service'
import { NpiError, itemStatus, today } from './domain'
import { readProjectProfile } from './project-profile'
import { ownsWork } from './work-ownership'
import type { NpiTracking } from './service'
import type { BomRow } from './bom'

export async function projectWorkbench(
  userId: string,
  kind: string,
  projectId?: string,
) {
  if (!['manufacturing', 'procurement'].includes(kind))
    throw new NpiError('VALIDATION_ERROR', '请选择生产或采购')
  if (projectId) uuidValue(projectId)
  return db.transaction(
    async (tx) => {
      const actor = await getActor(userId, tx)
      if (actor.role === 'procurement' && kind !== 'procurement')
        throw new NpiError(
          'NPI_PERMISSION_DENIED',
          '采购岗位仅可查看采购项目',
          403,
        )
      const types =
        kind === 'procurement'
          ? ['purchase']
          : ['material', 'other', 'assembly']
      const source = await tx
        .select({ project: s.npiProjects, record: projects })
        .from(s.npiProjects)
        .innerJoin(projects, eq(projects.id, s.npiProjects.programId))
        .where(
          and(
            isNull(s.npiProjects.deletedAt),
            projectId ? eq(s.npiProjects.programId, projectId) : undefined,
          ),
        )
        .orderBy(asc(s.npiProjects.requiredKitDate), asc(projects.code))
      const fullAccess = (p: typeof s.npiProjects.$inferSelect) =>
        ['admin', 'supervisor'].includes(actor.role) ||
        (['technical', 'manufacturing'].includes(actor.role) &&
          (ownsWork(actor, p.technicalOwnerId) ||
            ownsWork(actor, p.manufacturingOwnerId)))
      const ids = source.map((p) => p.project.programId)
      const data = ids.length
        ? await tx
            .select({
              item: s.npiTrackingItems,
              ownerName: users.name,
              bomRow: s.npiBomItems.row,
              importId: s.npiBomItems.importId,
              versionNo: s.npiBomImports.versionNo,
            })
            .from(s.npiTrackingItems)
            .innerJoin(users, eq(users.id, s.npiTrackingItems.ownerId))
            .leftJoin(
              s.npiBomItems,
              eq(s.npiBomItems.id, s.npiTrackingItems.bomItemId),
            )
            .leftJoin(
              s.npiBomImports,
              eq(s.npiBomImports.id, s.npiBomItems.importId),
            )
            .where(
              and(
                inArray(s.npiTrackingItems.programId, ids),
                inArray(s.npiTrackingItems.trackingType, types),
                sql`(${s.npiTrackingItems.trackingEnabled} or ${s.npiTrackingItems.affectsKit})`,
              ),
            )
        : []
      const grouped = new Map<string, typeof data>()
      for (const r of data) {
        const list = grouped.get(r.item.programId) || []
        list.push(r)
        grouped.set(r.item.programId, list)
      }
      // Procurement may own a project issue before any parts are assigned.
      // Keep these projects reachable through the same project-first entry.
      const assignedIssues =
        actor.role === 'procurement' && ids.length
          ? await tx
              .select({ programId: s.npiIssues.programId })
              .from(s.npiIssues)
              .where(
                and(
                  inArray(s.npiIssues.programId, ids),
                  inArray(s.npiIssues.ownerId, [
                    ...new Set([actor.id, ...(actor.collaboratorIds || [])]),
                  ]),
                ),
              )
          : []
      const issueCounts = new Map<string, number>()
      for (const issue of assignedIssues)
        issueCounts.set(
          issue.programId,
          (issueCounts.get(issue.programId) || 0) + 1,
        )
      const visible = source.flatMap(({ project: p, record }) => {
        const full = fullAccess(p)
        const tasks = (grouped.get(p.programId) || []).filter(
          (r) => full || ownsWork(actor, r.item.ownerId),
        )
        const issueCount = issueCounts.get(p.programId) || 0
        if (!full && !tasks.length && !issueCount) return []
        // Empty procurement projects remain useful for managers preparing assignments.
        const current = tasks.filter(
          (r) => !r.importId || r.importId === p.activeBomImportId,
        )
        const unfinished = current.filter((r) => !r.item.actualCompleteDate)
        const profile = readProjectProfile(record)
        return [
          {
            id: p.programId,
            name: record.name,
            code: record.code,
            motorModel: p.motorModel,
            motorType: profile.motorType,
            orderQuantity: profile.orderQuantity,
            currentNpiStage: p.currentNpiStage,
            requiredKitDate: p.requiredKitDate,
            prototypeRequiredDate: p.prototypeRequiredDate,
            activeBomImportId: p.activeBomImportId,
            canOpenProject: full,
            scoped: !full,
            counts: {
              issues: issueCount,
              total: current.length,
              unfinished: unfinished.length,
              pending: unfinished.filter((r) => !r.item.currentCommittedDate)
                .length,
              completed: current.length - unfinished.length,
              risk: unfinished.filter((r) =>
                ['risk', 'overdue'].includes(itemStatus(r.item)),
              ).length,
              review: tasks.filter(
                (r) =>
                  r.importId &&
                  r.importId !== p.activeBomImportId &&
                  !r.item.actualCompleteDate,
              ).length,
            },
          },
        ]
      })
      const selected = projectId
        ? visible.find((p) => p.id === projectId)
        : null
      if (projectId && !selected)
        throw new NpiError(
          'PROGRAM_NOT_FOUND',
          '项目不存在、已删除或未向你分配任务',
          404,
        )
      const items: NpiTracking[] = selected
        ? (grouped.get(selected.id) || [])
            .filter(
              (r) => selected.canOpenProject || ownsWork(actor, r.item.ownerId),
            )
            .map((r) => ({
              ...r.item,
              ownerName: r.ownerName || '未命名',
              status: itemStatus(r.item),
              currentNpiStage: selected.currentNpiStage,
              bomReference:
                r.bomRow && r.versionNo
                  ? {
                      materialCode: r.bomRow.materialCode,
                      rowNo: r.bomRow.rowNo,
                      versionNo: r.versionNo,
                      current: r.importId === selected.activeBomImportId,
                    }
                  : null,
            }))
        : []
      let rows: BomRow[] = selected?.activeBomImportId
        ? (
            await tx
              .select({ row: s.npiBomItems.row })
              .from(s.npiBomItems)
              .where(eq(s.npiBomItems.importId, selected.activeBomImportId))
          )
            .map((r) => r.row)
            .sort((a, b) => a.rowNo - b.rowNo)
        : []
      if (selected?.scoped) {
        const owned = new Set(
            items
              .filter((i) => i.bomReference?.current)
              .map((i) => i.bomItemId),
          ),
          keep = new Set(owned),
          byId = new Map(rows.map((r) => [r.id, r]))
        for (const id of owned) {
          let parent = byId.get(id || '')?.parentId
          while (parent && !keep.has(parent)) {
            keep.add(parent)
            parent = byId.get(parent)?.parentId
          }
        }
        // Preserve tree context, while omitting other departments' rows and raw ERP data.
        rows = rows
          .filter((r) => keep.has(r.id))
          .map((r) => ({
            ...r,
            rawData: {},
            remark: owned.has(r.id) ? r.remark : '',
            warehouse: '',
            issueDepartment: '',
            supplyType: owned.has(r.id) ? r.supplyType : '',
          }))
      }
      return {
        actorId: actor.id,
        today: today(),
        projects: visible,
        project: selected || null,
        items,
        rows,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
export type ProjectWorkbench = Awaited<ReturnType<typeof projectWorkbench>>
