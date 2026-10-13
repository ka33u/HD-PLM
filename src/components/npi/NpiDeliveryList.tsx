// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState } from 'react'
import { NpiPagination, usePagination } from './NpiPagination'
import type { ReactNode } from 'react'
import type { NpiTracking } from '../../lib/npi/service'
export function NpiDeliveryList({
  items,
  renderTable,
  onAdd,
  onQuick,
  title = '零部件、工装与整机任务',
}: {
  items: NpiTracking[]
  renderTable: (items: NpiTracking[]) => ReactNode
  onAdd?: () => void
  onQuick?: () => void
  title?: string
}) {
  const [kind, setKind] = useState('all'),
    [status, setStatus] = useState('unfinished'),
    [query, setQuery] = useState('')
  const start = useRef<HTMLDivElement>(null)
  const active = items.filter(
    (i) =>
      (i.trackingEnabled || i.affectsKit) &&
      !['MANUFACTURING', 'LEGACY_NODE'].includes(i.sourceType),
  )
  const kinds = [
    ['all', '全部任务'],
    ['WHOLE_MACHINE', '整机'],
    ['ERP_BOM', 'BOM零部件'],
    ['TOOLING', '工装明细'],
    ['EXTERNAL', 'BOM外零件'],
  ]
  const filtered = active
    .filter(
      (i) =>
        (kind === 'all' || i.sourceType === kind) &&
        (status === 'all' ||
          (status === 'unfinished'
            ? !i.actualCompleteDate
            : i.status === status)) &&
        [
          i.name,
          i.bomReference?.materialCode,
          i.specification,
          i.ownerName,
          i.projectCode,
          i.motorModel,
        ]
          .join(' ')
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.sourceType === 'WHOLE_MACHINE') -
          Number(a.sourceType === 'WHOLE_MACHINE') ||
        a.requiredDate.localeCompare(b.requiredDate) ||
        a.name.localeCompare(b.name),
    )
  const page = usePagination(filtered, 50, start)
  return (
    <section className="npi-panel" aria-label={title}>
      <div className="npi-panel-title">
        <div>
          <h2>{title}</h2>
          <p>
            直接回复每项预计完成时间，完成后单独确认实际日期。零部件默认由制造负责人办理，可转给采购。
          </p>
        </div>
        <div className="npi-actions">
          {onQuick && (
            <button className="npi-button" onClick={onQuick}>
              快速回复完成时间
            </button>
          )}
          {onAdd && (
            <button className="npi-button secondary" onClick={onAdd}>
              添加零件 / 工装
            </button>
          )}
        </div>
      </div>
      <div className="npi-filters">
        {kinds.map(([value, label]) => (
          <button
            key={value}
            aria-pressed={kind === value}
            className={kind === value ? 'active' : ''}
            onClick={() => setKind(value!)}
          >
            {label} ·{' '}
            {
              active.filter((i) => value === 'all' || i.sourceType === value)
                .length
            }
          </button>
        ))}
      </div>
      <div className="npi-material-filters">
        <input
          type="search"
          aria-label="搜索交付任务"
          placeholder="编码 / 名称 / 规格 / 责任人"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="交付任务状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {[
            ['unfinished', '未完成'],
            ['pending_reply', '待回复'],
            ['risk', '风险'],
            ['overdue', '逾期'],
            ['completed', '已完成'],
            ['all', '全部记录'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <span>共 {filtered.length} 项</span>
      </div>
      <div ref={start}>
        {page.items.length ? (
          renderTable(page.items)
        ) : (
          <p className="npi-module-empty">
            暂无符合条件的任务，请调整分类或筛选。
          </p>
        )}
      </div>
      <NpiPagination {...page} label="交付任务分页" />
    </section>
  )
}
