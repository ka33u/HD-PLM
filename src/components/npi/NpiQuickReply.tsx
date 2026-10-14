// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarCheck,
  CheckCheck,
  CornerDownLeft,
  RefreshCw,
  Search,
  Send,
  Zap,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import { NpiPagination, usePagination } from './NpiPagination'
import type {
  QuickReplyItems,
  batchReplyMaterials,
} from '../../lib/npi/service'
import { selectRange } from './table-selection'
import './quick-reply.css'

type Item = QuickReplyItems['items'][number]
type Draft = { date: string; reason: string; version: number; name: string }
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
const canEdit = (r: Item) =>
  !r.actualCompleteDate &&
  r.currentNpiStage !== 'completed' &&
  (r.trackingEnabled || r.affectsKit) &&
  r.bomReference?.current !== false
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value
const pastedDate = (value: string) => {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.trim())
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : ''
}
export function NpiQuickReply({
  api,
  actorId,
  kind,
  projectId,
  itemIds,
  onClose,
  onSaved,
}: {
  api: Api
  actorId: string
  kind: 'manufacturing' | 'procurement'
  projectId?: string
  itemIds?: string[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [data, setData] = useState<QuickReplyItems | null>(null),
    [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState(''),
    [project, setProject] = useState(''),
    [filter, setFilter] = useState(itemIds ? 'all' : 'pending')
  const [pageSize, setPageSize] = useState(50)
  const submittedIds = useRef(new Set<string>())
  const anchor = useRef<string | null>(null),
    initialized = useRef(false)
  const scope = useMemo(() => (itemIds ? new Set(itemIds) : null), [itemIds])
  const [mode, setMode] = useState<'promise' | 'complete'>('promise')
  const [batchDate, setBatchDate] = useState(''),
    [reason, setReason] = useState('')
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false)
  const [needsReload, setNeedsReload] = useState(false),
    [closeConfirm, setCloseConfirm] = useState(false)
  const pending = useRef(false),
    request = useRef(0),
    nextFocus = useRef<string | null>(null)
  const inputs = useRef(new Map<string, HTMLInputElement>()),
    list = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () => (data?.items || []).filter((r) => !scope || scope.has(r.id)),
    [data, scope],
  )
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  const changes = Object.entries(drafts).filter(
    ([id, d]) =>
      mode === 'complete' || d.date !== rowMap.get(id)?.currentCommittedDate,
  )
  const blocked = changes.filter(
    ([id, d]) =>
      !rowMap.has(id) ||
      !canEdit(rowMap.get(id)!) ||
      rowMap.get(id)!.version !== d.version,
  )
  const missingReason =
    mode === 'promise'
      ? changes.filter(
          ([id, d]) =>
            rowMap.get(id)?.currentCommittedDate &&
            !d.reason.trim() &&
            !reason.trim(),
        )
      : []
  const invalid = changes.filter(
    ([, d]) =>
      !validDate(d.date) ||
      (mode === 'complete' && data && d.date > data.today),
  )
  const visible = useMemo(
    () =>
      rows
        .filter(
          (r) =>
            (!project || r.programId === project) &&
            [
              r.projectCode,
              r.motorModel,
              r.projectName,
              r.name,
              r.specification,
              r.bomReference?.materialCode,
              r.ownerName,
              r.supplier,
            ]
              .join(' ')
              .toLowerCase()
              .includes(query.trim().toLowerCase()) &&
            (filter === 'all' ||
              (filter === 'drafts'
                ? !!drafts[r.id]
                : filter === 'pending'
                  ? !r.currentCommittedDate
                  : filter === 'replied'
                    ? !!r.currentCommittedDate
                    : r.bomReference?.current === false)),
        )
        .sort(
          (a, b) =>
            a.projectCode.localeCompare(b.projectCode, 'zh-CN', {
              numeric: true,
            }) ||
            (a.bomReference?.rowNo || 0) - (b.bomReference?.rowNo || 0) ||
            a.id.localeCompare(b.id),
        ),
    [rows, project, query, filter, filter === 'drafts' ? drafts : null],
  )
  const page = usePagination(visible, pageSize, list)
  const projects = [
    ...new Map(
      rows.map((r) => [r.programId, `${r.projectCode} · ${r.motorModel}`]),
    ).entries(),
  ]
  const pageEditable = page.items.filter(canEdit),
    allPage =
      !!pageEditable.length && pageEditable.every((r) => selected.has(r.id))
  const busy = loading || saving
  const load = useCallback(async () => {
    const seq = ++request.current
    setLoading(true)
    setError('')
    try {
      const result = await api<QuickReplyItems>(
        `/workbench/quick-replies?kind=${kind}${projectId ? `&projectId=${projectId}` : ''}`,
      )
      if (seq !== request.current) return
      if (result.actorId !== actorId)
        throw new Error('登录账号已变化，请整页刷新')
      setData(result)
      setNeedsReload(false)
      setSelected(
        new Set(
          !initialized.current && scope
            ? result.items
                .filter((r) => scope.has(r.id) && canEdit(r))
                .slice(0, 50)
                .map((r) => r.id)
            : [],
        ),
      )
      initialized.current = true
    } catch (e) {
      if (seq === request.current) {
        setError(e instanceof Error ? e.message : '读取失败')
        setNeedsReload(true)
      }
    } finally {
      if (seq === request.current) setLoading(false)
    }
  }, [api, actorId, kind, projectId, scope])
  useEffect(() => {
    void load()
    return () => {
      request.current++
    }
  }, [load])
  useEffect(() => {
    setSelected(new Set())
  }, [query, project, filter])
  useEffect(() => {
    const id = nextFocus.current
    if (!id || busy) return
    const index = visible.findIndex((r) => r.id === id)
    if (index < 0) {
      nextFocus.current = null
      return
    }
    const targetPage = Math.floor(index / pageSize) + 1
    if (targetPage !== page.page) page.onPage(targetPage)
    else if (inputs.current.has(id)) {
      inputs.current.get(id)!.focus()
      nextFocus.current = null
    }
  })
  useEffect(() => {
    if (!changes.length) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [changes.length])
  function edit(row: Item, date: string, rowReason?: string) {
    setDrafts((previous) => ({
      ...previous,
      [row.id]: {
        version: previous[row.id]?.version ?? row.version,
        date,
        reason: rowReason ?? previous[row.id]?.reason ?? '',
        name: `${row.bomReference?.materialCode || ''} ${row.name}`,
      },
    }))
  }
  function applyDate(useRequired = false) {
    if (!useRequired && !validDate(batchDate)) {
      setError('请先选择统一日期')
      return
    }
    if (mode === 'complete' && batchDate > (data?.today || '')) {
      setError('实际完成日期不能在未来')
      return
    }
    const targets = rows.filter((r) => selected.has(r.id) && canEdit(r))
    const total = new Set([
      ...changes.map(([id]) => id),
      ...targets.map((r) => r.id),
    ]).size
    if (total > 50) {
      setError('每批最多填写50项，请先提交当前内容')
      return
    }
    setDrafts((previous) => {
      const next = { ...previous }
      for (const row of targets)
        next[row.id] = {
          version: previous[row.id]?.version ?? row.version,
          date: useRequired ? row.requiredDate : batchDate,
          reason: previous[row.id]?.reason || '',
          name: `${row.bomReference?.materialCode || ''} ${row.name}`,
        }
      return next
    })
    setError('')
    setNotice(`已填入 ${targets.length} 项，核对后点击底部提交。`)
  }
  function nextRow(row: Item, backwards = false) {
    const index = visible.findIndex((r) => r.id === row.id)
    const next = (
      backwards ? visible.slice(0, index).reverse() : visible.slice(index + 1)
    ).find(canEdit)
    if (!next) {
      setNotice(
        backwards
          ? '已到第一个可回复部件。'
          : '已到最后一个可回复部件，可以提交本次填写。',
      )
      return
    }
    nextFocus.current = next.id
    const nextPage =
      Math.floor(visible.findIndex((r) => r.id === next.id) / pageSize) + 1
    if (nextPage !== page.page) page.onPage(nextPage)
    else {
      inputs.current.get(next.id)?.focus()
      nextFocus.current = null
    }
  }
  function copyPrevious(row: Item) {
    const previous = visible
      .slice(
        0,
        visible.findIndex((r) => r.id === row.id),
      )
      .reverse()
      .find(canEdit)
    const value = previous
      ? (drafts[previous.id]?.date ??
        (mode === 'promise' ? previous.currentCommittedDate || '' : ''))
      : ''
    if (
      !validDate(value) ||
      (mode === 'complete' && value > (data?.today || ''))
    ) {
      setError('上一行没有可沿用的有效日期，请先填写上一行')
      return
    }
    if (!drafts[row.id] && changes.length >= 50) {
      setError('每批最多填写50项，请先提交当前内容')
      return
    }
    edit(row, value)
    setError('')
  }
  function pasteDates(row: Item, text: string) {
    const dates = text.trim().split(/\r?\n/).map(pastedDate)
    const targets = visible
      .slice(visible.findIndex((r) => r.id === row.id))
      .filter(canEdit)
      .slice(0, dates.length)
    if (
      dates.length > 50 ||
      targets.length !== dates.length ||
      dates.some(
        (d) =>
          !validDate(d) || (mode === 'complete' && d > (data?.today || '')),
      )
    ) {
      setError(
        '请粘贴一列有效日期（如2026-10-20），行数不能超过当前可回复部件或50项；实际日期不能在未来。',
      )
      return
    }
    if (
      new Set([...changes.map(([id]) => id), ...targets.map((r) => r.id)])
        .size > 50
    ) {
      setError('本次填写超过50项，请先提交当前内容')
      return
    }
    targets.forEach((r, i) => edit(r, dates[i]!))
    setError('')
    setNotice(`已按当前列表顺序粘贴 ${dates.length} 个日期，请核对部件后提交。`)
  }
  function close() {
    if (!pending.current) {
      if (changes.length) setCloseConfirm(true)
      else onClose()
    }
  }
  async function submit() {
    if (pending.current || busy || needsReload || !changes.length) return
    if (
      blocked.length ||
      missingReason.length ||
      invalid.length ||
      changes.length > 50
    ) {
      setError('请先处理标出的日期、改期原因或记录冲突后再提交')
      return
    }
    pending.current = true
    setSaving(true)
    setError('')
    setNotice('')
    let committed = false
    try {
      const result = await api<Awaited<ReturnType<typeof batchReplyMaterials>>>(
        '/tracking/batch-reply',
        'POST',
        {
          operation: mode,
          reason,
          items: changes.map(([id, d]) => ({
            id,
            expectedVersion: d.version,
            date: d.date,
            reason: d.reason,
          })),
        },
      )
      committed = true
      setDrafts({})
      setSelected(new Set())
      setReason('')
      const saved = new Map(result.items.map((r) => [r.id, r]))
      for (const id of saved.keys()) submittedIds.current.add(id)
      const remaining = visible.filter(
        (r) => !submittedIds.current.has(r.id) && canEdit(r),
      )
      nextFocus.current = remaining[0]?.id || null
      if (scope) setSelected(new Set(remaining.slice(0, 50).map((r) => r.id)))
      setData(
        (before) =>
          before && {
            ...before,
            items: before.items
              .filter((r) => mode !== 'complete' || !saved.has(r.id))
              .map((r) =>
                saved.has(r.id) ? { ...r, ...saved.get(r.id)! } : r,
              ),
          },
      )
      setNotice(
        `已${mode === 'promise' ? '回复' : '确认实际完成'} ${result.items.length} 个部件，记录已保存。`,
      )
      await onSaved()
    } catch (e) {
      setError(
        `${committed ? '记录已保存，外部列表暂未刷新。' : '本次未确认保存，填写内容已保留，请重新读取并核对。'}${e instanceof Error ? e.message : ''}`,
      )
      if (!committed) setNeedsReload(true)
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="npi-modal npi-quick-dialog"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        onEscapeKeyDown={(e) => {
          if (saving || changes.length) {
            e.preventDefault()
            close()
          }
        }}
        onInteractOutside={(e) => {
          if (saving || changes.length) e.preventDefault()
        }}
      >
        <header className="npi-quick-heading">
          <div className="npi-quick-icon">
            <Zap size={24} />
          </div>
          <div>
            <DialogTitle>
              {kind === 'procurement' ? '采购' : '生产'}完成时间快速回复
            </DialogTitle>
            <DialogDescription>
              Enter 下一行 · Ctrl / ⌘ + D 沿用上一行 · 支持粘贴一列日期 ·
              每批最多50项
            </DialogDescription>
          </div>
        </header>
        {closeConfirm ? (
          <div className="npi-quick-exit" role="alert">
            <strong>还有 {changes.length} 项填写未提交</strong>
            <p>继续填写可保留当前内容，关闭后未提交的日期会丢失。</p>
            <button
              className="npi-button"
              onClick={() => setCloseConfirm(false)}
            >
              继续填写
            </button>
            <button className="npi-button secondary" onClick={onClose}>
              放弃填写并关闭
            </button>
          </div>
        ) : (
          <>
            <div className="npi-quick-modes">
              <div role="group" aria-label="回复类型">
                <button
                  aria-pressed={mode === 'promise'}
                  disabled={saving}
                  onClick={() => {
                    if (changes.length)
                      setError('请先提交或撤回本次填写，再切换回复类型')
                    else {
                      submittedIds.current.clear()
                      setMode('promise')
                      setDrafts({})
                      setSelected(new Set())
                      setBatchDate('')
                      setReason('')
                      setNotice('')
                      setFilter(scope ? 'all' : 'pending')
                      setError('')
                    }
                  }}
                >
                  <CalendarCheck size={16} />
                  预计{kind === 'procurement' ? '到货' : '完成'}日期
                </button>
                <button
                  aria-pressed={mode === 'complete'}
                  disabled={saving}
                  onClick={() => {
                    if (changes.length)
                      setError('请先提交或撤回本次填写，再切换回复类型')
                    else {
                      submittedIds.current.clear()
                      setMode('complete')
                      setDrafts({})
                      setSelected(new Set())
                      setBatchDate('')
                      setReason('')
                      setNotice('')
                      setFilter('all')
                      setError('')
                    }
                  }}
                >
                  <CheckCheck size={16} />
                  实际{kind === 'procurement' ? '到货' : '完成'}
                </button>
              </div>
              <span>
                {mode === 'promise'
                  ? '回复预计日期，保留首次承诺'
                  : '仅填写已实际完成的部件，提交后计入已完成'}
              </span>
            </div>
            {scope && (
              <p className="npi-quick-scope">
                仅显示从 BOM 带入的 {scope.size} 项 · 当前可回复{' '}
                {rows.filter(canEdit).length} 项
                {scope.size > 50 ? ' · 分批填写，每批最多50项' : ''}
              </p>
            )}
            <div className="npi-quick-filters">
              <label className="npi-quick-search">
                <Search size={16} />
                <input
                  aria-label="搜索快速回复部件"
                  placeholder="搜索编码 / 名称 / 型号 / 供应商"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={200}
                />
              </label>
              {!projectId && (
                <select
                  aria-label="快速回复项目"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">全部项目</option>
                  {projects.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="快速回复状态"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="pending">
                  待回复（{rows.filter((r) => !r.currentCommittedDate).length}）
                </option>
                <option value="all">全部未完成</option>
                <option value="replied">已回复 / 改期</option>
                <option value="review">待BOM复核</option>
                <option value="drafts">本次已填</option>
              </select>
              <select
                aria-label="每页显示"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  page.onPage(1)
                }}
                disabled={busy}
              >
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    每页 {n} 行
                  </option>
                ))}
              </select>
              <button
                className="npi-button secondary"
                disabled={busy}
                onClick={() => void load()}
              >
                <RefreshCw size={15} />
                重新读取
              </button>
            </div>
            <div className="npi-quick-batch">
              <label className="npi-quick-selection">
                <input
                  type="checkbox"
                  checked={allPage}
                  ref={(node) => {
                    if (node)
                      node.indeterminate =
                        !allPage && pageEditable.some((r) => selected.has(r.id))
                  }}
                  disabled={busy || !pageEditable.length}
                  onChange={() =>
                    setSelected((before) => {
                      const next = new Set(before)
                      for (const r of pageEditable) {
                        if (allPage) next.delete(r.id)
                        else if (next.size < 50) next.add(r.id)
                      }
                      return next
                    })
                  }
                />
                本页可回复
              </label>
              <strong>已选 {selected.size} 项</strong>
              <button
                className="npi-quick-link"
                disabled={busy || !visible.some(canEdit)}
                onClick={() =>
                  setSelected(
                    new Set(
                      visible
                        .filter(canEdit)
                        .slice(0, 50)
                        .map((r) => r.id),
                    ),
                  )
                }
              >
                选择前50项
              </button>
              <input
                type="date"
                aria-label="统一填写日期"
                value={batchDate}
                max={mode === 'complete' ? data?.today : undefined}
                onChange={(e) => setBatchDate(e.target.value)}
                disabled={busy}
              />
              <button
                className="npi-button"
                disabled={busy || !selected.size || needsReload}
                onClick={() => applyDate()}
              >
                统一填入
              </button>
              {mode === 'promise' && (
                <button
                  className="npi-button secondary"
                  disabled={busy || !selected.size || needsReload}
                  onClick={() => applyDate(true)}
                >
                  按各自要求日期
                </button>
              )}
              {mode === 'complete' && (
                <button
                  className="npi-button secondary"
                  disabled={busy}
                  onClick={() => setBatchDate(data?.today || '')}
                >
                  今天
                </button>
              )}
              {!!selected.size && (
                <button
                  className="npi-quick-link"
                  onClick={() => setSelected(new Set())}
                >
                  取消选择
                </button>
              )}
            </div>
            {error && (
              <p className="npi-message error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="npi-message success" role="status">
                {notice}
              </p>
            )}
            {!!blocked.length && (
              <div className="npi-quick-conflicts" role="alert">
                <strong>
                  {blocked.length} 项已变化或不再可回复，已保留你的填写
                </strong>
                {blocked.map(([id, d]) => {
                  const latest = rowMap.get(id)
                  return (
                    <div key={id}>
                      <span>
                        {d.name}：你的填写 {d.date || '未填'}；最新承诺{' '}
                        {latest?.currentCommittedDate || '—'}
                        {!latest || !canEdit(latest)
                          ? '（已完成、转交或BOM待复核）'
                          : ''}
                      </span>
                      {latest && canEdit(latest) && (
                        <button
                          className="npi-button secondary"
                          disabled={busy}
                          onClick={() =>
                            setDrafts((before) => ({
                              ...before,
                              [id]: { ...d, version: latest.version },
                            }))
                          }
                        >
                          已核对，保留我的日期
                        </button>
                      )}
                      <button
                        className="npi-quick-link"
                        disabled={busy}
                        onClick={() =>
                          setDrafts((before) => {
                            const next = { ...before }
                            delete next[id]
                            return next
                          })
                        }
                      >
                        撤回此项填写
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="npi-quick-table-wrap" ref={list}>
              {loading && !data ? (
                <p className="npi-empty" role="status">
                  正在读取可回复部件…
                </p>
              ) : (
                <table className="npi-quick-table npi-quick-dense">
                  <caption>部件日期快速回复清单</caption>
                  <thead>
                    <tr>
                      <th>选择</th>
                      <th>部件 / 编码</th>
                      <th>{projectId ? '负责人' : '项目 / 负责人'}</th>
                      <th>要求日期</th>
                      <th>
                        {mode === 'promise' ? '本次预计日期' : '本次实际日期'}
                      </th>
                      <th>{mode === 'promise' ? '改期原因' : '填写状态'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((row) => {
                      const draft = drafts[row.id],
                        date =
                          draft?.date ??
                          (mode === 'promise'
                            ? row.currentCommittedDate || ''
                            : ''),
                        locked = !canEdit(row)
                      const changed =
                        !!draft &&
                        (mode === 'complete' ||
                          date !== row.currentCommittedDate)
                      return (
                        <tr
                          key={row.id}
                          data-quick-item={row.id}
                          className={changed ? 'is-dirty' : ''}
                        >
                          <td className="npi-quick-check">
                            <input
                              type="checkbox"
                              aria-label={`选择 ${row.bomReference?.materialCode || row.name} ${row.bomReference?.rowNo || ''}`}
                              disabled={
                                busy ||
                                locked ||
                                (!selected.has(row.id) && selected.size >= 50)
                              }
                              checked={selected.has(row.id)}
                              onChange={(e) => {
                                const shift = Boolean(
                                  (e.nativeEvent as MouseEvent).shiftKey,
                                )
                                setSelected(
                                  (before) =>
                                    new Set(
                                      selectRange(
                                        [...before],
                                        visible
                                          .filter(canEdit)
                                          .map((r) => r.id),
                                        row.id,
                                        e.target.checked,
                                        anchor.current,
                                        shift,
                                        50,
                                      ),
                                    ),
                                )
                                anchor.current = row.id
                              }}
                            />
                          </td>
                          <td
                            data-label="部件"
                            title={`${row.name} · ${row.specification} · ${row.qty}${row.unit}\n${row.bomReference ? `${row.bomReference.materialCode} · V${row.bomReference.versionNo} 第${row.bomReference.rowNo}行` : row.sourceType === 'WHOLE_MACHINE' ? '整机' : row.sourceType === 'TOOLING' ? '工装' : 'BOM外物料'}`}
                          >
                            <span className="npi-quick-part">
                              <strong>{row.name}</strong>
                              <span>
                                {row.bomReference?.materialCode ||
                                  (row.sourceType === 'WHOLE_MACHINE'
                                    ? '整机'
                                    : row.sourceType === 'TOOLING'
                                      ? '工装'
                                      : 'BOM外')}
                              </span>
                            </span>
                            {locked && (
                              <span className="npi-warning-text">
                                BOM已换版，先复核再回复
                              </span>
                            )}
                          </td>
                          <td
                            data-label="项目 / 负责人"
                            title={`${row.projectCode} · ${row.motorModel} · ${row.ownerName} · ${row.supplier || ''}`}
                          >
                            {projectId
                              ? row.ownerName
                              : `${row.projectCode} · ${row.ownerName}`}
                          </td>
                          <td
                            data-label="要求日期"
                            title={`当前 ${row.currentCommittedDate || '待回复'}；首次 ${row.firstCommittedDate || '待回复'}`}
                          >
                            {row.requiredDate}
                          </td>
                          <td
                            data-label={
                              mode === 'promise' ? '预计日期' : '实际日期'
                            }
                          >
                            <input
                              ref={(node) => {
                                if (node) inputs.current.set(row.id, node)
                                else inputs.current.delete(row.id)
                              }}
                              type="date"
                              aria-label={`日期 ${row.bomReference?.materialCode || row.name} ${row.bomReference?.rowNo || ''}`}
                              value={date}
                              title={
                                changed
                                  ? !validDate(date)
                                    ? '请填写有效日期'
                                    : mode === 'promise' &&
                                        date > row.requiredDate
                                      ? '晚于要求日期 · 待提交'
                                      : '待提交'
                                  : `当前承诺 ${row.currentCommittedDate || '未回复'}；首次 ${row.firstCommittedDate || '未回复'}`
                              }
                              aria-invalid={
                                changed &&
                                (!validDate(date) ||
                                  (mode === 'complete' &&
                                    date > (data?.today || '')))
                              }
                              max={
                                mode === 'complete' ? data?.today : undefined
                              }
                              disabled={busy || locked || needsReload}
                              onChange={(e) => edit(row, e.target.value)}
                              onKeyDown={(e) => {
                                if (
                                  (e.ctrlKey || e.metaKey) &&
                                  e.key.toLowerCase() === 'd'
                                ) {
                                  e.preventDefault()
                                  copyPrevious(row)
                                  return
                                }
                                if (
                                  e.key === 'Enter' &&
                                  !e.ctrlKey &&
                                  !e.metaKey
                                ) {
                                  e.preventDefault()
                                  nextRow(row, e.shiftKey)
                                }
                              }}
                              onPaste={(e) => {
                                e.preventDefault()
                                pasteDates(row, e.clipboardData.getData('text'))
                              }}
                            />
                            {changed &&
                              (!validDate(date) ||
                                (mode === 'complete' &&
                                  date > (data?.today || ''))) && (
                                <small
                                  className={
                                    !validDate(date) ||
                                    (mode === 'complete' &&
                                      date > (data?.today || ''))
                                      ? 'npi-warning-text'
                                      : 'npi-quick-dirty'
                                  }
                                >
                                  {!validDate(date)
                                    ? '请填写有效日期'
                                    : mode === 'complete' &&
                                        date > (data?.today || '')
                                      ? '实际日期不能在未来'
                                      : mode === 'promise' &&
                                          date > row.requiredDate
                                        ? '晚于要求日期'
                                        : '待提交'}
                                </small>
                              )}
                          </td>
                          <td data-label="原因">
                            {mode === 'promise' &&
                            changed &&
                            row.currentCommittedDate ? (
                              <input
                                aria-label={`原因 ${row.bomReference?.materialCode || row.name} ${row.bomReference?.rowNo || ''}`}
                                value={draft?.reason || ''}
                                placeholder={
                                  reason.trim()
                                    ? '使用下方统一原因'
                                    : '改期必填，可统一填写'
                                }
                                maxLength={2000}
                                disabled={busy}
                                onChange={(e) =>
                                  edit(row, date, e.target.value)
                                }
                              />
                            ) : (
                              <small>
                                {changed
                                  ? mode === 'complete'
                                    ? '待确认完成'
                                    : '首次回复'
                                  : '—'}
                              </small>
                            )}
                            {changed && (
                              <button
                                className="npi-quick-link"
                                disabled={busy}
                                onClick={() =>
                                  setDrafts((before) => {
                                    const next = { ...before }
                                    delete next[row.id]
                                    return next
                                  })
                                }
                              >
                                撤回填写
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
              {!loading && data && !visible.length && (
                <div className="npi-empty">
                  <h3>当前没有符合条件的部件</h3>
                  <p>
                    {rows.length
                      ? '可切换“全部未完成”或清空筛选。'
                      : '已分配给你或同部门成员的部件会出现在这里。BOM物料默认分给制造负责人；换版后请先完成复核。'}
                  </p>
                  <button
                    className="npi-button secondary"
                    onClick={() => {
                      setQuery('')
                      setProject('')
                      setFilter('all')
                    }}
                  >
                    查看全部未完成
                  </button>
                </div>
              )}
            </div>
            <NpiPagination label="快速回复分页" {...page} disabled={busy} />
            <footer className="npi-quick-footer">
              {mode === 'promise' && (
                <label>
                  统一改期原因{' '}
                  <input
                    aria-label="统一改期原因"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={2000}
                    disabled={saving}
                    placeholder="仅用于已有承诺的改期；逐行原因优先"
                  />
                </label>
              )}
              <div className="npi-quick-savebar">
                <div>
                  <strong>本次 {changes.length} 项待提交</strong>
                  <small>
                    {missingReason.length
                      ? `${missingReason.length} 项改期缺少原因 · `
                      : ''}
                    {
                      changes.filter(
                        ([id]) => !visible.some((r) => r.id === id),
                      ).length
                    }{' '}
                    项在当前筛选外 · 最多50项
                  </small>
                </div>
                <span className="npi-quick-keyboard">
                  <CornerDownLeft size={14} />
                  Enter 下一行 · Shift + Enter 上一行
                  <br />
                  Ctrl / ⌘ + D 沿用日期 · Ctrl / ⌘ + Enter 提交
                </span>
                <button
                  className="npi-button secondary"
                  disabled={saving}
                  onClick={close}
                >
                  关闭
                </button>
                <button
                  className="npi-button"
                  disabled={
                    busy ||
                    needsReload ||
                    !changes.length ||
                    !!blocked.length ||
                    !!invalid.length ||
                    !!missingReason.length ||
                    changes.length > 50
                  }
                  onClick={() => void submit()}
                >
                  <Send size={16} />
                  {saving
                    ? '正在提交…'
                    : mode === 'promise'
                      ? `提交 ${changes.length} 项回复`
                      : `确认 ${changes.length} 项已实际完成`}
                </button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
