// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveRestore,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  FolderArchive,
  History,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { projectTitle } from '../../lib/npi/project-identity'
import type {
  TrashedProject,
  TrashedProjectDetail,
} from '../../lib/npi/project-trash'
import { stageLabels } from './navigation'
import { NpiPagination, usePagination } from './NpiPagination'
import './project-trash.css'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
const time = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
const day = (value: string) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10)
const message = (error: unknown) =>
  error instanceof Error ? error.message : '读取失败，请重试'
export function NpiProjectTrash({
  api,
  onChanged,
  onBack,
  onOpen,
  revision,
  role,
}: {
  api: Api
  onChanged: () => Promise<void>
  onBack: () => void
  onOpen: (id: string) => void
  revision: number
  role: string
}) {
  const [rows, setRows] = useState<TrashedProject[]>([])
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [query, setQuery] = useState(''),
    [owner, setOwner] = useState(''),
    [stage, setStage] = useState('')
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [sort, setSort] = useState('newest')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<TrashedProjectDetail | null>(null),
    [detailId, setDetailId] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState('')
  const [restore, setRestore] = useState<TrashedProject[]>([]),
    [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false),
    [restoreError, setRestoreError] = useState('')
  const [restored, setRestored] = useState<TrashedProject[]>([])
  const request = useRef(0),
    detailRequest = useRef(0),
    pending = useRef(false)
  const listStart = useRef<HTMLDivElement>(null)
  const load = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    setError('')
    try {
      const result = await api<TrashedProject[]>('/project-trash')
      if (current !== request.current) return
      setRows(result)
      setSelected(new Set())
    } catch (e) {
      if (current === request.current) {
        setRows([])
        setSelected(new Set())
        setError(message(e))
      }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void load()
    return () => {
      request.current++
      detailRequest.current++
    }
  }, [load, revision])
  useEffect(() => {
    setSelected(new Set())
  }, [query, owner, stage, from, to])
  const invalidRange = !!(from && to && from > to)
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return rows
      .filter(
        (r) =>
          !invalidRange &&
          (!q ||
            [
              r.code,
              r.name,
              r.motorModel,
              r.customer,
              r.reason,
              r.deletedByName,
              r.technicalOwnerName,
            ]
              .join(' ')
              .toLocaleLowerCase()
              .includes(q)) &&
          (!owner || r.technicalOwnerId === owner) &&
          (!stage || r.stage === stage) &&
          (!from || day(r.deletedAt) >= from) &&
          (!to || day(r.deletedAt) <= to),
      )
      .sort((a, b) =>
        sort === 'code'
          ? a.code.localeCompare(b.code, 'zh-CN', { numeric: true })
          : (sort === 'oldest' ? 1 : -1) *
              a.deletedAt.localeCompare(b.deletedAt) ||
            a.id.localeCompare(b.id),
      )
  }, [rows, query, owner, stage, from, to, sort, invalidRange])
  const page = usePagination(filtered, 20, listStart)
  const owners = useMemo(
    () => [
      ...new Map(
        rows.map((r) => [r.technicalOwnerId, r.technicalOwnerName]),
      ).entries(),
    ],
    [rows],
  )
  const recent = rows.filter(
    (r) => new Date(r.deletedAt).getTime() >= Date.now() - 7 * 86400000,
  ).length
  const allPage =
    page.items.length > 0 && page.items.every((r) => selected.has(r.id))
  const canAct = !loading && !saving
  const hasFilters = !!(query || owner || stage || from || to)
  function clearFilters() {
    setQuery('')
    setOwner('')
    setStage('')
    setFrom('')
    setTo('')
  }
  function toggle(id: string) {
    setSelected((before) => {
      const next = new Set(before)
      if (next.has(id)) next.delete(id)
      else if (next.size < 50) next.add(id)
      return next
    })
  }
  function selectPage() {
    setSelected((before) => {
      const next = new Set(before)
      for (const row of page.items) {
        if (allPage) next.delete(row.id)
        else if (next.size < 50) next.add(row.id)
      }
      return next
    })
  }
  function beginRestore(items: TrashedProject[]) {
    setRestore(items)
    setReason('')
    setRestoreError('')
  }
  async function inspect(id: string) {
    const current = ++detailRequest.current
    setDetailId(id)
    setDetail(null)
    setDetailError('')
    setDetailLoading(true)
    try {
      const result = await api<TrashedProjectDetail>(`/project-trash/${id}`)
      if (current === detailRequest.current) setDetail(result)
    } catch (e) {
      if (current === detailRequest.current) setDetailError(message(e))
    } finally {
      if (current === detailRequest.current) setDetailLoading(false)
    }
  }
  async function submitRestore() {
    if (pending.current || !reason.trim()) return
    pending.current = true
    setSaving(true)
    setRestoreError('')
    try {
      await api('/project-trash/restore', 'POST', {
        projects: restore.map((r) => ({
          id: r.id,
          expectedVersion: r.version,
        })),
        reason: reason.trim(),
      })
      setRestored(restore)
      setRestore([])
      setDetailId(null)
      setDetail(null)
      setSelected(new Set())
      await load()
      await onChanged()
    } catch (e) {
      setRestoreError(message(e))
      if (
        (e as { status?: number }).status === 409 ||
        (e as { status?: number }).status === 403
      )
        await load()
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  return (
    <section className="npi-trash" aria-label="项目回收站">
      <div className="npi-trash-heading">
        <div>
          <button className="npi-back" onClick={onBack}>
            <ArrowLeft size={16} />
            返回新品项目
          </button>
          <div className="npi-eyebrow">PROJECT RECOVERY</div>
          <h1>项目回收站</h1>
          <p>查看删除记录，核对项目资料，将项目恢复到原有工作流程。</p>
        </div>
        <span className="npi-trash-scope">
          <ShieldCheck size={16} />
          {role === 'admin' ? '全部项目 · 管理员' : '我负责的项目'}
        </span>
      </div>
      <div className="npi-trash-stats">
        <div>
          <FolderArchive size={22} />
          <span>
            待恢复项目
            <strong>
              {loading ? '—' : rows.length}
              <small>个</small>
            </strong>
          </span>
        </div>
        <div>
          <Clock3 size={22} />
          <span>
            近 7 天删除
            <strong>
              {loading ? '—' : recent}
              <small>个</small>
            </strong>
          </span>
        </div>
        <div>
          <ShieldCheck size={22} />
          <span>
            资料完整保留
            <strong className="npi-trash-stat-label">可追溯恢复</strong>
            <small>BOM、承诺、附件及操作记录</small>
          </span>
        </div>
      </div>
      <div className="npi-trash-note">
        <History size={18} />
        <p>
          回收站中的项目暂不进入待办和报表。恢复后沿用原计划、负责人和已有承诺；过期计划可能重新出现逾期提醒。项目不会自动清空。
        </p>
      </div>
      {restored.length > 0 && (
        <div className="npi-message success" role="status">
          <CheckCircle2 size={18} />
          <span>已恢复 {restored.length} 个项目，原有资料与进度已保留。</span>
          {restored.length === 1 && (
            <button
              className="npi-link-button"
              onClick={() => onOpen(restored[0]!.id)}
            >
              打开项目
            </button>
          )}
          <button onClick={() => setRestored([])} aria-label="关闭恢复提示">
            关闭
          </button>
        </div>
      )}
      <div className="npi-trash-panel" ref={listStart}>
        <div className="npi-trash-panel-heading">
          <h2>
            已删除项目 <span>{loading ? '…' : rows.length}</span>
          </h2>
          <small>删除时间均为北京时间</small>
        </div>
        <div className="npi-trash-filters">
          <label className="npi-trash-search">
            <span>搜索项目</span>
            <div>
              <Search size={17} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="编号、型号、项目名称、客户或删除原因"
                maxLength={200}
              />
            </div>
          </label>
          <label>
            技术负责人
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">全部负责人</option>
              {owners.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            删除前阶段
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">全部阶段</option>
              {Object.entries(stageLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            删除日期从
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            删除日期至
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        {invalidRange && (
          <p className="npi-trash-filter-error" role="alert">
            开始日期不能晚于结束日期。
          </p>
        )}
        <div className="npi-trash-toolbar">
          <div>
            <strong>
              {selected.size
                ? `已选 ${selected.size} 项`
                : `筛选结果 ${filtered.length} 项`}
            </strong>
            <span>每次最多恢复 50 项</span>
            <button
              className="npi-link-button npi-trash-select-page"
              disabled={!canAct || !page.items.length}
              onClick={selectPage}
            >
              {allPage ? '取消本页选择' : '选择本页'}
            </button>
            {hasFilters && (
              <button className="npi-link-button" onClick={clearFilters}>
                清除筛选
              </button>
            )}
            {selected.size > 0 && (
              <button
                className="npi-link-button"
                onClick={() => setSelected(new Set())}
              >
                取消选择
              </button>
            )}
          </div>
          <div>
            <label>
              排序
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="newest">最近删除优先</option>
                <option value="oldest">最早删除优先</option>
                <option value="code">项目编号</option>
              </select>
            </label>
            <button
              className="npi-button"
              disabled={!canAct || !selected.size}
              onClick={() =>
                beginRestore(rows.filter((r) => selected.has(r.id)))
              }
            >
              <ArchiveRestore size={16} />
              恢复所选{selected.size > 0 ? `（${selected.size}）` : ''}
            </button>
          </div>
        </div>
        {error ? (
          <div className="npi-trash-empty" role="alert">
            <FolderArchive size={36} />
            <h3>暂时无法读取回收站</h3>
            <p>{error}</p>
            <button
              className="npi-button secondary"
              onClick={() => void load()}
            >
              重新加载
            </button>
          </div>
        ) : loading ? (
          <div className="npi-trash-empty" role="status">
            <FolderArchive size={36} />
            <p>正在读取回收站…</p>
          </div>
        ) : !filtered.length ? (
          <div className="npi-trash-empty">
            <Trash2 size={38} />
            <h3>{rows.length ? '没有符合条件的项目' : '回收站为空'}</h3>
            <p>
              {rows.length
                ? '试试其他关键词，或清除筛选查看全部项目。'
                : '删除的项目会保留在这里，需要时可以恢复。'}
            </p>
            <button
              className="npi-button secondary"
              onClick={rows.length ? clearFilters : onBack}
            >
              {rows.length ? '清除筛选' : '查看新品项目'}
            </button>
          </div>
        ) : (
          <>
            <div className="npi-trash-table-wrap">
              <table className="npi-trash-table">
                <caption>已删除项目列表</caption>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="选择本页项目"
                        checked={allPage}
                        disabled={!canAct}
                        onChange={selectPage}
                      />
                    </th>
                    <th>项目 / 电机型号</th>
                    <th>负责人 / 阶段</th>
                    <th>删除记录</th>
                    <th>删除原因</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((r) => (
                    <tr
                      key={r.id}
                      className={selected.has(r.id) ? 'is-selected' : ''}
                    >
                      <td className="npi-trash-check">
                        <input
                          type="checkbox"
                          aria-label={`选择项目 ${r.code}`}
                          checked={selected.has(r.id)}
                          disabled={
                            !canAct ||
                            (!selected.has(r.id) && selected.size >= 50)
                          }
                          onChange={() => toggle(r.id)}
                        />
                      </td>
                      <td className="npi-trash-project">
                        <button
                          className="npi-trash-project-title"
                          onClick={() => void inspect(r.id)}
                        >
                          {projectTitle(r)}
                        </button>
                        <span>{r.code}</span>
                        <small>{r.customer || '未填写客户'}</small>
                      </td>
                      <td data-label="负责人 / 阶段">
                        <strong>{r.technicalOwnerName}</strong>
                        <span className="npi-trash-stage">
                          {stageLabels[r.stage] || r.stage}
                        </span>
                      </td>
                      <td data-label="删除记录">
                        <time dateTime={r.deletedAt}>{time(r.deletedAt)}</time>
                        <small>
                          {r.deletedByName || '历史记录未注明删除人'}
                        </small>
                      </td>
                      <td data-label="删除原因" className="npi-trash-reason">
                        <span title={r.reason}>{r.reason}</span>
                      </td>
                      <td className="npi-trash-row-actions">
                        <button
                          className="npi-button secondary"
                          disabled={!canAct}
                          onClick={() => void inspect(r.id)}
                        >
                          查看详情
                        </button>
                        <button
                          className="npi-button"
                          disabled={!canAct}
                          onClick={() => beginRestore([r])}
                        >
                          <ArchiveRestore size={15} />
                          恢复
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <NpiPagination label="回收站分页" {...page} disabled={!canAct} />
          </>
        )}
      </div>
      <Dialog
        open={!!detailId}
        onOpenChange={(open) => {
          if (!open) {
            detailRequest.current++
            setDetailId(null)
            setDetail(null)
          }
        }}
      >
        <DialogContent className="npi-modal npi-trash-detail">
          <DialogTitle>已删除项目详情</DialogTitle>
          <DialogDescription>
            核对项目资料与删除记录，再决定是否恢复。
          </DialogDescription>
          {detailLoading && <p role="status">正在读取项目资料…</p>}
          {detailError && (
            <div role="alert">
              <p>{detailError}</p>
              <button
                className="npi-button secondary"
                onClick={() => detailId && void inspect(detailId)}
              >
                重新读取
              </button>
            </div>
          )}
          {detail && (
            <>
              <div className="npi-trash-detail-title">
                <FolderArchive size={24} />
                <div>
                  <h3>{projectTitle(detail.project)}</h3>
                  <p>
                    {detail.project.code} · {stageLabels[detail.project.stage]}
                  </p>
                </div>
              </div>
              <dl className="npi-trash-facts">
                {[
                  ['客户', detail.project.customer || '未填写'],
                  ['技术负责人', detail.project.technicalOwnerName],
                  ['制造负责人', detail.project.manufacturingOwnerName],
                  ['要求齐套日期', detail.project.requiredKitDate],
                  ['样机要求日期', detail.project.prototypeRequiredDate],
                  ['删除时间', time(detail.project.deletedAt)],
                  ['删除人', detail.project.deletedByName || '历史记录未注明'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="npi-trash-detail-reason">
                <strong>删除原因</strong>
                <p>{detail.project.reason}</p>
              </div>
              <h3>保留的项目资料</h3>
              <div className="npi-trash-preserved">
                {[
                  ['BOM 版本', detail.counts.bomVersions],
                  ['跟踪事项', detail.counts.trackingItems],
                  ['附件（含归档）', detail.counts.attachments],
                  ['问题记录', detail.counts.issues],
                ].map(([label, value]) => (
                  <div key={label}>
                    <strong>{value}</strong>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <h3>
                删除与恢复记录 <small>最近 20 条</small>
              </h3>
              <ol className="npi-trash-history">
                {detail.history.map((entry) => (
                  <li key={entry.id}>
                    <div>
                      <strong>
                        {entry.action === 'PROJECT_TRASHED'
                          ? '移入回收站'
                          : '恢复项目'}
                      </strong>
                      <time>{time(entry.createdAt)}</time>
                    </div>
                    <p>
                      {entry.actorName} · {entry.reason}
                    </p>
                  </li>
                ))}
              </ol>
              <div className="npi-trash-dialog-actions">
                <button
                  className="npi-button secondary"
                  onClick={() => setDetailId(null)}
                >
                  关闭
                </button>
                <button
                  className="npi-button"
                  onClick={() => {
                    beginRestore([detail.project])
                    setDetailId(null)
                  }}
                >
                  <ArchiveRestore size={16} />
                  恢复此项目
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={restore.length > 0}
        onOpenChange={(open) => {
          if (!open && !saving) setRestore([])
        }}
      >
        <DialogContent
          className="npi-modal npi-trash-restore"
          onEscapeKeyDown={(e) => {
            if (saving) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (saving) e.preventDefault()
          }}
        >
          <DialogTitle>
            确认恢复{restore.length > 1 ? ` ${restore.length} 个项目` : '项目'}
          </DialogTitle>
          <DialogDescription>
            恢复后项目重新进入列表、待办和报表，原有计划、承诺及历史记录保持完整。
          </DialogDescription>
          <ul className="npi-trash-restore-list">
            {restore.map((r) => (
              <li key={r.id}>
                <strong>{projectTitle(r)}</strong>
                <span>
                  {r.code} · {r.technicalOwnerName}
                </span>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submitRestore()
            }}
          >
            <label>
              恢复原因
              <textarea
                autoFocus
                required
                maxLength={2000}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={saving}
                placeholder="例如：项目重新启动，继续按原计划跟进"
              />
            </label>
            <p className="npi-muted">
              原因将写入每个项目的操作记录。批量恢复统一提交，任何项目状态冲突时都不会恢复。
            </p>
            {restoreError && (
              <div className="npi-message error" role="alert">
                {restoreError}
                <span>请关闭弹窗、核对最新列表后重新选择。</span>
              </div>
            )}
            <div className="npi-trash-dialog-actions">
              <button
                type="button"
                className="npi-button secondary"
                disabled={saving}
                onClick={() => setRestore([])}
              >
                取消
              </button>
              <button
                className="npi-button"
                disabled={saving || !reason.trim() || !!restoreError}
              >
                <ArchiveRestore size={16} />
                {saving ? '正在恢复…' : `确认恢复（${restore.length}）`}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
