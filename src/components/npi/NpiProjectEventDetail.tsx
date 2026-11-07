import { lifecycleDefinitions, resultLabels } from '../../lib/npi/lifecycle'
import type { LifecycleKind } from '../../lib/npi/lifecycle'
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ClipboardList } from 'lucide-react'
import { eventLabels } from '../../lib/npi/event-labels'
import { MotherConfirmationDetail } from './NpiMotherConfirmation'
import { InheritanceDetail } from './NpiProjectInheritance'
import type { MotherConfirmation } from '../../lib/npi/bom'
import type { ProjectEvent } from '../../lib/npi/project-events'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export function NpiProjectEventDetail({ event: e }: { event: ProjectEvent }) {
  const detail = record(e.detail)
  const name =
    e.objectName ||
    (typeof detail.itemName === 'string'
      ? detail.itemName
      : typeof detail.name === 'string'
        ? detail.name
        : '')
  return (
    <article className="npi-history" data-event-id={e.id}>
      <ClipboardList size={18} />
      <div>
        <strong>{eventLabels[e.action] || '其他项目记录'}</strong>
        {name && <p>{name}</p>}
        {e.action === 'COMPLETED' &&
          typeof detail.actualCompleteDate === 'string' && (
            <p>实际完成：{detail.actualCompleteDate}</p>
          )}
        {e.action === 'PROMISE_CHANGED' &&
          typeof detail.currentCommittedDate === 'string' && (
            <p>
              {typeof detail.oldCommittedDate === 'string'
                ? detail.oldCommittedDate
                : '首次回复'}{' '}
              → {detail.currentCommittedDate}
            </p>
          )}
        {['BOM_IMPORTED', 'BOM_DRAFT_UPDATED'].includes(e.action) &&
          !!detail.motherConfirmation && (
            <MotherConfirmationDetail
              confirmation={detail.motherConfirmation as MotherConfirmation}
            />
          )}
        {e.action === 'MANUFACTURING_EXCEPTION_REPORTED' &&
          typeof detail.committedDate === 'string' && (
            <p>预计完成：{detail.committedDate}</p>
          )}
        {e.action.startsWith('LIFECYCLE_') && (
          <LifecycleAuditDetail detail={detail} />
        )}
        {e.action === 'FILE_UPLOADED' &&
          typeof detail.analysis === 'string' &&
          !!detail.analysis && (
            <details>
              <summary>
                报告分析 · {resultLabels[String(detail.conclusion)]}
              </summary>
              <p style={{ whiteSpace: 'pre-wrap' }}>{detail.analysis}</p>
            </details>
          )}
        <ProjectChangeDetail action={e.action} detail={e.detail} />
        <InheritanceDetail action={e.action} detail={e.detail} />
        <AdjustmentDetail action={e.action} detail={e.detail} />
        {typeof detail.reason === 'string' && <p>{detail.reason}</p>}
        {typeof detail.remark === 'string' && detail.remark && (
          <p>{detail.remark}</p>
        )}
        <small>
          {e.actorName} ·{' '}
          {new Date(e.createdAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
          })}
        </small>
      </div>
    </article>
  )
}
function AdjustmentDetail({
  action,
  detail,
}: {
  action: string
  detail: unknown
}) {
  if (!['TRACKING_PLAN_ADJUSTED', 'COMPLETION_CORRECTED'].includes(action))
    return null
  if (!detail || typeof detail !== 'object') return null
  const change = detail as {
    itemName: string
    actorName: string
    before?: {
      requiredDate?: string
      ownerName?: string
      actualCompleteDate?: string
    }
    after?: {
      requiredDate?: string
      ownerName?: string
      actualCompleteDate?: string
    }
  }
  if (!change.before || !change.after) return null
  return (
    <div>
      <p>
        {change.itemName} · 操作人：{change.actorName}
      </p>
      {change.before.requiredDate !== change.after.requiredDate && (
        <p>
          要求日期：{change.before.requiredDate} → {change.after.requiredDate}
        </p>
      )}
      {change.before.ownerName !== change.after.ownerName && (
        <p>
          责任人：{change.before.ownerName} → {change.after.ownerName}
        </p>
      )}
      {change.before.actualCompleteDate !== change.after.actualCompleteDate && (
        <p>
          实际完成：{change.before.actualCompleteDate} →{' '}
          {change.after.actualCompleteDate}
        </p>
      )}
    </div>
  )
}

function ProjectChangeDetail({
  action,
  detail,
}: {
  action: string
  detail: unknown
}) {
  if (action !== 'PROJECT_CHANGED') return null
  const change = detail as {
    actorName: string
    changes: Array<{
      key: string
      label: string
      before: string
      after: string
    }>
    tracking: Array<unknown>
    issues: Array<unknown>
  }
  if (
    !Array.isArray(change.changes) ||
    !Array.isArray(change.tracking) ||
    !Array.isArray(change.issues)
  )
    return null
  return (
    <div>
      <p>操作人：{change.actorName}</p>
      {change.changes.map((c) => (
        <p key={c.key}>
          {c.label}：{c.before} → {c.after}
        </p>
      ))}
      <p>
        调整整机与零部件 {change.tracking.length} 项 · 交接问题{' '}
        {change.issues.length} 项
      </p>
    </div>
  )
}

function LifecycleAuditDetail({ detail }: { detail: Record<string, unknown> }) {
  const before = record(detail.before),
    after = record(detail.after),
    kind = String(detail.kind) as LifecycleKind
  if (!lifecycleDefinitions[kind]) return null
  const previous = record(record(before.data).fields),
    current = record(record(after.data).fields)
  const labels = Object.fromEntries([
    ...lifecycleDefinitions[kind].fields.map((f) => [f.key, f.label]),
    ['summary', '分析与结论'],
    ['followUpDate', '下次跟进日期'],
    ['nextAction', '后续措施'],
    ['waiverReason', '不适用说明'],
    ['customerConfirmation', '客户确认结果'],
  ])
  return (
    <details>
      <summary>
        {lifecycleDefinitions[kind].label} ·{' '}
        {resultLabels[String(after.result || '')]} · 查看变更内容
      </summary>
      <p>
        计划日期：{String(after.plannedDate || before.plannedDate || '未填')} ·
        实际日期：
        {String(after.performedDate || before.performedDate || '未填')}
      </p>
      {Object.keys(labels)
        .filter((k) => current[k] || previous[k])
        .map((k) => (
          <p key={k}>
            <strong>{labels[k]}</strong>：
            {previous[k] !== current[k] && previous[k] ? (
              <>
                <del>{String(previous[k])}</del> →{' '}
              </>
            ) : null}
            {String(current[k] || previous[k] || '')}
          </p>
        ))}
    </details>
  )
}
