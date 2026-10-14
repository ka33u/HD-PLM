// SPDX-License-Identifier: AGPL-3.0-or-later
import { trackingMaterialCode } from '../../lib/npi/tracking-reference'
import { useRef, useState } from 'react'
import { downloadKitMaterials } from './kit-export'
import type { ReactNode } from 'react'
import type { NpiTracking, ProjectDetail } from '../../lib/npi/service'

export function NpiKitMaterials({
  project,
  focusedItemId,
  onClearFocus,
  canManage,
  onExternal,
  onBom,
  renderTable,
}: {
  project: ProjectDetail
  focusedItemId: string | null
  onClearFocus: () => void
  canManage: boolean
  onExternal: () => void
  onBom: (mode?: 'all' | 'untracked') => void
  renderTable: (items: Array<NpiTracking>) => ReactNode
}) {
  const [mode, setMode] = useState('all'),
    [search, setSearch] = useState(''),
    [source, setSource] = useState('all'),
    [status, setStatus] = useState('all')
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState('')
  const exportPending = useRef(false)
  const materials = project.items.filter(
    (i) =>
      !['WHOLE_MACHINE', 'MANUFACTURING', 'LEGACY_NODE'].includes(
        i.sourceType,
      ) &&
      (i.trackingEnabled || i.affectsKit),
  )
  const abnormal = (i: NpiTracking) =>
    ['pending_reply', 'risk', 'overdue'].includes(i.status)
  const filtered = focusedItemId
    ? project.items.filter(
        (i) =>
          i.id === focusedItemId &&
          !['WHOLE_MACHINE', 'MANUFACTURING', 'LEGACY_NODE'].includes(
            i.sourceType,
          ),
      )
    : materials.filter(
        (i) =>
          (mode === 'all' ||
            (mode === 'abnormal' && abnormal(i)) ||
            (mode === 'tooling' && i.sourceType === 'TOOLING') ||
            (mode === 'external' && i.sourceType === 'EXTERNAL') ||
            (mode === 'completed' && !!i.actualCompleteDate) ||
            (mode === 'missing' && !i.actualCompleteDate)) &&
          (source === 'all' ||
            i.sourceType === source ||
            (i.sourceType === 'EXTERNAL' &&
              source === `external_${i.trackingType}`)) &&
          (status === 'all' ||
            (status === 'risk_overdue' &&
              ['risk', 'overdue'].includes(i.status)) ||
            i.status === status) &&
          `${trackingMaterialCode(i) || ''} ${i.name} ${i.specification} ${i.ownerName}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      )
  const exportCurrent = async () => {
    if (exportPending.current || !filtered.length) return
    exportPending.current = true
    setExporting(true)
    setExportError('')
    const modes: Record<string, string> = {
      abnormal: '异常物料',
      all: '全部零部件',
      tooling: '工装明细',
      external: 'BOM外物料',
      completed: '已满足（已完成）',
      missing: '缺料（未完成）',
    }
    const sources: Record<string, string> = {
      all: '全部来源',
      ERP_BOM: 'ERP BOM',
      EXTERNAL: 'BOM外零件',
      TOOLING: '工装明细',
      external_purchase: 'BOM外采购件',
      external_material: '临时样机件',
      external_other: '其他BOM外物料',
    }
    const statuses: Record<string, string> = {
      all: '全部状态',
      risk_overdue: '风险或逾期',
      pending_reply: '待回复',
      risk: '风险',
      overdue: '逾期',
      normal: '正常',
      completed: '已完成',
    }
    const scope = focusedItemId
      ? '定位物料'
      : [
          modes[mode],
          sources[source],
          statuses[status],
          search.trim() ? `搜索：${search.trim()}` : '',
        ]
          .filter(Boolean)
          .join(' / ')
    try {
      await downloadKitMaterials({ project, items: filtered, scope })
    } catch (e) {
      setExportError(e instanceof Error ? e.message : '导出失败，请重试')
    } finally {
      exportPending.current = false
      setExporting(false)
    }
  }
  const choose = (next: string) => {
    onClearFocus()
    setMode(next)
    setSource('all')
    setStatus('all')
    setSearch('')
  }
  return (
    <>
      <div className="npi-kit-metrics" role="group" aria-label="齐套物料统计">
        {[
          {
            label: 'ERP BOM',
            value:
              project.imports.find((i) => i.id === project.activeBomImportId)
                ?.rowCount || 0,
            note: '当前版本物料总数',
            action: () => onBom('all'),
          },
          {
            label: 'BOM外物料',
            value: materials.filter((i) => i.sourceType === 'EXTERNAL').length,
            note: '独立补充物料',
            action: () => choose('external'),
          },
          {
            label: '工装明细',
            value: materials.filter((i) => i.sourceType === 'TOOLING').length,
            note: '逐项回复与确认',
            action: () => choose('tooling'),
          },
          {
            label: '已满足',
            value: materials.filter((i) => !!i.actualCompleteDate).length,
            note: '零部件及工装已完成',
            action: () => choose('completed'),
          },
          {
            label: '缺料',
            value: materials.filter((i) => !i.actualCompleteDate).length,
            note: '零部件及工装未完成',
            action: () => choose('missing'),
          },
          {
            label: '待复核分配',
            value: project.untrackedBomCount,
            note: '换版后待复核的当前BOM行',
            action: () => onBom('untracked'),
          },
          {
            label: '待回复',
            value: materials.filter((i) => i.status === 'pending_reply').length,
            note: '需要取得承诺',
            action: () => {
              choose('all')
              setStatus('pending_reply')
            },
          },
          {
            label: '风险 / 逾期',
            value: `${materials.filter((i) => i.status === 'risk').length} / ${materials.filter((i) => i.status === 'overdue').length}`,
            note: '需要协调处理',
            action: () => {
              choose('all')
              setStatus('risk_overdue')
            },
          },
        ].map((c) => (
          <button key={c.label} onClick={c.action}>
            <span>{c.label}</span>
            <strong>{c.value}</strong>
            <small>{c.note}</small>
          </button>
        ))}
      </div>
      <section className="npi-panel" aria-label="齐套物料清单">
        <div className="npi-panel-title">
          <div>
            <h2>样机齐套物料</h2>
            <p>
              全部BOM零部件、BOM外零件和工装均纳入，按实际完成记录统计；整机单独在交付任务中回复。此处为明细项数，不代表库存数量。
            </p>
          </div>
          {canManage && project.currentNpiStage !== 'completed' && (
            <button
              className="npi-button"
              aria-label="添加零件或工装"
              onClick={onExternal}
            >
              ＋ 零件 / 工装
            </button>
          )}
        </div>
        <div className="npi-filters">
          {[
            ['abnormal', '异常物料'],
            ['tooling', '工装明细'],
            ['external', 'BOM外物料'],
            ['completed', '已满足'],
            ['missing', '缺料'],
            ['all', '全部零部件'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={!focusedItemId && mode === key ? 'active' : ''}
              aria-pressed={!focusedItemId && mode === key}
              onClick={() => choose(key!)}
            >
              {label}
            </button>
          ))}
          <button onClick={() => onBom('all')}>完整BOM ↗</button>
        </div>
        <div className="npi-material-filters">
          <label>
            <span className="sr-only">搜索齐套物料</span>
            <input
              type="search"
              placeholder="搜索编码 / 物料 / 规格 / 回复人"
              aria-label="搜索齐套物料"
              value={search}
              onChange={(e) => {
                onClearFocus()
                setSearch(e.target.value)
              }}
              maxLength={200}
            />
          </label>
          <label>
            状态{' '}
            <select
              aria-label="齐套物料状态"
              value={status}
              onChange={(e) => {
                onClearFocus()
                setStatus(e.target.value)
              }}
            >
              {[
                ['all', '全部'],
                ['pending_reply', '待回复'],
                ['risk', '风险'],
                ['overdue', '逾期'],
                ['risk_overdue', '风险或逾期'],
                ['normal', '正常'],
                ['completed', '已完成'],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            物料来源{' '}
            <select
              aria-label="齐套物料来源"
              value={source}
              onChange={(e) => {
                onClearFocus()
                setSource(e.target.value)
              }}
            >
              <option value="all">全部</option>
              <option value="ERP_BOM">ERP BOM</option>
              <option value="EXTERNAL">BOM外零件</option>
              <option value="TOOLING">工装明细</option>
              <option value="external_purchase">BOM外采购件</option>
              <option value="external_material">临时样机件</option>
              <option value="external_other">其他BOM外物料</option>
            </select>
          </label>
          <span>
            {focusedItemId ? '正在显示定位物料 · ' : ''}共 {filtered.length} 项
          </span>
          <button
            className="npi-button secondary"
            style={{ marginLeft: 'auto' }}
            disabled={exporting || !filtered.length}
            onClick={() => void exportCurrent()}
          >
            {exporting ? '正在导出…' : `导出当前筛选（${filtered.length}项）`}
          </button>
        </div>
        {exportError && (
          <p role="alert" className="npi-message error">
            Excel导出失败：{exportError}。筛选内容已保留，可重试。
          </p>
        )}
        {renderTable(filtered)}
      </section>
    </>
  )
}
