// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Circle, Plus, FileText } from 'lucide-react'
import { stages, today } from '../../lib/npi/domain'
import {
  lifecycleDefinitions,
  lifecycleKinds,
  resultLabels,
  statusLabels,
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
  const formRef = useRef<HTMLFormElement>(null)
  const [showFiles, setShowFiles] = useState(false)
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
          title: lifecycleDefinitions[type].label + '记录',
          plannedDate: '',
          performedDate: today(),
          result: '',
          data: { fields: {}, measurements: [] },
          version: 0,
          status: 'draft',
        }
    setShowFiles(false)
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
  const save = async (action: 'record' | 'cancel', keepOpen = false) => {
    if (!edit || busy || fileBusy) return false
    const reason =
      action === 'cancel'
        ? window.prompt('作废原因（原记录与附件仍保留）')
        : undefined
    if (action === 'cancel' && !reason) return false
    setBusy(true)
    setEditError('')
    try {
      await api(`/projects/${project.id}/lifecycle/${edit.id}`, 'PUT', {
        ...edit,
        expectedVersion: edit.version,
        action,
        reason,
      })
      await changed(keepOpen ? edit.id : undefined)
      if (!keepOpen) setEdit(null)
      setNotice(
        action === 'record'
          ? '记录已保存。需要时可继续补充，阶段由负责人单独推进。'
          : '记录已作废，原文与附件仍保留。',
      )
      return true
    } catch (e) {
      setEditError(
        e instanceof Error ? e.message : '保存失败，请核对最新记录后重试',
      )
      return false
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
  const readOnly =
    !data?.canWrite || !['draft', 'recorded'].includes(edit?.status || '')
  const currentKind =
    project.currentNpiStage === 'completed'
      ? 'closure'
      : project.currentNpiStage
  const rows = (data?.records || []).filter(
    (r) => filter === 'all' || r.kind === filter,
  )
  const definition = edit ? lifecycleDefinitions[edit.kind] : null
  const blockers = [
    ...(data?.gate.blockers || []),
    ...(data?.gate.next === 'completed' &&
    (project.bomReviewCount || project.untrackedBomCount)
      ? ['当前 BOM 仍有待复核或未分配的零部件，请先核对。']
      : []),
  ]
  const legacyFields = edit
    ? Object.entries(edit.data.fields).filter(([k, v]) => k !== 'summary' && v)
    : []
  const fieldLabels = Object.fromEntries([
    ...Object.values(lifecycleDefinitions).flatMap((d) =>
      d.fields.map((f) => [f.key, f.label]),
    ),
    ['nextAction', '历史后续措施'],
    ['followUpDate', '历史跟进日期'],
    ['waiverReason', '历史不适用说明'],
  ])
  return (
    <section className="npi-lifecycle" aria-label="新品全流程跟踪">
      <div className="npi-lifecycle-heading">
        <div>
          <h2>项目流程</h2>
          <p>负责人按实际进展推进阶段，过程记录按需补充。</p>
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
        <p role="status">正在读取项目流程…</p>
      ) : (
        <>
          <div className="npi-lifecycle-current">
            <div>
              <small>当前阶段</small>
              <h3>{stageLabels[project.currentNpiStage]}</h3>
              <p>记录、历史结论和附件均不作为推进条件。</p>
              <p className="npi-muted">
                {data.canWrite
                  ? '确认实际工作进展后，点击右侧按钮按顺序推进。'
                  : project.currentNpiStage === 'completed'
                    ? '项目已结项，记录与资料只读保留。'
                    : '阶段推进与记录维护由当前项目负责人操作。'}
              </p>
            </div>
            <div className="npi-lifecycle-gate">
              <strong>
                {data.gate.next
                  ? `下一阶段 · ${stageLabels[data.gate.next]}`
                  : '已完成归档'}
              </strong>
              {blockers.length ? (
                <>
                  <ul>
                    {blockers.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                  <div className="npi-stage-links">
                    <button onClick={() => onTab('manufacturing')}>
                      查看交付任务
                    </button>
                    <button onClick={() => onTab('issues')}>查看问题</button>
                    <button onClick={() => onTab('bom')}>查看 BOM</button>
                  </div>
                </>
              ) : (
                <p>
                  {data.gate.next
                    ? '由负责人确认后推进；交付、BOM 和问题检查继续保留。'
                    : '可查阅各阶段的文字记录、照片及附件。'}
                </p>
              )}
              {data.canWrite && data.gate.next && (
                <button
                  className="npi-button"
                  disabled={!!blockers.length}
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
              <h3>
                过程记录 <small>按需添加</small>
              </h3>
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
                      {k === 'closure' ? '定型结项' : stageLabels[k]}
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
                  <Plus size={15} />
                  新增记录
                </button>
              )}
            </div>
            {!rows.length ? (
              <p className="npi-module-empty">
                暂无记录。需要留痕时填写日期、标题和内容即可，照片与附件选填。
              </p>
            ) : (
              <div className="npi-lifecycle-list">
                {rows.slice(0, limit).map((r) => (
                  <article
                    key={r.id}
                    className={r.status === 'cancelled' ? 'cancelled' : ''}
                  >
                    <div>
                      <button
                        className="npi-project-link"
                        onClick={() => open(r)}
                        aria-label={`查看流程记录 ${r.title}`}
                      >
                        {r.title}
                      </button>
                      <small className="npi-record-excerpt">
                        {r.data.fields.summary || '历史记录，点击查看完整内容'}
                      </small>
                    </div>
                    <span>
                      {r.kind === 'closure' ? '定型结项' : stageLabels[r.kind]}
                    </span>
                    <span>
                      {statusLabels[r.status]}
                      {r.result && (
                        <small className="npi-legacy-result">
                          历史结论：{resultLabels[r.result]}
                        </small>
                      )}
                    </span>
                    <small>
                      {r.performedDate || r.plannedDate || '日期未填'} ·{' '}
                      {r.author}
                      {r.files > 0 ? ` · ${r.files} 份附件` : ''}
                    </small>
                    {r.issueId && (
                      <button
                        className="npi-project-link"
                        onClick={() => onTab('issues')}
                      >
                        关联问题
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
              {readOnly
                ? '查看过程记录'
                : edit.version
                  ? '编辑过程记录'
                  : '新增过程记录'}
            </DialogTitle>
            <DialogDescription>
              填写日期、标题和内容即可。记录单独保存，照片与附件选填，修改保留操作历史。
            </DialogDescription>
            {editError && (
              <p className="npi-error" role="alert">
                {editError}
                <button
                  type="button"
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
                ref={formRef}
                onSubmit={(e) => {
                  e.preventDefault()
                  void save('record')
                }}
              >
                <fieldset disabled={readOnly || busy || fileBusy}>
                  <div className="npi-form-grid">
                    <label>
                      所属阶段
                      <select
                        aria-label="所属阶段"
                        value={edit.kind}
                        disabled={edit.version > 0}
                        onChange={(e) =>
                          patch({ kind: e.target.value as LifecycleKind })
                        }
                      >
                        {lifecycleKinds.map((k) => (
                          <option key={k} value={k}>
                            {k === 'closure' ? '定型结项' : stageLabels[k]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      记录日期
                      <input
                        aria-label="记录日期"
                        type="date"
                        required
                        max={today()}
                        value={edit.performedDate}
                        onChange={(e) =>
                          patch({ performedDate: e.target.value })
                        }
                      />
                    </label>
                    <label className="wide">
                      记录标题
                      <input
                        aria-label="记录标题"
                        maxLength={200}
                        required
                        value={edit.title}
                        onChange={(e) => patch({ title: e.target.value })}
                      />
                    </label>
                    <label className="wide">
                      记录内容
                      <textarea
                        aria-label="记录内容"
                        rows={5}
                        maxLength={8000}
                        required
                        placeholder="简要记录进展、现场情况、发现的问题或后续安排。"
                        value={edit.data.fields.summary || ''}
                        onChange={(e) => setField('summary', e.target.value)}
                      />
                    </label>
                  </div>
                </fieldset>
              </form>
              {(legacyFields.length > 0 ||
                edit.result ||
                edit.data.measurements.length > 0) && (
                <details className="npi-legacy-record">
                  <summary>历史详细内容（原文保留）</summary>
                  {edit.result && <p>历史结论：{resultLabels[edit.result]}</p>}
                  {edit.plannedDate && <p>原计划日期：{edit.plannedDate}</p>}
                  {legacyFields.map(([k, v]) => (
                    <div key={k}>
                      <strong>{fieldLabels[k] || k}</strong>
                      <p>{v}</p>
                    </div>
                  ))}
                  {edit.data.measurements.map((m, i) => (
                    <p key={i}>
                      {m.item} · 要求 {m.requirement} · 实测 {m.measured}{' '}
                      {m.unit} · {resultLabels[m.verdict] || m.verdict}
                    </p>
                  ))}
                </details>
              )}
              <section className="npi-record-optional" ref={attachments}>
                <button
                  type="button"
                  className="npi-button secondary"
                  disabled={busy || fileBusy}
                  onClick={async () => {
                    if (
                      !showFiles &&
                      !readOnly &&
                      (dirty || edit.version === 0)
                    ) {
                      if (!formRef.current?.reportValidity()) return
                      if (!(await save('record', true))) return
                    }
                    setShowFiles((v) => !v)
                  }}
                >
                  {showFiles ? '收起照片与附件' : '照片与附件（选填）'}
                </button>
                {showFiles && edit.version > 0 && (
                  <>
                    <p className="npi-muted">
                      可拍照、从相册多选或上传文件。上传前先保存文字修改。
                    </p>
                    <NpiFiles
                      key={edit.id}
                      api={api}
                      scope={{ kind: 'lifecycle', id: edit.id }}
                      readOnly={readOnly}
                      disabled={busy || dirty}
                      lifecycleVersion={edit.version}
                      defaultCategory="evidence"
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
                  <button
                    type="submit"
                    form="lifecycle-record-form"
                    className="npi-button"
                    disabled={busy || fileBusy}
                  >
                    {busy ? '正在保存…' : '保存记录'}
                  </button>
                  {edit.version > 0 && (
                    <button
                      type="button"
                      className="npi-record-void"
                      disabled={busy || fileBusy}
                      onClick={() => void save('cancel')}
                    >
                      作废记录
                    </button>
                  )}
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
