// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { projectTitle } from '../../lib/npi/project-identity'
import type { trashedProjects } from '../../lib/npi/project-trash'
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiProjectTrash({
  api,
  onChanged,
}: {
  api: Api
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<Awaited<ReturnType<typeof trashedProjects>>>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function load() {
    setBusy(true)
    setError('')
    try {
      setRows(await api('/project-trash'))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        className="npi-button secondary"
        onClick={() => {
          setOpen(true)
          void load()
        }}
      >
        项目回收站
      </button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v)
        }}
      >
        <DialogContent className="npi-modal">
          <DialogTitle>项目回收站</DialogTitle>
          <DialogDescription>
            删除后项目退出待办及报表，BOM、承诺、附件和审计保留。恢复后按原计划重新显示。
          </DialogDescription>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">正在处理…</p>}
          {!busy && !error && !rows.length && <p>回收站为空</p>}
          {rows.map((r) => (
            <form
              key={r.id}
              onSubmit={async (e) => {
                e.preventDefault()
                if (busy) return
                const reason = new FormData(e.currentTarget).get('reason')
                setBusy(true)
                setError('')
                try {
                  await api(`/projects/${r.id}/trash`, 'POST', {
                    action: 'restore',
                    expectedVersion: r.version,
                    reason,
                  })
                  await onChanged()
                  await load()
                } catch (e) {
                  setError(String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              <h3>{projectTitle(r)}</h3>
              <p>
                {r.code} · 删除原因：{r.reason}
              </p>
              <label>
                恢复原因
                <input
                  name="reason"
                  required
                  maxLength={2000}
                  disabled={busy}
                />
              </label>
              <button className="npi-button" disabled={busy}>
                恢复项目
              </button>
            </form>
          ))}
        </DialogContent>
      </Dialog>
    </>
  )
}
