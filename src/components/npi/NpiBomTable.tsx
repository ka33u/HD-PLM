// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef } from 'react'
import { selectRange } from './table-selection'
import type { BomRow } from '../../lib/npi/bom'
import type { NpiTracking } from '../../lib/npi/service'
const states: Record<string, string> = {
  pending_reply: '待回复',
  normal: '正常',
  risk: '风险',
  overdue: '逾期',
  completed: '已完成',
}
export function NpiBomTable({
  rows,
  tasks,
  parents,
  collapsed,
  onToggle,
  selected,
  onSelect,
  canSelect,
  onDetails,
  onReply,
  canReply,
}: {
  rows: BomRow[]
  tasks: Map<string | null, NpiTracking>
  parents: Set<string | null>
  collapsed: Set<string>
  onToggle: (id: string) => void
  selected: string[]
  onSelect: (ids: string[]) => void
  canSelect: (r: BomRow) => boolean
  onDetails: (r: BomRow) => void
  onReply: (item: NpiTracking) => void
  canReply: (item: NpiTracking) => boolean
}) {
  const anchor = useRef<string | null>(null)
  const eligible = rows.filter(canSelect).map((r) => r.id)
  const all = !!eligible.length && eligible.every((id) => selected.includes(id))
  return (
    <table
      className="npi-table npi-bom-table npi-bom-dense"
      aria-label="完整BOM明细"
    >
      <colgroup>
        {[34, 220, 125, 160, 76, 92, 110, 75, 68].map((width, i) => (
          <col key={i} style={{ width: i === 3 ? undefined : width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              aria-label="选择本页可分配任务"
              disabled={!eligible.length}
              checked={all}
              ref={(node) => {
                if (node)
                  node.indeterminate =
                    !all && eligible.some((id) => selected.includes(id))
              }}
              onChange={() =>
                onSelect(
                  all
                    ? selected.filter((id) => !eligible.includes(id))
                    : [...new Set([...selected, ...eligible])].slice(0, 200),
                )
              }
            />
          </th>
          <th>零部件名称</th>
          <th>物料编码</th>
          <th>规格</th>
          <th>数量</th>
          <th>责任人</th>
          <th>预计完成</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const t = tasks.get(r.id)
          return (
            <tr
              key={r.id}
              data-bom-row={r.id}
              className={selected.includes(r.id) ? 'is-selected' : ''}
            >
              <td>
                <input
                  type="checkbox"
                  aria-label={`选择${r.materialCode}第${r.rowNo}行`}
                  checked={selected.includes(r.id)}
                  disabled={!canSelect(r)}
                  onChange={(e) => {
                    onSelect(
                      selectRange(
                        selected,
                        eligible,
                        r.id,
                        e.target.checked,
                        anchor.current,
                        Boolean((e.nativeEvent as MouseEvent).shiftKey),
                        200,
                      ),
                    )
                    anchor.current = r.id
                  }}
                />
              </td>
              <td>
                <div
                  className="npi-bom-name"
                  style={{ paddingLeft: Math.min(r.level - 1, 8) * 12 }}
                >
                  {parents.has(r.id) ? (
                    <button
                      className="npi-bom-toggle"
                      aria-label={`${collapsed.has(r.id) ? '展开' : '收起'}${r.materialName}`}
                      aria-expanded={!collapsed.has(r.id)}
                      onClick={() => onToggle(r.id)}
                    >
                      {collapsed.has(r.id) ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span className="npi-bom-level" title={`${r.level}级`}>
                      ·
                    </span>
                  )}
                  <button
                    className="npi-bom-name-link"
                    onClick={() => onDetails(r)}
                    title={`${r.materialName}\n${r.specification}\n${r.materialCode} · 第${r.rowNo}行`}
                    aria-label={`查看${r.materialCode}第${r.rowNo}行明细`}
                  >
                    {r.materialName}
                  </button>
                </div>
              </td>
              <td title={`${r.materialCode} · 原表第${r.rowNo}行`}>
                {r.materialCode}
              </td>
              <td title={r.specification}>{r.specification || '—'}</td>
              <td title={`${r.qty} ${r.unit}`}>
                {r.qty} {r.unit}
              </td>
              <td title={t?.ownerName || '待复核'}>
                {t?.ownerName || '待复核'}
              </td>
              <td
                title={`要求 ${t?.requiredDate || '—'}；首次 ${t?.firstCommittedDate || '未回复'}；实际 ${t?.actualCompleteDate || '未完成'}`}
              >
                {t?.currentCommittedDate || '—'}
              </td>
              <td>
                <span
                  className={`npi-bom-status ${t?.status || 'pending_reply'}`}
                >
                  {t ? states[t.status] || t.status : '待复核'}
                </span>
              </td>
              <td>
                {t && canReply(t) ? (
                  <button
                    className="npi-link"
                    onClick={() => onReply(t)}
                    aria-label={`回复${r.materialCode}第${r.rowNo}行完成时间`}
                  >
                    {t.currentCommittedDate ? '改期' : '回复'}
                  </button>
                ) : (
                  <button className="npi-link" onClick={() => onDetails(r)}>
                    明细
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
