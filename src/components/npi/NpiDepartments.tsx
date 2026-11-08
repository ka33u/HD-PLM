// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../ui/Dialog'
import {
  departmentCategories,
  type DepartmentCategory,
} from '../../lib/auth/department-categories'
import type { listDepartments } from '../../lib/npi/department-service'
type Data = Awaited<ReturnType<typeof listDepartments>>
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiDepartments({
  api,
  revision = 0,
  onChanged,
}: {
  api: Api
  revision?: number
  onChanged?: () => void | Promise<void>
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{
    id?: string
    name: string
    role: DepartmentCategory
    version: number
    members: string[]
  } | null>(null)
  const load = useCallback(async () => {
    setError('')
    try {
      setData(await api<Data>('/departments'))
    } catch (e) {
      setError(String(e))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load, revision])
  return (
    <section className="npi-panel" aria-label="部门协作分组">
      <div className="npi-panel-title">
        <h2>部门协作分组</h2>
        <button
          className="npi-button"
          disabled={!data || busy}
          onClick={() =>
            setDraft({
              name: '',
              role: 'manufacturing',
              version: 0,
              members: [],
            })
          }
        >
          新建部门分组
        </button>
      </div>
      <p className="npi-list-summary">
        设计类部门用于人员归属，项目流程仍由具体项目负责人填写。生产、采购类部门的同岗位成员共同处理部门任务，保留主负责人和实际办理人；主管仍只调整计划。部门名称会出现在注册页。
      </p>
      {error && (
        <p role="alert" className="npi-error">
          {error}
          <button onClick={() => void load()}>重新读取部门</button>
        </p>
      )}
      {data?.departments.map((d) => (
        <div className="npi-settings-row" key={d.id}>
          <div>
            <strong>
              {d.name} · {departmentCategories[d.role]}
            </strong>
            <small>
              {data.members
                .filter((m) => m.departmentId === d.id)
                .map((m) => m.name + (m.active ? '' : '（已停用）'))
                .join('、') || '暂无成员'}
            </small>
          </div>
          <button
            className="npi-button secondary"
            onClick={() =>
              setDraft({
                ...d,
                members: data.members
                  .filter((m) => m.departmentId === d.id)
                  .map((m) => m.id),
              })
            }
          >
            管理成员
          </button>
        </div>
      ))}
      {data && !data.departments.length && (
        <p className="npi-list-summary">尚未建立分组，当前仍按个人负责。</p>
      )}
      {data && (
        <details className="npi-list-summary">
          <summary>最近部门调整记录</summary>
          {data.history.map((h) => (
            <p key={h.id}>
              {h.name} · 成员 {h.beforeCount} → {h.afterCount} 人 · {h.reason}
              <br />
              <small>
                {h.actorName} · {new Date(h.createdAt).toLocaleString('zh-CN')}
              </small>
            </p>
          ))}
        </details>
      )}
      <Dialog
        open={!!draft}
        onOpenChange={(v) => {
          if (!v && !busy) setDraft(null)
        }}
      >
        <DialogContent className="npi-modal">
          <DialogTitle>
            {draft?.id ? '管理部门成员' : '新建部门分组'}
          </DialogTitle>
          <DialogDescription>
            部门类别决定成员业务岗位，保存后立即生效。生产、采购成员共享同部门任务；设计类不共享项目负责人填写权限。未启用账号不能加入协作。
          </DialogDescription>
          {draft && (
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (busy) return
                const reason = new FormData(e.currentTarget).get('reason')
                setBusy(true)
                setError('')
                try {
                  await api('/departments', 'POST', {
                    id: draft.id,
                    name: draft.name,
                    role: draft.role,
                    memberIds: draft.members,
                    expectedVersion: draft.version,
                    reason,
                  })
                  await onChanged?.()
                  setDraft(null)
                  await load()
                } catch (e) {
                  setError(String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  部门名称
                  <input
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  部门类别
                  <select
                    aria-label="部门类别"
                    value={draft.role}
                    disabled={!!draft.id}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        role: e.target.value as DepartmentCategory,
                        members: [],
                      })
                    }
                  >
                    {Object.entries(departmentCategories).map(
                      ([value, name]) => (
                        <option key={value} value={value}>
                          {name}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <div
                  className="npi-department-members"
                  role="group"
                  aria-label="选择部门成员"
                >
                  {data?.members
                    .filter((m) => m.role === draft.role)
                    .map((m) => (
                      <label key={m.id}>
                        <input
                          type="checkbox"
                          checked={draft.members.includes(m.id)}
                          disabled={
                            (!m.active && !draft.members.includes(m.id)) ||
                            (!!m.departmentId && m.departmentId !== draft.id)
                          }
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              members: e.target.checked
                                ? [...draft.members, m.id]
                                : draft.members.filter((id) => id !== m.id),
                            })
                          }
                        />
                        {m.name} · {m.email}
                        {!m.active
                          ? '（已停用，请移出）'
                          : m.departmentId && m.departmentId !== draft.id
                            ? '（已在其他部门）'
                            : ''}
                      </label>
                    ))}
                </div>
                <label>
                  变更原因
                  <textarea name="reason" required maxLength={2000} />
                </label>
                {error && (
                  <p role="alert" className="npi-error">
                    {error}
                  </p>
                )}
                <div className="npi-actions">
                  <button
                    type="button"
                    className="npi-button secondary"
                    onClick={() => setDraft(null)}
                  >
                    取消
                  </button>
                  <button className="npi-button">
                    {busy
                      ? '正在保存…'
                      : `确认共享范围（${draft.members.length}人）`}
                  </button>
                </div>
              </fieldset>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
