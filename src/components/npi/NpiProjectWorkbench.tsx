// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Search, Zap } from 'lucide-react'
import { NpiBomTable } from './NpiBomTable'
import { NpiDeliveryList } from './NpiDeliveryList'
import { NpiPagination, usePagination } from './NpiPagination'
import { stageLabels } from './navigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { ReactNode } from 'react'
import type { BomRow } from '../../lib/npi/bom'
import type { NpiMetadata, NpiTracking } from '../../lib/npi/service'
import type { ProjectWorkbench } from '../../lib/npi/project-workbench'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiProjectWorkbench({
  api,
  meta,
  kind,
  projectId,
  revision,
  onSelect,
  onOpenProject,
  onQuick,
  onReply,
  onDetails,
  canReply,
  renderTable,
}: {
  api: Api
  meta: NpiMetadata
  kind: 'manufacturing' | 'procurement'
  projectId: string | null
  revision: number
  onSelect: (id: string | null) => void
  onOpenProject: (id: string) => void
  onQuick: (id: string, itemIds?: string[]) => void
  onReply: (item: NpiTracking) => void
  onDetails: (item: NpiTracking) => void
  canReply: (item: NpiTracking) => boolean
  renderTable: (items: NpiTracking[]) => ReactNode
}) {
  const [data, setData] = useState<ProjectWorkbench | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [query, setQuery] = useState(''),
    [includeClosed, setIncludeClosed] = useState(false),
    [status, setStatus] = useState('all'),
    [mine, setMine] = useState(
      ['manufacturing', 'procurement'].includes(meta.actor.role),
    )
  const [selected, setSelected] = useState<string[]>([]),
    [collapsed, setCollapsed] = useState(new Set<string>()),
    [details, setDetails] = useState<BomRow | null>(null),
    [tab, setTab] = useState('bom')
  const start = useRef<HTMLDivElement>(null),
    generation = useRef(0)
  useEffect(() => {
    const request = ++generation.current
    setLoading(true)
    setError('')
    void api<ProjectWorkbench>(
      `/workbench/projects?kind=${kind}${projectId ? `&projectId=${projectId}` : ''}`,
    )
      .then((next) => {
        if (request !== generation.current) return
        if (next.actorId !== meta.actor.id)
          throw new Error('登录账号已改变，请整页刷新')
        setData(next)
        setSelected([])
      })
      .catch((e) => {
        if (request === generation.current) {
          setData(null)
          setError(e instanceof Error ? e.message : '读取失败')
        }
      })
      .finally(() => {
        if (request === generation.current) setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [api, kind, projectId, revision, meta.actor.id])
  useEffect(() => {
    setQuery('')
    setStatus('all')
    setSelected([])
    setCollapsed(new Set())
    setTab('bom')
    setDetails(null)
  }, [projectId, kind])
  const projects = useMemo(
    () =>
      (data?.projects || []).filter(
        (p) =>
          (includeClosed || p.currentNpiStage !== 'completed') &&
          [p.name, p.motorType, p.motorModel, p.code]
            .join(' ')
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [data, query, includeClosed],
  )
  const projectPage = usePagination(projects, 24, start)
  const tasks = useMemo(
    () =>
      new Map(
        (data?.items || [])
          .filter((i) => i.bomReference?.current)
          .map((i) => [i.bomItemId, i]),
      ),
    [data],
  )
  const owned = (i: NpiTracking) =>
    meta.actor.role === 'admin' ||
    i.ownerId === meta.actor.id ||
    !!meta.actor.collaboratorIds?.includes(i.ownerId)
  const filtered = useMemo(() => {
    const rows = data?.rows || [],
      byId = new Map(rows.map((r) => [r.id, r])),
      keep = new Set<string>(),
      matching = new Set<string>()
    for (const r of rows) {
      const t = tasks.get(r.id)
      if (mine && (!t || !owned(t))) continue
      if (
        status !== 'all' &&
        (!t ||
          (status === 'unfinished'
            ? !!t.actualCompleteDate
            : t.status !== status))
      )
        continue
      if (
        ![r.materialCode, r.materialName, r.specification, t?.ownerName]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      )
        continue
      matching.add(r.id)
      keep.add(r.id)
      let parent = r.parentId
      while (parent && !keep.has(parent)) {
        keep.add(parent)
        parent = byId.get(parent)?.parentId || null
      }
    }
    return {
      matching,
      rows: rows.filter((r) => {
        if (!keep.has(r.id)) return false
        let parent = r.parentId
        while (parent) {
          if (collapsed.has(parent)) return false
          parent = byId.get(parent)?.parentId || null
        }
        return true
      }),
    }
  }, [data, tasks, query, status, mine, collapsed, meta.actor])
  const bomPage = usePagination(filtered.rows, 100, start)
  const parents = useMemo(
    () => new Set((data?.rows || []).map((r) => r.parentId)),
    [data],
  )
  const project = data?.project
  const currentSelection = selected
    .map((id) => tasks.get(id))
    .filter((i): i is NpiTracking => !!i && canReply(i))
  const replyable = (data?.items || []).filter(canReply)
  const extras = (data?.items || []).filter(
    (i) => i.sourceType !== 'ERP_BOM' || i.bomReference?.current === false,
  )
  const title = kind === 'manufacturing' ? '生产项目' : '采购项目'
  if (loading)
    return (
      <p role="status" className="npi-module-empty">
        正在读取{projectId ? '项目 BOM' : title}…
      </p>
    )
  if (error)
    return (
      <section className="npi-panel">
        <p role="alert" className="npi-error">
          {error}
        </p>
        <button className="npi-button secondary" onClick={() => onSelect(null)}>
          返回项目列表
        </button>
      </section>
    )
  if (!projectId)
    return (
      <section className="npi-workbench-projects" aria-label={title}>
        <div className="npi-workbench-toolbar">
          <label className="npi-workbench-search">
            <Search size={16} />
            <input
              aria-label="搜索任务项目"
              type="search"
              placeholder="订单编号 / 电机型号 / 电机类型"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="npi-checkbox">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
            />
            包含已结束项目
          </label>
          <span>{projects.length} 个项目</span>
        </div>
        <div ref={start} className="npi-workbench-cards">
          {projectPage.items.map((p) => (
            <button
              className="npi-workbench-card"
              data-workbench-project={p.id}
              key={p.id}
              onClick={() => onSelect(p.id)}
              aria-label={`打开${p.code}项目BOM`}
            >
              <div className="npi-workbench-card-top">
                <span>{p.code}</span>
                <span>{stageLabels[p.currentNpiStage]}</span>
              </div>
              <h2>{p.motorModel}</h2>
              <p>
                {p.motorType || p.name}
                <span>
                  订单{' '}
                  {p.orderQuantity ? `${p.orderQuantity} 台` : '台数未填写'}
                </span>
              </p>
              <div className="npi-workbench-counts">
                <span>
                  <b>{p.counts.pending}</b>待回复
                </span>
                <span>
                  <b>{p.counts.unfinished}</b>未完成
                </span>
                <span>
                  <b>{p.counts.completed}</b>已完成
                </span>
                <span className={p.counts.risk ? 'npi-warning-text' : ''}>
                  <b>{p.counts.risk}</b>风险 / 逾期
                </span>
              </div>
              <div className="npi-workbench-card-bottom">
                <span>
                  {p.counts.review
                    ? `${p.counts.review} 项待 BOM 复核`
                    : `要求齐套 ${p.requiredKitDate}`}
                </span>
                {p.counts.issues > 0 && (
                  <span>项目问题 {p.counts.issues} 项</span>
                )}
                <strong>
                  {p.counts.total || p.counts.review
                    ? '查看 BOM'
                    : p.counts.issues
                      ? '查看项目问题'
                      : '查看 BOM'}{' '}
                  <ArrowRight size={15} />
                </strong>
              </div>
            </button>
          ))}
        </div>
        {!projects.length && (
          <div className="npi-module-empty">
            没有符合条件的项目。
            {meta.actor.role === 'procurement'
              ? '分配给你或同部门成员的采购物料和项目问题会按项目显示在这里。'
              : '请调整搜索，或先创建项目并分配任务。'}
          </div>
        )}
        <NpiPagination label="任务项目分页" {...projectPage} />
      </section>
    )
  if (!project) return null
  return (
    <section className="npi-workbench-detail" aria-label="项目任务工作页">
      <button className="npi-back" onClick={() => onSelect(null)}>
        <ArrowLeft size={16} />
        返回{title}列表
      </button>
      <div className="npi-workbench-project-head">
        <div>
          <small>
            {project.code} · {stageLabels[project.currentNpiStage]}
          </small>
          <h2>{project.motorModel}</h2>
          <p>
            {project.motorType || project.name} · 订单{' '}
            {project.orderQuantity
              ? `${project.orderQuantity} 台`
              : '台数未填写'}{' '}
            · 要求齐套 {project.requiredKitDate}
          </p>
        </div>
        <div className="npi-actions">
          {project.canOpenProject && (
            <button
              className="npi-button secondary"
              onClick={() => onOpenProject(project.id)}
            >
              项目资料与分配
            </button>
          )}
          {replyable.length > 0 && (
            <button
              className="npi-button"
              onClick={() =>
                onQuick(
                  project.id,
                  currentSelection.length
                    ? currentSelection.map((i) => i.id)
                    : undefined,
                )
              }
            >
              <Zap size={16} />
              {currentSelection.length
                ? `回复已选 ${currentSelection.length} 项`
                : '批量回复完成时间'}
            </button>
          )}
        </div>
      </div>
      <div className="npi-filters npi-workbench-tabs">
        <button
          aria-pressed={tab === 'bom'}
          className={tab === 'bom' ? 'active' : ''}
          onClick={() => setTab('bom')}
        >
          电机 BOM · {tasks.size}
        </button>
        <button
          aria-pressed={tab === 'extras'}
          className={tab === 'extras' ? 'active' : ''}
          onClick={() => setTab('extras')}
        >
          {project.counts.review
            ? '其他任务 / 待复核'
            : kind === 'manufacturing'
              ? '整机 / 工装 / BOM外零件'
              : 'BOM外采购件'}{' '}
          · {extras.length}
        </button>
      </div>
      {project.counts.review > 0 && (
        <p className="npi-workbench-review" role="status">
          BOM 已换版，{project.counts.review}{' '}
          项原任务待项目负责人复核；可在“其他任务 / 待复核”查看原记录。
        </p>
      )}
      {project.counts.issues > 0 && (
        <p className="npi-workbench-hint">
          本项目有 {project.counts.issues} 项分配给你 /
          本部门的问题，可在下方“项目问题”继续处理。
        </p>
      )}
      {tab === 'bom' ? (
        <div className="npi-panel npi-workbench-bom">
          <div className="npi-workbench-toolbar">
            <input
              type="search"
              aria-label="搜索项目BOM"
              placeholder="编码 / 名称 / 规格 / 责任人"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelected([])
              }}
            />
            <select
              aria-label="项目BOM任务状态"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setSelected([])
              }}
            >
              {[
                ['all', '全部状态'],
                ['unfinished', '未完成'],
                ['pending_reply', '待回复'],
                ['risk', '风险'],
                ['overdue', '逾期'],
                ['completed', '已完成'],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {!project.scoped && (
              <label className="npi-checkbox">
                <input
                  type="checkbox"
                  checked={mine}
                  onChange={(e) => {
                    setMine(e.target.checked)
                    setSelected([])
                  }}
                />
                只看我 / 本部门
              </label>
            )}
            <span>
              {filtered.matching.size} 项
              {selected.length ? ` · 已选 ${selected.length}` : ''}
            </span>
            {selected.length > 0 && (
              <button className="npi-link" onClick={() => setSelected([])}>
                清除选择
              </button>
            )}
          </div>
          <div className="npi-workbench-hint">
            {project.scoped
              ? '显示本人 / 本部门负责的 BOM 及上级结构。'
              : 'BOM 保留结构，按责任范围回复。'}
            Shift 连选 · 批量统一日期或粘贴日期列 · 点击名称查看详情、完成与附件
          </div>
          <div ref={start} className="npi-table-scroll npi-bom-grid">
            <NpiBomTable
              rows={bomPage.items}
              tasks={tasks}
              parents={parents}
              collapsed={collapsed}
              onToggle={(id) =>
                setCollapsed((old) => {
                  const next = new Set(old)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              selected={selected}
              onSelect={setSelected}
              canSelect={(r) =>
                filtered.matching.has(r.id) &&
                !!tasks.get(r.id) &&
                canReply(tasks.get(r.id)!)
              }
              selectionLabel="选择本页待回复物料"
              missingTaskLabel="其他岗位 / 结构"
              onDetails={(r) => {
                const t = tasks.get(r.id)
                if (t) onDetails(t)
                else setDetails(r)
              }}
              onReply={onReply}
              canReply={canReply}
            />
          </div>
          {!filtered.rows.length && (
            <p className="npi-module-empty">
              {data?.rows.length
                ? '没有符合筛选条件的物料。'
                : project.activeBomImportId
                  ? '当前 BOM 暂无分配给你的物料，请查看其他任务或联系项目负责人。'
                  : '尚未导入 BOM，请先处理整机 / 工装 / BOM外零件。'}
            </p>
          )}
          <NpiPagination label="项目BOM分页" {...bomPage} />
        </div>
      ) : (
        <NpiDeliveryList
          title={
            kind === 'manufacturing' ? '整机、工装与BOM外零件' : 'BOM外采购件'
          }
          items={extras}
          renderTable={renderTable}
          onQuick={
            extras.some(canReply)
              ? () =>
                  onQuick(
                    project.id,
                    extras.filter(canReply).map((i) => i.id),
                  )
              : undefined
          }
        />
      )}
      <Dialog
        open={!!details}
        onOpenChange={(open) => {
          if (!open) setDetails(null)
        }}
      >
        <DialogContent className="npi-modal">
          <DialogTitle>{details?.materialName}</DialogTitle>
          <DialogDescription>
            结构参考；此处没有可由当前岗位回复的任务。
          </DialogDescription>
          <dl className="npi-definition-list">
            <div>
              <dt>物料编码</dt>
              <dd>{details?.materialCode}</dd>
            </div>
            <div>
              <dt>规格</dt>
              <dd>{details?.specification || '—'}</dd>
            </div>
            <div>
              <dt>单台 BOM 用量</dt>
              <dd>
                {details?.qty} {details?.unit}
              </dd>
            </div>
          </dl>
        </DialogContent>
      </Dialog>
    </section>
  )
}
