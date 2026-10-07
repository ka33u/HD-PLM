// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../ui/Dialog'
import type { BomRow } from '../../lib/npi/bom'
import type { ProjectDetail } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiBomRevision({
  api,
  project,
  row,
  rows,
  onClose,
  onSaved,
}: {
  api: Api
  project: ProjectDetail
  row: BomRow
  rows: BomRow[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [action, setAction] = useState('edit'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const removed = new Set([row.id])
  for (const r of [...rows].sort((a, b) => a.rowNo - b.rowNo))
    if (r.parentId && removed.has(r.parentId)) removed.add(r.id)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="npi-modal" style={{ maxWidth: 760 }}>
        <DialogTitle>在线修订BOM物料</DialogTitle>
        <DialogDescription>
          当前物料：{row.materialCode} · {row.materialName}
          。保存将生成新版本，旧BOM与承诺记录继续保留。发生变化的跟踪项须复核。
        </DialogDescription>
        {error && (
          <p role="alert" className="npi-error">
            {error}
          </p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (busy) return
            setBusy(true)
            setError('')
            const data = Object.fromEntries(new FormData(e.currentTarget))
            try {
              await api(`/projects/${project.id}/bom/revisions`, 'POST', {
                action,
                importId: project.activeBomImportId,
                bomItemId: row.id,
                expectedProjectVersion: project.version,
                expectedRemovedCount: removed.size,
                reason: data.reason,
                row: data,
              })
              onClose()
              await onSaved()
            } catch (e) {
              setError(e instanceof Error ? e.message : '修订失败，请刷新核对')
            } finally {
              setBusy(false)
            }
          }}
        >
          <fieldset disabled={busy}>
            <label>
              修订操作
              <select
                aria-label="修订操作"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                <option value="edit">修改物料资料</option>
                <option value="remove">移除此物料及下级</option>
              </select>
            </label>
            {action === 'edit' ? (
              <div className="npi-form-grid">
                {[
                  ['materialCode', '物料编码', 200],
                  ['materialName', '物料名称', 255],
                  ['specification', '规格', 2000],
                  ['qty', '基本用量', 30],
                  ['unit', '单位', 100],
                  ['supplyType', '供应类型', 200],
                  ['issueDepartment', '领料部门', 200],
                  ['warehouse', '仓库', 200],
                  ['remark', '备注', 2000],
                ].map(([key, label, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      name={String(key)}
                      defaultValue={String(row[key as keyof BomRow] ?? '')}
                      maxLength={Number(max)}
                      required={[
                        'materialCode',
                        'materialName',
                        'qty',
                      ].includes(String(key))}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p role="status" className="npi-warning-text">
                本次将从新版本移除 {removed.size}{' '}
                项（含下级物料）。已有跟踪、附件和历史仍然保留；尚未完成的旧跟踪需要明确停止。
              </p>
            )}
            <label>
              修订原因
              <textarea name="reason" required maxLength={2000} />
            </label>
            <div className="npi-actions">
              <button
                type="button"
                className="npi-button secondary"
                onClick={onClose}
              >
                取消
              </button>
              <button className="npi-button">
                {busy
                  ? '正在保存…'
                  : `确认${action === 'remove' ? '移除并' : ''}生成新版本`}
              </button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}
