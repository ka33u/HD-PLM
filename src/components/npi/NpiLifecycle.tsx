// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Circle, Plus, FileText } from 'lucide-react'
import { stages } from '../../lib/npi/domain'
import {
  lifecycleDefinitions,
  lifecycleKinds,
  resultLabels,
  statusLabels,
  stagePhotoRequirements,
} from '../../lib/npi/lifecycle'
import { requestId } from '../../lib/request-id'
import { stageLabels } from './navigation'
import { NpiFiles } from './NpiFiles'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type {
  LifecycleData,
  LifecycleKind,
  LifecycleResult,
  Measurement,
} from '../../lib/npi/lifecycle'
import type { LifecycleView } from '../../lib/npi/lifecycle-service'
import type { ProjectDetail } from '../../lib/npi/service'
import './lifecycle.css'
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
type Editor = {
  id: string
  kind: LifecycleKind
  title: string
  plannedDate: string
  performedDate: string
  result: LifecycleResult
  data: LifecycleData
  version: number
  status: string
}
const toEditor = (r: LifecycleView['records'][number]): Editor => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  plannedDate: r.plannedDate || '',
  performedDate: r.performedDate || '',
  result: r.result,
  data: r.data,
  version: r.version,
  status: r.status,
})
export function NpiLifecycle({
  project,
  api,
  onChanged,
  onTab,
  advance,
  onGuides,
}: {
  project: ProjectDetail
  api: Api
  onChanged: () => Promise<void>
  onTab: (tab: string) => void
  advance: () => void
  onGuides: () => void
}) {
  const [data, setData] = useState<LifecycleView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [fileBusy, setFileBusy] = useState(false)
  const [edit, setEdit] = useState<Editor | null>(null),
    [baseline, setBaseline] = useState(''),
    [editError, setEditError] = useState(''),
    [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('all'),
    [limit, setLimit] = useState(20)
  const generation = useRef(0)
  const attachments = useRef<HTMLElement>(null)
  useEffect(() => {
    setNotice('')
  }, [project.id, project.currentNpiStage])
  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await api<LifecycleView>(`/projects/${project.id}/lifecycle`)
      if (current === generation.current) {
        setData(next)
        setError('')
      }
      return next
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : '读取流程失败')
      throw e
    }
  }, [api, project.id])
  useEffect(() => {
    void load().catch(() => {})
    return () => {
      generation.current++
    }
  }, [load, project.version])
  const dirty = !!edit && JSON.stringify(edit) !== baseline
  useEffect(() => {
    if (!dirty && !busy && !fileBusy) return
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy, fileBusy])
  const open = (
    record?: LifecycleView['records'][number],
    kind?: LifecycleKind,
  ) => {
    const type =
      kind ||
      (project.currentNpiStage === 'completed'
        ? 'closure'
        : project.currentNpiStage)
    const next: Editor = record
      ? toEditor(record)
      : {
          id: requestId(),
          kind: type,
          title: lifecycleDefinitions[type].label,
          plannedDate: '',
          performedDate: '',
          result: '',
          data: { fields: {}, measurements: [] },
          version: 0,
          status: 'draft',
        }
    setEdit(next)
    setBaseline(JSON.stringify(next))
    setEditError('')
    setNotice('')
  }
  const close = () => {
    if (busy || fileBusy) return
    if (dirty && !window.confirm('当前填写尚未保存，确认放弃这些修改？')) return
    setEdit(null)
  }
  const changed = async (keepId?: string) => {
    const next = await load()
    if (keepId) {
      const record = next.records.find((r) => r.id === keepId)
      if (record) {
        const nextEdit = toEditor(record)
        setEdit(nextEdit)
        setBaseline(JSON.stringify(nextEdit))
      }
    }
    await onChanged()
  }
  const save = async (action: 'draft' | 'submit' | 'cancel') => {
    if (!edit || busy || fileBusy) return
    const reason =
      action === 'cancel'
        ? window.prompt('取消草稿的原因（记录与附件仍保留）')
        : undefined
    if (action === 'cancel' && !reason) return
    setBusy(true)
    setEditError('')
    try {
      await api(`/projects/${project.id}/lifecycle/${edit.id}`, 'PUT', {
        ...edit,
        expectedVersion: edit.version,
        action,
        reason,
      })
      await changed(action === 'draft' ? edit.id : undefined)
      if (action !== 'draft') setEdit(null)
      setNotice(
        action === 'draft'
          ? '草稿已保存，可继续补充现场记录和附件。'
          : action === 'submit'
            ? ['fail', 'continue'].includes(edit.result)
              ? '结论已提交，已生成关联问题，请继续跟进验证。'
              : '结论已提交，请核对阶段条件后推进。'
            : '草稿已取消，原记录仍保留。',
      )
    } catch (e) {
      setEditError(
        e instanceof Error ? e.message : '保存失败，请核对最新记录后重试',
      )
    } finally {
      setBusy(false)
    }
  }
  const reconcile = async () => {
    if (!edit || busy || fileBusy) return
    setBusy(true)
    try {
      const next = await load(),
        latest = next.records.find((r) => r.id === edit.id)
      if (!latest) {
        setEditError('服务器尚无此记录，当前填写已保留，可重试保存。')
        return
      }
      if (
        dirty &&
        !window.confirm(
          '已读取服务器记录。确认用已保存的内容替换当前填写？取消可保留当前填写。',
        )
      )
        return
      const current = toEditor(latest)
      setEdit(current)
      setBaseline(JSON.stringify(current))
      setEditError('')
      await onChanged()
    } catch (e) {
      setEditError(
        e instanceof Error ? e.message : '核对失败，当前填写已保留。',
      )
    } finally {
      setBusy(false)
    }
  }
  const patch = (values: Partial<Editor>) =>
    setEdit((e) => (e ? { ...e, ...values } : e))
  const setField = (key: string, value: string) =>
    setEdit((e) =>
      e
        ? {
            ...e,
            data: { ...e.data, fields: { ...e.data.fields, [key]: value } },
          }
        : e,
    )
  const measure = (i: number, key: keyof Measurement, value: string) =>
    setEdit((e) =>
      e
        ? {
            ...e,
            data: {
              ...e.data,
              measurements: e.data.measurements.map((m, n) =>
                n === i ? { ...m, [key]: value } : m,
              ),
            },
          }
        : e,
    )
  const readOnly = !data?.canWrite || edit?.status !== 'draft'
  const currentKind =
    project.currentNpiStage === 'completed'
      ? 'closure'
      : project.currentNpiStage
  const rows = (data?.records || []).filter(
    (r) => filter === 'all' || r.kind === filter,
  )
  const definition = edit ? lifecycleDefinitions[edit.kind] : null
  return (
    <section className="npi-lifecycle" aria-label="新品全流程跟踪">
      <div className="npi-lifecycle-heading">
        <div>
          <h2>项目流程</h2>
          <p>项目负责人记录事实、分析与结论，生产采购继续在交付任务中回复。</p>
        </div>
        <button className="npi-button secondary" onClick={onGuides}>
          <FileText size={16} />
          流程与 SOP
        </button>
      </div>
      <ol className="npi-lifecycle-steps" aria-label="项目六阶段">
        {stages.map((s, i) => (
          <li
            key={s}
            className={
              s === project.currentNpiStage
                ? 'current'
                : i < stages.indexOf(project.currentNpiStage)
                  ? 'done'
                  : ''
            }
            aria-current={s === project.currentNpiStage ? 'step' : undefined}
          >
            {i < stages.indexOf(project.currentNpiStage) ? (
              <CheckCircle2 size={16} />
            ) : (
              <Circle size={16} />
            )}
            <span>{stageLabels[s]}</span>
          </li>
        ))}
      </ol>
      {error ? (
        <p className="npi-error" role="alert">
          {error}
          <button onClick={() => void load().catch(() => {})}>重试</button>
        </p>
      ) : !data ? (
        <p role="status">正在核对阶段记录…</p>
      ) : (
        <>
          <div className="npi-lifecycle-current">
            <div>
              <small>当前阶段 · {stageLabels[project.currentNpiStage]}</small>
              <h3>{lifecycleDefinitions[currentKind].label}</h3>
              <p>{lifecycleDefinitions[currentKind].purpose}</p>
              <p className="npi-muted">
                {data.canWrite
                  ? '在下方新增记录，或点击已有草稿继续填写。'
                  : project.currentNpiStage === 'completed'
                    ? '项目已结项，只读保留记录。'
                    : '当前为查阅视角，流程记录由项目负责人填写。'}
              </p>
            </div>
            <div className="npi-lifecycle-gate">
              <strong>
                {data.gate.next
                  ? `进入${stageLabels[data.gate.next]}前`
                  : '已完成归档'}
              </strong>
              {data.gate.blockers.length ? (
                <ul>
                  {data.gate.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  {data.gate.next
                    ? '阶段记录已齐备，可核对后推进。'
                    : '可查阅各阶段记录、原报告和结论。'}
                </p>
              )}
              {data.canWrite && data.gate.next && (
                <button
                  className="npi-button secondary"
                  disabled={!!data.gate.blockers.length}
                  onClick={advance}
                >
                  推进阶段 · {stageLabels[data.gate.next]}
                </button>
              )}
            </div>
          </div>
          {notice && (
            <p role="status" className="npi-process-notice">
              {notice}
            </p>
          )}
          <div className="npi-lifecycle-records">
            <div className="npi-panel-title">
              <h3>过程记录</h3>
              <label>
                记录范围{' '}
                <select
                  aria-label="流程记录范围"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value)
                    setLimit(20)
                  }}
                >
                  <option value="all">全部阶段</option>
                  {lifecycleKinds.map((k) => (
                    <option key={k} value={k}>
                      {lifecycleDefinitions[k].label}
                    </option>
                  ))}
                </select>
              </label>
              {data.canWrite && (
                <button
                  className="npi-button secondary"
                  onClick={() =>
                    open(
                      undefined,
                      filter === 'all'
                        ? currentKind
                        : (filter as LifecycleKind),
                    )
                  }
                >
                  新增记录
                </button>
              )}
            </div>
            {!rows.length ? (
              <p className="npi-module-empty">
                尚无记录。可先保存计划草稿，到现场后补齐事实与结论；历史项目按真实资料补充，不回填未经核实的结果。
              </p>
            ) : (
              <div className="npi-lifecycle-list">
                {rows.slice(0, limit).map((r) => (
                  <article
                    key={r.id}
                    className={r.status === 'cancelled' ? 'cancelled' : ''}
                  >
                    <button
                      className="npi-project-link"
                      onClick={() => open(r)}
                      aria-label={`查看流程记录 ${r.title}`}
                    >
                      {r.title}
                    </button>
                    <span>
                      {lifecycleDefinitions[r.kind].label} ·{' '}
                      {statusLabels[r.status]}
                    </span>
                    <strong
                      className={
                        r.result === 'fail' || r.overdue
                          ? 'npi-warning-text'
                          : ''
                      }
                    >
                      {resultLabels[r.result]}
                      {r.overdue ? ' · 跟进逾期' : ''}
                    </strong>
                    <small>
                      {r.performedDate ||
                        (r.plannedDate
                          ? `计划 ${r.plannedDate}`
                          : '日期待填')}{' '}
                      · {r.author} · {r.files} 份附件
                    </small>
                    {r.issueId && (
                      <button
                        className="npi-project-link"
                        onClick={() => onTab('issues')}
                      >
                        查看关联问题
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
            {rows.length > limit && (
              <button
                className="npi-button secondary"
                onClick={() => setLimit((n) => n + 20)}
              >
                再显示20条
              </button>
            )}
          </div>
        </>
      )}
      {edit && definition && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) close()
          }}
        >
          <DialogContent
            className="npi-modal npi-lifecycle-modal"
            data-saving={busy || fileBusy}
            onEscapeKeyDown={(e) => {
              if (busy || fileBusy) e.preventDefault()
            }}
          >
            <DialogTitle>
              {readOnly ? '查阅记录' : '填写记录'} · {definition.label}
            </DialogTitle>
            <DialogDescription>
              {definition.purpose} 已提交记录不覆盖，更正或复测请新增记录。
            </DialogDescription>
            <div className="npi-photo-actions">
              <button
                type="button"
                className="npi-button secondary"
                disabled={busy || fileBusy}
                onClick={async () => {
                  if (!readOnly && (dirty || edit.version === 0)) {
                    await save('draft')
                  }
                  attachments.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                }}
              >
                {!readOnly && (dirty || edit.version === 0)
                  ? '保存并添加照片'
                  : '照片与报告'}
              </button>
            </div>
            {editError && (
              <p className="npi-error" role="alert">
                {editError}
                <button
                  type="button"
                  className="npi-button secondary"
                  disabled={busy || fileBusy}
                  onClick={() => void reconcile()}
                >
                  核对服务器记录
                </button>
              </p>
            )}
            <div className="npi-lifecycle-editor-body">
              <form
                id="lifecycle-record-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  const action = (
                    e.nativeEvent as SubmitEvent
                  ).submitter?.getAttribute('value')
                  void save(action === 'submit' ? 'submit' : 'draft')
                }}
              >
                <fieldset disabled={readOnly || busy || fileBusy}>
                  <div className="npi-form-grid">
                    <label>
                      记录类型
                      <select
                        aria-label="记录类型"
                        disabled={edit.version > 0}
                        value={edit.kind}
                        onChange={(e) => {
                          const kind = e.target.value as LifecycleKind
                          patch({
                            kind,
                            title: lifecycleDefinitions[kind].label,
                            result: '',
                            data: { fields: {}, measurements: [] },
                          })
                        }}
                      >
                        {lifecycleKinds.map((k) => (
                          <option value={k} key={k}>
                            {lifecycleDefinitions[k].label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      记录标题
                      <input
                        aria-label="记录标题"
                        maxLength={200}
                        required
                        value={edit.title}
                        onChange={(e) => patch({ title: e.target.value })}
                      />
                    </label>
                    <label>
                      计划日期
                      <input
                        aria-label="计划日期"
                        type="date"
                        value={edit.plannedDate}
                        onChange={(e) => patch({ plannedDate: e.target.value })}
                      />
                    </label>
                    <label>
                      实际记录日期
                      <input
                        aria-label="实际记录日期"
                        type="date"
                        value={edit.performedDate}
                        onChange={(e) =>
                          patch({ performedDate: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  {edit.result !== 'not_applicable' &&
                    [...new Set(definition.fields.map((f) => f.group))].map(
                      (group) => (
                        <section key={group} className="npi-lifecycle-fields">
                          <h3>{group}</h3>
                          <div className="npi-form-grid">
                            {definition.fields
                              .filter((f) => f.group === group)
                              .map((f) => (
                                <label
                                  key={f.key}
                                  className={f.short ? '' : 'wide'}
                                >
                                  {f.label}
                                  {f.short ? (
                                    <input
                                      aria-label={f.label}
                                      maxLength={8000}
                                      value={edit.data.fields[f.key] || ''}
                                      onChange={(e) =>
                                        setField(f.key, e.target.value)
                                      }
                                      placeholder={f.hint}
                                    />
                                  ) : (
                                    <textarea
                                      aria-label={f.label}
                                      maxLength={8000}
                                      rows={2}
                                      value={edit.data.fields[f.key] || ''}
                                      onChange={(e) =>
                                        setField(f.key, e.target.value)
                                      }
                                      placeholder={f.hint}
                                    />
                                  )}
                                </label>
                              ))}
                          </div>
                        </section>
                      ),
                    )}
                  {edit.kind === 'test' && (
                    <section className="npi-lifecycle-fields">
                      <h3>实际测项与判定</h3>
                      <p className="npi-muted">
                        逐项填写实测结果；限值和方法以已确认的技术协议或标准为准。
                      </p>
                      <div className="npi-process-measures">
                        <table>
                          <thead>
                            <tr>
                              <th>测项</th>
                              <th>判定要求</th>
                              <th>实测结果</th>
                              <th>单位</th>
                              <th>判定</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {edit.data.measurements.map((m, i) => (
                              <tr key={i}>
                                {(
                                  [
                                    'item',
                                    'requirement',
                                    'measured',
                                    'unit',
                                  ] as const
                                ).map((k, n) => (
                                  <td key={k}>
                                    <input
                                      aria-label={`${['测项名称', '测项要求', '实测结果', '测项单位'][n]}${i + 1}`}
                                      value={m[k]}
                                      maxLength={1000}
                                      onChange={(e) =>
                                        measure(i, k, e.target.value)
                                      }
                                    />
                                  </td>
                                ))}
                                <td>
                                  <select
                                    aria-label={`测项判定${i + 1}`}
                                    value={m.verdict}
                                    onChange={(e) =>
                                      measure(i, 'verdict', e.target.value)
                                    }
                                  >
                                    <option value="">待判定</option>
                                    <option value="pass">通过</option>
                                    <option value="fail">不通过</option>
                                  </select>
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    aria-label={`移除测项${i + 1}`}
                                    onClick={() =>
                                      patch({
                                        data: {
                                          ...edit.data,
                                          measurements:
                                            edit.data.measurements.filter(
                                              (_, n) => n !== i,
                                            ),
                                        },
                                      })
                                    }
                                  >
                                    移除
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        type="button"
                        className="npi-button secondary"
                        disabled={edit.data.measurements.length >= 100}
                        onClick={() =>
                          patch({
                            data: {
                              ...edit.data,
                              measurements: [
                                ...edit.data.measurements,
                                {
                                  item: '',
                                  requirement: '',
                                  measured: '',
                                  unit: '',
                                  verdict: '',
                                },
                              ],
                            },
                          })
                        }
                      >
                        添加测项
                      </button>
                    </section>
                  )}
                  <section className="npi-lifecycle-fields">
                    <h3>分析与结论</h3>
                    <div className="npi-form-grid">
                      <label>
                        结论
                        <select
                          aria-label="结论"
                          value={edit.result}
                          onChange={(e) =>
                            patch({ result: e.target.value as LifecycleResult })
                          }
                        >
                          <option value="">待判定</option>
                          <option value="pass">通过</option>
                          <option value="fail">不通过</option>
                          <option value="continue">继续跟踪</option>
                          {edit.kind === 'trial' && (
                            <option value="not_applicable">不适用</option>
                          )}
                        </select>
                      </label>
                      {edit.result === 'not_applicable' && (
                        <>
                          <label className="wide">
                            不适用说明
                            <textarea
                              aria-label="不适用说明"
                              value={edit.data.fields.waiverReason || ''}
                              maxLength={8000}
                              onChange={(e) =>
                                setField('waiverReason', e.target.value)
                              }
                            />
                          </label>
                          <label className="wide">
                            客户或合同确认依据
                            <textarea
                              aria-label="客户或合同确认依据"
                              value={
                                edit.data.fields.customerConfirmation || ''
                              }
                              maxLength={8000}
                              onChange={(e) =>
                                setField('customerConfirmation', e.target.value)
                              }
                            />
                          </label>
                        </>
                      )}
                      <label className="wide">
                        分析与最终结论说明
                        <textarea
                          aria-label="分析与最终结论说明"
                          value={edit.data.fields.summary || ''}
                          maxLength={8000}
                          rows={3}
                          onChange={(e) => setField('summary', e.target.value)}
                        />
                      </label>
                      {['fail', 'continue'].includes(edit.result) && (
                        <>
                          <label>
                            下次跟进日期
                            <input
                              aria-label="下次跟进日期"
                              type="date"
                              value={edit.data.fields.followUpDate || ''}
                              onChange={(e) =>
                                setField('followUpDate', e.target.value)
                              }
                            />
                          </label>
                          <label className="wide">
                            后续措施
                            <textarea
                              aria-label="后续措施"
                              rows={2}
                              value={edit.data.fields.nextAction || ''}
                              maxLength={8000}
                              onChange={(e) =>
                                setField('nextAction', e.target.value)
                              }
                            />
                          </label>
                          <p className="wide npi-muted">
                            提交后生成项目问题，默认由项目负责人跟进。问题处理、复核与关闭统一在“问题闭环”。
                          </p>
                        </>
                      )}
                    </div>
                  </section>
                </fieldset>
              </form>
              <section className="npi-lifecycle-fields" ref={attachments}>
                <h3>报告与依据</h3>
                <p className="npi-photo-requirement">
                  {edit.result === 'not_applicable'
                    ? '客户试用不适用：上传客户或合同确认依据，无需补拍试用现场照片。'
                    : `本阶段应覆盖：${stagePhotoRequirements[edit.kind].join('；')}。提交前至少上传一张未归档的照片或截图，项目负责人核对覆盖内容和清晰度。`}
                </p>
                {edit.version === 0 ? (
                  <p className="npi-muted">
                    先保存草稿，再上传报告、现场照片或客户反馈。
                  </p>
                ) : (
                  <>
                    {dirty && (
                      <p className="npi-warning-text">
                        请先保存当前修改，再上传或归档附件。
                      </p>
                    )}
                    <NpiFiles
                      key={edit.id}
                      api={api}
                      scope={{ kind: 'lifecycle', id: edit.id }}
                      readOnly={readOnly}
                      disabled={busy || dirty}
                      lifecycleVersion={edit.version}
                      defaultCategory={
                        edit.kind === 'test' ? 'report' : 'evidence'
                      }
                      onBusyChange={setFileBusy}
                      onChanged={() => changed(edit.id)}
                    />
                  </>
                )}
              </section>
            </div>
            <div className="npi-actions">
              <button
                type="button"
                className="npi-button secondary"
                disabled={busy || fileBusy}
                onClick={close}
              >
                关闭
              </button>
              {!readOnly && (
                <>
                  {edit.version > 0 && (
                    <button
                      type="button"
                      className="npi-button secondary"
                      disabled={busy || fileBusy}
                      onClick={() => void save('cancel')}
                    >
                      取消草稿
                    </button>
                  )}
                  <button
                    form="lifecycle-record-form"
                    type="submit"
                    value="draft"
                    className="npi-button secondary"
                    disabled={busy || fileBusy}
                  >
                    保存草稿
                  </button>
                  <button
                    form="lifecycle-record-form"
                    type="submit"
                    value="submit"
                    className="npi-button"
                    disabled={busy || fileBusy}
                  >
                    {busy ? '正在保存…' : '提交结论'}
                  </button>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
