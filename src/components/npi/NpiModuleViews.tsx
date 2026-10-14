// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownsWork } from '../../lib/npi/work-ownership'
import { projectTitle } from '../../lib/npi/project-identity'
import { useMemo, useRef, useState } from 'react'
import { nodeNames } from '../../lib/npi/domain'
import {
  arrivalWindowDescription,
  compareExpectedArrival,
  matchesArrivalWindow,
} from '../../lib/npi/procurement-arrival'
import {
  dashboardMetrics,
  projectCompletion,
} from '../../lib/npi/project-dashboard'
import { NpiPagination, usePagination } from './NpiPagination'
import { NpiActivity } from './NpiActivity'
import { NpiAssignedMaterials } from './NpiAssignedMaterials'
import './preparation-board.css'
import { stageLabels, stateLabels } from './navigation'
import type { ArrivalWindow } from '../../lib/npi/procurement-arrival'
import type { NpiDashboard, NpiMetadata } from '../../lib/npi/service'

type Project = NpiDashboard['projects'][number]
type Open = (id: string, tab?: string, itemId?: string) => void
const byRisk: Record<string, number> = {
  overdue: 0,
  risk: 1,
  pending_reply: 2,
  normal: 3,
  completed: 4,
}
const badge = (status: string) => (
  <span className={`npi-badge npi-${status}`}>
    {stateLabels[status] || status}
  </span>
)
const contains = (query: string, ...values: Array<string | null | undefined>) =>
  values.join(' ').toLowerCase().includes(query.trim().toLowerCase())
const identity = (p: Project) => (
  <small>
    {p.code} · {p.motorModel}
  </small>
)

export function NpiProjectLibrary({
  dashboard,
  mode,
  onOpen,
}: {
  dashboard: NpiDashboard
  mode: 'projects' | 'bom'
  onOpen: Open
}) {
  const [query, setQuery] = useState(''),
    [stage, setStage] = useState('all'),
    [bomState, setBomState] = useState('all')
  const start = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () =>
      dashboard.projects
        .filter(
          (p) =>
            contains(
              query,
              p.name,
              p.profile?.motorType,
              p.code,
              p.motorModel,
            ) &&
            (stage === 'all' || p.currentNpiStage === stage) &&
            (mode !== 'bom' ||
              bomState === 'all' ||
              (bomState === 'missing'
                ? !p.activeBomImportId
                : bomState === 'review'
                  ? p.bomReviewCount > 0
                  : !!p.activeBomImportId)),
        )
        .sort((a, b) =>
          a.code.localeCompare(b.code, 'zh-CN', { numeric: true }),
        ),
    [dashboard, query, stage, bomState, mode],
  )
  const pagination = usePagination(rows, 25, start)
  return (
    <section
      className="npi-panel"
      aria-label={mode === 'bom' ? '项目BOM管理' : '新品项目目录'}
    >
      <div className="npi-panel-title">
        <h2>{mode === 'bom' ? '项目BOM版本' : '项目目录'}</h2>
        <span>共 {rows.length} 个项目</span>
      </div>
      <div className="npi-module-filters">
        <label>
          查找项目
          <input
            type="search"
            aria-label="模块项目搜索"
            placeholder="电机类型 / 编号 / 型号"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          项目阶段
          <select
            aria-label="模块项目阶段"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="all">全部阶段</option>
            {Object.entries(stageLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {mode === 'bom' && (
          <label>
            BOM状态
            <select
              aria-label="项目BOM状态"
              value={bomState}
              onChange={(e) => setBomState(e.target.value)}
            >
              <option value="all">全部</option>
              <option value="missing">尚未导入</option>
              <option value="imported">已有BOM</option>
              <option value="review">换版待复核</option>
            </select>
          </label>
        )}
      </div>
      <div ref={start} className="npi-table-scroll">
        <table className="npi-table npi-tracking-table">
          <thead>
            <tr>
              <th>新品项目</th>
              <th>阶段</th>
              {mode === 'bom' ? (
                <>
                  <th>当前BOM</th>
                  <th>版本与复核</th>
                </>
              ) : (
                <>
                  <th>样机要求</th>
                  <th>要求齐套</th>
                  <th>状态</th>
                </>
              )}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((p) => {
              const active = p.imports.find((i) => i.id === p.activeBomImportId)
              return (
                <tr key={p.id}>
                  <td data-label="新品项目">
                    <strong>{projectTitle(p)}</strong>
                    {identity(p)}
                  </td>
                  <td data-label="阶段">{stageLabels[p.currentNpiStage]}</td>
                  {mode === 'bom' ? (
                    <>
                      <td data-label="当前BOM">
                        {active
                          ? `V${active.versionNo} · ${active.rowCount}项`
                          : '尚未导入'}
                        <small>{active?.sourceName}</small>
                      </td>
                      <td data-label="版本与复核">
                        {p.imports.length} 个版本
                        <small
                          className={p.bomReviewCount ? 'npi-warning-text' : ''}
                        >
                          {p.bomReviewCount
                            ? `${p.bomReviewCount}项旧跟踪待复核`
                            : '无待复核项'}
                        </small>
                      </td>
                    </>
                  ) : (
                    <>
                      <td data-label="样机要求">{p.prototypeRequiredDate}</td>
                      <td data-label="要求齐套">{p.requiredKitDate}</td>
                      <td data-label="状态">{badge(p.riskStatus)}</td>
                    </>
                  )}
                  <td data-label="操作">
                    <button
                      className="npi-project-link"
                      onClick={() =>
                        onOpen(p.id, mode === 'bom' ? 'bom' : 'overview')
                      }
                    >
                      {mode === 'bom' ? '进入BOM' : '项目详情'} ↗
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && (
          <p className="npi-module-empty">没有匹配的项目，请调整搜索或筛选。</p>
        )}
      </div>
      <NpiPagination
        label={mode === 'bom' ? 'BOM项目分页' : '项目目录分页'}
        {...pagination}
      />
    </section>
  )
}

export function NpiPreparationBoard({
  dashboard,
  actor,
  onOpen,
  users = [],
}: {
  dashboard: NpiDashboard
  actor: NpiMetadata['actor']
  mode: 'purchasing'
  onOpen: Open
  users?: NpiMetadata['users']
}) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('unfinished'),
    [purchaseOwner, setPurchaseOwner] = useState('all'),
    [arrival, setArrival] = useState<ArrivalWindow>('all')
  const start = useRef<HTMLDivElement>(null)
  const all = dashboard.projects.flatMap((project) =>
    project.items
      .filter(
        (i) =>
          i.trackingType === 'purchase' && (i.trackingEnabled || i.affectsKit),
      )
      .map((item) => ({ project, item })),
  )
  const owners = [
    ...new Map(
      all.map(({ item }) => [
        item.ownerId,
        { id: item.ownerId, name: item.ownerName },
      ]),
    ).values(),
  ]
  const filtered = all
    .filter(
      ({ project: p, item: i }) =>
        contains(
          query,
          p.name,
          p.code,
          p.motorModel,
          i.name,
          i.ownerName,
          i.bomReference?.materialCode,
        ) &&
        (purchaseOwner === 'all' || purchaseOwner === i.ownerId) &&
        matchesArrivalWindow(i, dashboard.todayActivity.day, arrival) &&
        (status === 'all' ||
          (status === 'unfinished'
            ? !i.actualCompleteDate && p.currentNpiStage !== 'completed'
            : i.status === status)),
    )
    .sort((a, b) => compareExpectedArrival(a.item, b.item))
  const page = usePagination(filtered, 50, start)
  return (
    <section className="npi-panel" aria-label="采购物料任务">
      <div className="npi-panel-title">
        <div>
          <h2>采购物料任务</h2>
          <p>
            采购零部件与外购工装的完成时间和到货进展。进入项目查看明细和历史。
          </p>
        </div>
      </div>
      <div className="npi-material-filters">
        <input
          type="search"
          aria-label="搜索业务任务"
          placeholder="项目 / 零部件 / 责任人"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="业务任务状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {[
            ['unfinished', '未完成'],
            ['pending_reply', '待回复'],
            ['risk', '风险'],
            ['overdue', '逾期'],
            ['completed', '已完成'],
            ['all', '全部'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          aria-label="采购责任人"
          value={purchaseOwner}
          onChange={(e) => setPurchaseOwner(e.target.value)}
        >
          <option value="all">全部采购责任人</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select
          aria-label="采购到货范围"
          value={arrival}
          onChange={(e) => setArrival(e.target.value as ArrivalWindow)}
        >
          <option value="all">不限到货日期</option>
          <option value="today">今日到货</option>
          <option value="7">未来7天到货</option>
          <option value="14">未来14天到货</option>
        </select>
      </div>
      {arrival !== 'all' && (
        <p className="npi-list-summary">
          {arrivalWindowDescription(dashboard.todayActivity.day, arrival)}
        </p>
      )}
      <div className="npi-table-scroll" ref={start}>
        <table className="npi-table npi-tracking-table">
          <thead>
            <tr>
              <th>项目 / 任务</th>
              <th>责任人</th>
              <th>要求日期</th>
              <th>首次承诺</th>
              <th>当前承诺</th>
              <th>实际完成</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map(({ project: p, item: i }) => (
              <tr key={i.id} data-npi-task={i.id}>
                <td data-label="项目 / 任务">
                  <strong>{projectTitle(p)}</strong>
                  <span>{i.name}</span>
                  <small>
                    {i.bomReference?.materialCode ||
                      (i.sourceType === 'TOOLING' ? '工装' : 'BOM外零件')}
                  </small>
                </td>
                <td data-label="责任人">{i.ownerName}</td>
                <td data-label="要求日期">{i.requiredDate}</td>
                <td data-label="首次承诺">{i.firstCommittedDate || '—'}</td>
                <td data-label="当前承诺">
                  {i.currentCommittedDate || '待回复'}
                </td>
                <td data-label="实际完成">{i.actualCompleteDate || '—'}</td>
                <td data-label="状态">{badge(i.status)}</td>
                <td data-label="操作">
                  <button
                    className="npi-project-link"
                    onClick={() => onOpen(p.id, 'kit', i.id)}
                  >
                    查看采购物料 ↗
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!page.items.length && (
        <p className="npi-module-empty">暂无符合条件的采购任务。</p>
      )}
      <NpiPagination {...page} label="业务任务分页" />
    </section>
  )
}

export function NpiReports({
  dashboard,
  onOpen,
}: {
  dashboard: NpiDashboard
  onOpen: Open
}) {
  const [stage, setStage] = useState('all')
  const [query, setQuery] = useState('')
  const completeStart = useRef<HTMLDivElement>(null)
  const searched = useMemo(
    () =>
      dashboard.projects.filter((p) =>
        contains(query, p.name, p.profile?.motorType, p.code, p.motorModel),
      ),
    [dashboard, query],
  )
  const projects = useMemo(
    () =>
      searched.filter((p) => stage === 'all' || p.currentNpiStage === stage),
    [searched, stage],
  )
  const completedPage = usePagination(projects, 25, completeStart)
  const metrics = dashboardMetrics(projects, dashboard.todayActivity.day)
  const ids = new Set(projects.map((p) => p.id))
  const scoped = {
    ...dashboard,
    projects,
    todayActivity: {
      ...dashboard.todayActivity,
      newOverdue: dashboard.todayActivity.newOverdue.filter((r) =>
        ids.has(r.projectId),
      ),
      promiseChanges: dashboard.todayActivity.promiseChanges.filter((r) =>
        ids.has(r.projectId),
      ),
      completions: dashboard.todayActivity.completions.filter((r) =>
        ids.has(r.projectId),
      ),
    },
  }
  return (
    <div aria-label="新品报表" role="region">
      <section className="npi-panel">
        <div className="npi-panel-title">
          <h2>阶段与样机完成分析</h2>
          <span>{dashboard.todayActivity.day} · 北京时间</span>
        </div>
        <div className="npi-module-filters">
          <label>
            查找项目
            <input
              aria-label="报表项目搜索"
              type="search"
              placeholder="电机类型 / 编号 / 型号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={200}
            />
          </label>
          <label>
            分析范围
            <select
              aria-label="报表阶段范围"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              <option value="all">全部阶段</option>
              {Object.entries(stageLabels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="npi-module-counts">
          <span>
            在研项目 <strong>{metrics.active}</strong>
          </span>
          <span>
            完成项目{' '}
            <strong>
              {projects.filter((p) => p.currentNpiStage === 'completed').length}
            </strong>
          </span>
          <span>
            完成项目按期率{' '}
            <strong>
              {metrics.onTimeRate == null ? '—' : `${metrics.onTimeRate}%`}
            </strong>
          </span>
        </div>
        <div className="npi-stage-distribution">
          {Object.entries(stageLabels).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={stage === value}
              onClick={() => setStage(stage === value ? 'all' : value)}
            >
              <span>{label}</span>
              <strong>
                {searched.filter((p) => p.currentNpiStage === value).length}
              </strong>
            </button>
          ))}
        </div>
        <p className="npi-list-summary">
          按期率按已完成项目的样机装配实际日期计算；尚未记录实际日期的项目不计为按期。
        </p>
        <div ref={completeStart} className="npi-table-scroll">
          <table className="npi-table npi-tracking-table">
            <thead>
              <tr>
                <th>项目清单</th>
                <th>阶段</th>
                <th>样机要求</th>
                <th>样机实际</th>
                <th>完成结果</th>
              </tr>
            </thead>
            <tbody>
              {completedPage.items.map((p) => {
                const completion = projectCompletion(p)
                return (
                  <tr key={p.id}>
                    <td data-label="项目清单">
                      <button
                        className="npi-project-link"
                        onClick={() => onOpen(p.id)}
                      >
                        {projectTitle(p)} ↗
                      </button>
                      {identity(p)}
                    </td>
                    <td data-label="阶段">{stageLabels[p.currentNpiStage]}</td>
                    <td data-label="样机要求">{p.prototypeRequiredDate}</td>
                    <td data-label="样机实际">
                      {completion.actualDate || '未记录'}
                    </td>
                    <td data-label="完成结果">
                      {p.currentNpiStage !== 'completed'
                        ? '进行中'
                        : completion.onTime
                          ? '按期完成'
                          : completion.actualDate
                            ? '晚于要求'
                            : '待核对实际日期'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!projects.length && (
            <p className="npi-module-empty">
              当前范围没有项目，请调整阶段或搜索条件。
            </p>
          )}
        </div>
        <NpiPagination label="项目报表分页" {...completedPage} />
      </section>
      <NpiActivity
        dashboard={scoped}
        onOpen={(id, itemId) => onOpen(id, undefined, itemId)}
      />
    </div>
  )
}
