// SPDX-License-Identifier: AGPL-3.0-or-later
import { projectTitle } from '../../lib/npi/project-identity'
import { useCallback, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { NpiManufacturingReply } from './NpiManufacturingReply'
import type { ProjectDetail } from '../../lib/npi/service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiManufacturingReplyDialog({
  project,
  api,
  onSaved,
  onReload,
  onClose,
  readOnly,
}: {
  project: ProjectDetail
  api: Api
  onReload: () => Promise<ProjectDetail>
  onSaved: () => Promise<void>
  onClose: () => void
  readOnly: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const pending = useRef(false)
  const dirty = useRef(false)
  const handleDirtyChange = useCallback((value: boolean) => {
    dirty.current = value
    if (!value) setConfirmClose(false)
  }, [])
  const requestClose = () => {
    if (pending.current) return
    if (dirty.current) setConfirmClose(true)
    else onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <DialogContent
        className="npi-modal npi-manufacturing-dialog"
        data-saving={busy}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle>集中回复制造四节点</DialogTitle>
        <DialogDescription>
          {projectTitle(project)} · {project.code}
          。只填写已确认的节点日期，其他节点保留待回复。
        </DialogDescription>
        {confirmClose && (
          <div className="npi-alert" role="alert">
            <span>还有制造节点日期未保存，关闭后将丢失本次填写。</span>
            <div className="npi-actions">
              <button
                autoFocus
                type="button"
                className="npi-button secondary"
                disabled={busy}
                onClick={() => setConfirmClose(false)}
              >
                继续填写
              </button>
              <button
                type="button"
                className="npi-button secondary"
                disabled={busy}
                onClick={onClose}
              >
                放弃填写并关闭
              </button>
            </div>
          </div>
        )}
        <NpiManufacturingReply
          project={project}
          api={api}
          readOnly={readOnly}
          onReload={onReload}
          onBusyChange={(value) => {
            pending.current = value
            setBusy(value)
          }}
          onDirtyChange={handleDirtyChange}
          onCancel={requestClose}
          onSaved={async () => {
            await onSaved()
            onClose()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
