// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Plus, ShieldCheck, Search } from 'lucide-react'
import { requestId } from '../../lib/request-id'
import {
  qualityCommonFields,
  qualityFields,
  qualityKinds,
  qualityResults,
  qualityStatuses,
  type QualityKind,
} from '../../lib/npi/quality'
import type {
  QualityDetail,
  QualityRecord,
  qualityProjects,
  qualityHistory,
} from '../../lib/npi/quality-service'
import { stageLabels } from './navigation'
import { NpiFiles } from './NpiFiles'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import './quality.css'
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
const resultName = (r: QualityRecord) =>
  r.exceptionStatus === 'closed'
    ? '异常已关闭'
    : r.exceptionStatus === 'open'
      ? '异常待处理'
      : qualityResults[r.result as keyof typeof qualityResults] || '待填写结论'
export function NpiQualityWorkbench({
  api,
  projectId,
  onSelect,
  revision,
}: {
  api: Api
  projectId: string | null
  onSelect: (id: string | null) => void
  revision: number
}) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof qualityProjects>>>(
      [],
    ),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let active = true
    setError('')
    setLoaded(false)
    void api<typeof rows>('/quality/projects')
      .then((r) => {
        if (active) {
          setRows(r)
          setLoaded(true)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [api, revision, projectId])
  if (projectId)
    return (
      <>
        <button className="npi-back" onClick={() => onSelect(null)}>
          <ArrowLeft size={16} />
          返回质量项目
        </button>
        <NpiQualityPanel
          key={projectId}
          api={api}
          projectId={projectId}
          revision={revision}
        />
      </>
    )
  const filtered = rows.filter((r) =>
    `${r.code} ${r.name} ${r.motorModel} ${r.owner}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  return (
    <section className="npi-quality">
      <div className="quality-intro">
        <ShieldCheck size={28} />
        <div>
          <h2>按项目维护检验与报告</h2>
          <p>来料检验 · 过程检验 · 样机报告。异常只提醒，不拦截项目流程。</p>
        </div>
      </div>
      <label className="quality-search">
        <Search size={16} />
        <input
          aria-label="搜索质量项目"
          placeholder="搜索项目编号、电机类型、型号或负责人"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="npi-error">
          {error}
        </p>
      )}
      <div className="quality-projects">
        {filtered.map((p) => (
          <button
            className="quality-project"
            key={p.id}
            onClick={() => onSelect(p.id)}
          >
            <span className="quality-project-top">
              <strong>{p.code}</strong>
              <span>{stageLabels[p.stage]}</span>
            </span>
            <h3>{p.name}</h3>
            <p>{p.motorModel}</p>
            <span className="quality-project-bottom">
              <span>项目负责人：{p.owner}</span>
              <span className={p.open ? 'quality-warning' : ''}>
                {p.count} 条记录 · {p.open} 项待处理
              </span>
            </span>
          </button>
        ))}
      </div>
      {loaded && !filtered.length && (
        <p className="npi-empty">暂无匹配项目。项目创建后会出现在这里。</p>
      )}
      {!loaded && !error && <p role="status">正在读取项目…</p>}
    </section>
  )
}
export function NpiQualityNotice({
  api,
  projectId,
  onOpen,
}: {
  api: Api
  projectId: string
  onOpen: () => void
}) {
  const [data, setData] = useState<QualityDetail | null>(null)
  useEffect(() => {
    let active = true
    void api<QualityDetail>(`/quality/projects/${projectId}`)
      .then((r) => {
        if (active) setData(r)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [api, projectId])
  return data?.openCount ? (
    <div className="quality-notice" role="status">
      <span>
        质量提醒：{data.openCount}{' '}
        项异常待处理。请与质量部跟进，不影响阶段推进。
      </span>
      <button className="npi-button secondary" onClick={onOpen}>
        查看质量记录
      </button>
    </div>
  ) : null
}
export function NpiQualityPanel({
  api,
  projectId,
  revision = 0,
}: {
  api: Api
  projectId: string
  revision?: number
}) {
  const [data, setData] = useState<QualityDetail | null>(null),
    [kind, setKind] = useState<QualityKind>('incoming'),
    [filter, setFilter] = useState('all'),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<QualityRecord | null>(null),
    [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await api<QualityDetail>(`/quality/projects/${projectId}`)
      setData(next)
      setError('')
      return next
    } catch (e) {
      setError((e as Error).message)
      throw e
    } finally {
      setLoading(false)
    }
  }, [api, projectId])
  useEffect(() => {
    void load().catch(() => {})
  }, [load, revision])
  const records =
    data?.records.filter(
      (r) =>
        r.kind === kind &&
        (filter === 'all'
          ? r.status !== 'voided'
          : filter === 'open'
            ? r.exceptionStatus === 'open' && r.status !== 'voided'
            : r.status === filter) &&
        `${r.title} ${Object.values(r.data).join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) || []
  const create = () =>
    setSelected({
      id: requestId(),
      programId: projectId,
      kind,
      title: `${qualityKinds[kind]}记录`,
      performedDate: new Date().toLocaleDateString('sv-SE', {
        timeZone: 'Asia/Shanghai',
      }),
      status: 'draft',
      result: '',
      data: {
        inspector: data?.actorName || '',
        motorCode: data?.project.motorCode || '',
      },
      exceptionStatus: 'none',
      resolution: '',
      version: 0,
      createdBy: '',
      updatedBy: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  return (
    <section className="npi-quality quality-panel" aria-label="项目质量记录">
      <div className="quality-heading">
        <div>
          <h2>{data?.project.code} · 质量记录</h2>
          <p>
            {data?.project.name} {data?.project.motorModel}
          </p>
        </div>
        <span className="quality-policy">只记录与提醒 · 不拦截流程</span>
      </div>
      {error && (
        <p className="npi-error" role="alert">
          {error}
          <button onClick={() => void load().catch(() => {})}>重试</button>
        </p>
      )}
      {data?.openCount ? (
        <p className="quality-notice">
          {data.openCount} 项异常待处理，请质量部补充处置与复验结论。
        </p>
      ) : null}
      <div className="quality-tabs" role="group" aria-label="检验分类">
        {Object.entries(qualityKinds).map(([key, label]) => (
          <button
            key={key}
            aria-pressed={kind === key}
            onClick={() => setKind(key as QualityKind)}
          >
            {label}
            <span>
              {data?.records.filter(
                (r) => r.kind === key && r.status !== 'voided',
              ).length || 0}
            </span>
          </button>
        ))}
      </div>
      <div className="quality-toolbar">
        <input
          aria-label="搜索质量记录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索物料、批次或报告编号"
        />
        <select
          aria-label="质量记录状态"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">有效记录</option>
          <option value="open">异常待处理</option>
          <option value="draft">草稿</option>
          <option value="recorded">已记录</option>
          <option value="voided">已作废</option>
        </select>
        {data?.canWrite && (
          <button className="npi-button" onClick={create}>
            <Plus size={15} />
            新增{qualityKinds[kind]}
          </button>
        )}
      </div>
      <div className="quality-table-scroll">
        <table className="quality-table">
          <thead>
            <tr>
              <th>记录 / 对象</th>
              <th>批次 / 报告编号</th>
              <th>检验日期</th>
              <th>检验人</th>
              <th>结论与状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.title}</strong>
                  <small>
                    {r.data.materialCode || r.data.sampleId || '—'}{' '}
                    {r.data.materialName || ''}
                  </small>
                </td>
                <td>{r.data.batch || r.data.reportNo || '—'}</td>
                <td>{r.performedDate || '—'}</td>
                <td>{r.data.inspector || '—'}</td>
                <td>
                  <span
                    className={
                      r.exceptionStatus === 'open' ? 'quality-warning' : ''
                    }
                  >
                    {resultName(r)}
                  </span>
                  <small>{qualityStatuses[r.status]}</small>
                </td>
                <td>
                  <button
                    className="npi-button secondary"
                    onClick={() => setSelected(r)}
                  >
                    {data?.canWrite && r.status === 'draft'
                      ? '继续填写'
                      : '查看记录'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!records.length && (
        <p className="npi-empty">
          {loading
            ? '正在读取…'
            : `暂无${qualityKinds[kind]}记录${data?.canWrite ? '，可从右上方新增。' : '。'}`}
        </p>
      )}
      {selected && data && (
        <QualityEditor
          key={selected.id}
          api={api}
          record={selected}
          canWrite={data.canWrite}
          onClose={() => setSelected(null)}
          onChanged={async () => {
            const next = await load()
            return next.records.find((r) => r.id === selected.id)!
          }}
        />
      )}
    </section>
  )
}
function QualityEditor({
  api,
  record,
  canWrite,
  onClose,
  onChanged,
}: {
  api: Api
  record: QualityRecord
  canWrite: boolean
  onClose: () => void
  onChanged: () => Promise<QualityRecord>
}) {
  const [saved, setSaved] = useState(record),
    [draft, setDraft] = useState(record),
    [busy, setBusy] = useState(false),
    [filesBusy, setFilesBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [operation, setOperation] = useState(''),
    [reason, setReason] = useState(''),
    [history, setHistory] = useState<Awaited<
      ReturnType<typeof qualityHistory>
    > | null>(null)
  const editable = canWrite && saved.status === 'draft',
    dirty = JSON.stringify(draft) !== JSON.stringify(saved),
    blocked = busy || filesBusy
  const close = () => {
    if (blocked) return
    if (dirty && !window.confirm('有未保存的质量记录，确定离开？')) return
    onClose()
  }
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || filesBusy) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, filesBusy])
  const mutate = async (action: string) => {
    if (blocked) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await api<QualityRecord>(
        `/quality/projects/${saved.programId}`,
        'POST',
        { ...draft, version: saved.version, action, reason },
      )
      setSaved(next)
      setDraft(next)
      setOperation('')
      setReason('')
      setHistory(null)
      await onChanged()
      setNotice(
        action === 'submit'
          ? '记录已提交。异常仅提醒，不拦截项目流程。'
          : '保存成功',
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const reload = async () => {
    if (blocked) return
    setBusy(true)
    try {
      const next = await onChanged()
      if (next) {
        setSaved(next)
        setDraft(next)
        setError('')
        setNotice('已读取最新版本')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) close()
      }}
    >
      <DialogContent
        className="quality-editor"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (blocked || dirty) e.preventDefault()
        }}
      >
        <DialogTitle>
          {qualityKinds[saved.kind]} · {saved.version ? '记录详情' : '新增记录'}
        </DialogTitle>
        <DialogDescription>
          先保存草稿，再上传现场照片和报告，最后提交记录。
          {saved.version ? ` 当前版本 ${saved.version}。` : ''}
        </DialogDescription>
        <div className="quality-editor-body">
          {error && (
            <div className="npi-error" role="alert">
              {error}
              <button
                type="button"
                disabled={blocked}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm(
                      '读取最新版本会放弃当前未保存的内容，是否继续？',
                    )
                  )
                    void reload()
                }}
              >
                读取最新版本
              </button>
            </div>
          )}
          {notice && <p role="status">{notice}</p>}
          <div className="quality-record-state">
            <span>
              {qualityStatuses[saved.status]} · {resultName(saved)}
            </span>
            {saved.resolution && <p>处置与复验结论：{saved.resolution}</p>}
          </div>
          <fieldset disabled={!editable || blocked} className="quality-fields">
            <label className="quality-wide">
              记录标题
              <input
                maxLength={200}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              检验日期
              <input
                type="date"
                value={draft.performedDate || ''}
                onChange={(e) =>
                  setDraft({ ...draft, performedDate: e.target.value })
                }
              />
            </label>
            <label>
              检验结论
              <select
                aria-label="检验结论"
                value={draft.result}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    result: e.target.value as QualityRecord['result'],
                  })
                }
              >
                <option value="">请选择</option>
                {Object.entries(qualityResults).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            {[...qualityFields[saved.kind], ...qualityCommonFields].map((f) => (
              <label key={f.key} className={f.multiline ? 'quality-wide' : ''}>
                {f.label}
                {f.multiline ? (
                  <textarea
                    rows={f.key === 'findings' ? 3 : 2}
                    maxLength={8000}
                    value={draft.data[f.key] || ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        data: { ...draft.data, [f.key]: e.target.value },
                      })
                    }
                  />
                ) : (
                  <input
                    maxLength={300}
                    value={draft.data[f.key] || ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        data: { ...draft.data, [f.key]: e.target.value },
                      })
                    }
                  />
                )}
              </label>
            ))}
          </fieldset>
          {saved.version > 0 ? (
            <>
              <p className="quality-help">
                提交前须有现场照片。样机报告还须上传报告文件，并填写报告分析与结论。
                {dirty ? '请先保存修改，再上传资料。' : ''}
              </p>
              <NpiFiles
                api={api}
                scope={{ kind: 'quality', id: saved.id }}
                lifecycleVersion={saved.version}
                defaultCategory={
                  saved.kind === 'sample' ? 'report' : 'evidence'
                }
                readOnly={!editable}
                disabled={busy || dirty}
                onBusyChange={setFilesBusy}
                onChanged={async () => {
                  const next = await onChanged()
                  setSaved(next)
                  setDraft(next)
                  setHistory(null)
                }}
              />
            </>
          ) : (
            <p className="quality-help">
              保存草稿后，可直接拍照、选择多张照片或上传报告。
            </p>
          )}
          {saved.version > 0 && (
            <details
              className="quality-audit"
              onToggle={(e) => {
                if (e.currentTarget.open && !history)
                  void api<NonNullable<typeof history>>(
                    `/quality/records/${saved.id}/history`,
                  )
                    .then(setHistory)
                    .catch((e) => setError(e.message))
              }}
            >
              <summary>修改与上传记录</summary>
              {history?.map((h) => (
                <div key={h.id}>
                  <strong>
                    {h.actor} ·{' '}
                    {(
                      {
                        QUALITY_SAVE: '保存草稿',
                        QUALITY_SUBMIT: '提交记录',
                        QUALITY_REOPEN: '撤回编辑',
                        QUALITY_RESOLVE: '关闭异常',
                        QUALITY_VOID: '作废记录',
                        FILE_UPLOADED: '上传附件',
                      } as Record<string, string>
                    )[h.action] || h.action}
                  </strong>
                  <small>{new Date(h.at).toLocaleString('zh-CN')}</small>
                  <details>
                    <summary>查看内容</summary>
                    <QualityAuditContent value={h.detail} />
                  </details>
                </div>
              ))}
            </details>
          )}
          {operation && (
            <div className="quality-reason">
              <label>
                {operation === 'resolve'
                  ? '处置措施与复验结论'
                  : '修改 / 作废原因'}
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                />
              </label>
              <button
                className="npi-button"
                disabled={blocked || !reason.trim()}
                onClick={() => void mutate(operation)}
              >
                确认
                {operation === 'resolve'
                  ? '关闭异常'
                  : operation === 'reopen'
                    ? '撤回编辑'
                    : '作废'}
              </button>
              <button
                className="npi-button secondary"
                disabled={blocked}
                onClick={() => setOperation('')}
              >
                取消
              </button>
            </div>
          )}
        </div>
        <div className="quality-editor-footer">
          <button
            className="npi-button secondary"
            disabled={blocked}
            onClick={close}
          >
            返回列表
          </button>
          {editable && (
            <>
              <button
                className="npi-button secondary"
                disabled={blocked}
                onClick={() => void mutate('save')}
              >
                保存草稿
              </button>
              <button
                className="npi-button"
                disabled={blocked || !saved.version}
                onClick={() => void mutate('submit')}
              >
                提交记录
              </button>
            </>
          )}
          {canWrite && saved.status === 'recorded' && (
            <>
              <button
                className="npi-button secondary"
                disabled={blocked}
                onClick={() => setOperation('reopen')}
              >
                撤回编辑
              </button>
              {saved.exceptionStatus === 'open' && (
                <button
                  className="npi-button"
                  disabled={blocked}
                  onClick={() => setOperation('resolve')}
                >
                  填写处置并关闭异常
                </button>
              )}
            </>
          )}
          {canWrite && saved.version > 0 && saved.status !== 'voided' && (
            <button
              className="quality-text-button"
              disabled={blocked}
              onClick={() => setOperation('void')}
            >
              作废
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function QualityAuditContent({ value }: { value: unknown }) {
  const detail = (value || {}) as {
    reason?: string
    fileName?: string
    analysis?: string
    before?: QualityRecord
    after?: QualityRecord
  }
  const snapshot = detail.after
  return (
    <div className="quality-audit-content">
      {detail.reason && <p>原因 / 处置：{detail.reason}</p>}
      {detail.fileName && <p>附件：{detail.fileName}</p>}
      {detail.analysis && <p>报告分析：{detail.analysis}</p>}
      {snapshot && (
        <>
          <p>
            {snapshot.title} · {snapshot.performedDate || '未填写日期'} ·{' '}
            {qualityResults[snapshot.result as keyof typeof qualityResults] ||
              '待填写结论'}
          </p>
          <dl>
            {[...qualityFields[snapshot.kind], ...qualityCommonFields].map(
              (f) =>
                snapshot.data[f.key] ? (
                  <div key={f.key}>
                    <dt>{f.label}</dt>
                    <dd>{snapshot.data[f.key]}</dd>
                  </div>
                ) : null,
            )}
          </dl>
          {snapshot.resolution && <p>处置与复验：{snapshot.resolution}</p>}
          {detail.before && (
            <p>
              修订前：{detail.before.title} ·{' '}
              {qualityStatuses[detail.before.status]} ·{' '}
              {qualityResults[
                detail.before.result as keyof typeof qualityResults
              ] || '待填写结论'}
              。完整原内容见上一条保存记录。
            </p>
          )}
        </>
      )}
    </div>
  )
}
