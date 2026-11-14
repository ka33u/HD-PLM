import { resultLabels } from '../../lib/npi/lifecycle'
// SPDX-License-Identifier: AGPL-3.0-or-later
import { requestId as createRequestId } from '../../lib/request-id'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_NPI_FILE_BYTES,
  NPI_FILE_ACCEPT,
  NPI_FILE_TYPES_LABEL,
} from '../../lib/npi/file-types'
import type { FormEvent } from 'react'
import type { FileScope, NpiFileList } from '../../lib/npi/file-service'
import { NpiPhotos } from './NpiPhotos'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import './photos.css'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiFiles({
  api,
  scope,
  buyer = false,
  readOnly = false,
  disabled = false,
  onBusyChange,
  lifecycleVersion,
  defaultCategory,
  onChanged,
}: {
  lifecycleVersion?: number
  defaultCategory?: string
  onChanged?: () => Promise<void>
  api: Api
  scope: FileScope
  buyer?: boolean
  readOnly?: boolean
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}) {
  const [data, setData] = useState<NpiFileList | null>(null)
  const [error, setError] = useState(''),
    [operation, setOperation] = useState<'upload' | 'archive' | null>(null),
    [showArchived, setShowArchived] = useState(false),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(''),
    [message, setMessage] = useState('')
  const [archiveId, setArchiveId] = useState('')
  const [photoPending, setPhotoPending] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const initialCategory =
    defaultCategory ||
    (['lifecycle', 'quality'].includes(scope.kind)
      ? 'report'
      : scope.kind === 'issue'
        ? 'issue'
        : buyer
          ? 'receipt'
          : 'technical')
  const [category, setCategory] = useState(initialCategory)
  const busy = operation !== null
  const blocked = busy || loading || !!loadError || disabled
  const pending = useRef<{ notify?: (busy: boolean) => void } | null>(null)
  const begin = (kind: 'upload' | 'archive') => {
    if (pending.current || blocked || photoPending || readOnly) return null
    const token = { notify: onBusyChange }
    pending.current = token
    setOperation(kind)
    token.notify?.(true)
    return token
  }
  const isCurrent = (token: { notify?: (busy: boolean) => void }) =>
    pending.current === token
  const finish = (token: { notify?: (busy: boolean) => void }) => {
    if (!isCurrent(token)) return
    pending.current = null
    setOperation(null)
    token.notify?.(false)
  }
  useEffect(
    () => () => {
      const token = pending.current
      pending.current = null
      token?.notify?.(false)
    },
    [],
  )
  const requestId = useRef(createRequestId())
  const loadRevision = useRef(0)
  const path = `/files/${scope.kind}/${scope.id}`
  const reload = useCallback(async () => {
    const revision = ++loadRevision.current
    setLoading(true)
    setLoadError('')
    try {
      const next = await api<NpiFileList>(path)
      if (revision === loadRevision.current) setData(next)
    } catch (err) {
      if (revision === loadRevision.current) {
        setLoadError(err instanceof Error ? err.message : '请稍后重试')
      }
    } finally {
      if (revision === loadRevision.current) setLoading(false)
    }
  }, [api, path])
  useEffect(() => {
    void reload()
    return () => {
      loadRevision.current++
    }
  }, [reload, readOnly])
  const upload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending.current || blocked || readOnly || !data?.canUpload) return
    const form = e.currentTarget,
      input = new FormData(form),
      file = input.get('file')
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > MAX_NPI_FILE_BYTES
    ) {
      setError('请选择非空且不超过5MB的文件')
      return
    }
    input.set('requestId', requestId.current)
    if (['lifecycle', 'quality'].includes(scope.kind))
      input.set('expectedRecordVersion', String(lifecycleVersion))
    const token = begin('upload')
    if (!token) return
    setError('')
    setMessage('')
    try {
      await api(path, 'POST', input)
      if (!isCurrent(token)) return
      requestId.current = createRequestId()
      form.reset()
      setCategory(initialCategory)
      setMessage('资料已上传成功，无需重复上传。')
      await reload()
      await onChanged?.()
    } catch (err) {
      if (!isCurrent(token)) return
      setError(err instanceof Error ? err.message : '上传失败，请核对后重试')
    } finally {
      finish(token)
    }
  }
  const images =
    data?.files.filter(
      (f) =>
        f.available &&
        f.mimeType.startsWith('image/') &&
        (showArchived || !f.archivedAt),
    ) || []
  const previewIndex = images.findIndex((f) => f.id === previewId)
  const preview = images[previewIndex]
  return (
    <section className="npi-files" aria-label="附件资料">
      <div className="npi-panel-title">
        <h3>
          {scope.kind === 'project'
            ? '项目资料'
            : ['lifecycle', 'quality'].includes(scope.kind)
              ? '报告与现场依据'
              : scope.kind === 'issue'
                ? '问题附件与照片'
                : '技术附件与到货资料'}
        </h3>
        <button
          type="button"
          className="npi-button secondary"
          disabled={busy || loading || disabled}
          onClick={() => void reload()}
        >
          {loading ? '正在刷新…' : '刷新资料'}
        </button>
      </div>
      <p className="npi-muted">
        {NPI_FILE_TYPES_LABEL}
        ，单个不超过5MB。每次上传独立保留，归档后仍可追溯。
      </p>
      {message && <p role="status">{message}</p>}
      {busy && !message && (
        <p role="status">
          {operation === 'upload' ? '正在上传资料' : '正在归档资料'}
          ，请稍候。保存完成前请保持当前窗口。
        </p>
      )}
      {loadError && (
        <p role="alert" className="npi-error">
          资料列表加载失败：{loadError}。请点击“刷新资料”重试。
          {data && '以下显示上次加载的资料，刷新成功后可继续上传或归档。'}
        </p>
      )}
      {error && (
        <p role="alert" className="npi-error">
          {error}
        </p>
      )}
      {data?.canUpload && !readOnly && (
        <NpiPhotos
          key={path}
          api={api}
          scope={scope}
          category={
            ['lifecycle', 'quality'].includes(scope.kind)
              ? 'evidence'
              : scope.kind === 'issue'
                ? 'issue'
                : buyer
                  ? 'receipt'
                  : category
          }
          disabled={blocked}
          onPendingChange={(value) => {
            setPhotoPending(value)
            onBusyChange?.(value || !!pending.current)
          }}
          onChanged={async () => {
            await reload()
            await onChanged?.()
          }}
        />
      )}
      {data?.canUpload && !readOnly && (
        <details
          className="npi-file-upload-options"
          open={
            !['lifecycle', 'quality'].includes(scope.kind) ||
            initialCategory === 'report'
          }
        >
          <summary>上传报告或其他文件</summary>
          <form onSubmit={upload} className="npi-file-upload">
            <fieldset
              disabled={blocked || photoPending}
              onChange={() => {
                requestId.current = createRequestId()
              }}
            >
              <label>
                资料标题
                <input
                  name="title"
                  maxLength={200}
                  placeholder="可选，默认使用文件名"
                />
              </label>
              <label>
                文件分类
                <select
                  name="category"
                  aria-label="文件分类"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {['lifecycle', 'quality'].includes(scope.kind) ? (
                    <>
                      <option value="report">报告及分析</option>
                      <option value="evidence">现场照片 / 客户反馈依据</option>
                    </>
                  ) : scope.kind === 'issue' ? (
                    <option value="issue">问题照片 / 说明资料</option>
                  ) : (
                    <>
                      {!buyer && <option value="technical">技术资料</option>}
                      {scope.kind === 'tracking' && (
                        <option value="receipt">到货照片 / 资料</option>
                      )}
                    </>
                  )}
                </select>
              </label>
              {['lifecycle', 'quality'].includes(scope.kind) &&
                category === 'report' && (
                  <>
                    <label>
                      报告分析
                      <textarea
                        name="analysis"
                        aria-label="报告分析"
                        maxLength={8000}
                        rows={3}
                        required
                        placeholder="对照判定依据，说明结果、差异、原因、影响和后续措施，不能只写见报告。"
                      />
                    </label>
                    <label>
                      报告结论
                      <select
                        name="conclusion"
                        aria-label="报告结论"
                        defaultValue=""
                        required
                      >
                        <option value="">请选择</option>
                        <option value="pass">通过</option>
                        <option value="fail">不通过</option>
                        <option value="continue">需要补充验证</option>
                      </select>
                    </label>
                  </>
                )}
              <label>
                选择文件或照片
                <input
                  name="file"
                  aria-label="选择文件或照片"
                  type="file"
                  accept={NPI_FILE_ACCEPT}
                  required
                />
              </label>
              <button className="npi-button">
                {operation === 'upload' ? '正在上传…' : '上传资料'}
              </button>
            </fieldset>
          </form>
        </details>
      )}
      <label className="npi-file-archive-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        显示已归档资料
      </label>
      {!data ? (
        loading ? (
          <p role="status">正在加载资料…</p>
        ) : null
      ) : (
        <>
          {data.files
            .filter((f) => showArchived || !f.archivedAt)
            .map((f) => (
              <article key={f.id} className="npi-file-card">
                {f.available && f.mimeType.startsWith('image/') && (
                  <button
                    type="button"
                    className="npi-photo-preview"
                    aria-label={`查看照片：${f.title}`}
                    onClick={() => setPreviewId(f.id)}
                  >
                    <img
                      loading="lazy"
                      src={`/api/v1/npi/file-content/${f.id}?inline=1`}
                      alt={`${f.title}预览`}
                    />
                  </button>
                )}
                <div>
                  <strong>{f.title}</strong>
                  <p>
                    {f.name} · {Math.max(1, Math.ceil(f.size / 1024))} KB
                  </p>
                  <small>
                    {f.uploader} ·{' '}
                    {new Date(f.createdAt).toLocaleString('zh-CN')}
                  </small>
                  {f.analysis && (
                    <details>
                      <summary>报告分析 · {resultLabels[f.conclusion]}</summary>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{f.analysis}</p>
                    </details>
                  )}
                  {f.archivedAt && <p>已归档：{f.archiveReason}</p>}
                  {!f.available && <p>文件已不可用，请联系管理员核查</p>}
                  <div className="npi-row-actions">
                    {f.available && (
                      <a
                        className="npi-button secondary"
                        href={`/api/v1/npi/file-content/${f.id}`}
                      >
                        下载文件
                      </a>
                    )}
                    {data.canArchive && !readOnly && !f.archivedAt && (
                      <button
                        type="button"
                        disabled={blocked || photoPending}
                        onClick={() => setArchiveId(f.id)}
                      >
                        归档资料
                      </button>
                    )}
                  </div>
                  {archiveId === f.id && data.canArchive && !readOnly && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault()
                        if (pending.current || blocked || photoPending) return
                        const reason = new FormData(e.currentTarget).get(
                          'reason',
                        )
                        const token = begin('archive')
                        if (!token) return
                        setError('')
                        setMessage('')
                        try {
                          await api(`/file-archive/${f.id}`, 'POST', {
                            reason,
                            ...(['lifecycle', 'quality'].includes(scope.kind)
                              ? { expectedRecordVersion: lifecycleVersion }
                              : {}),
                          })
                          if (!isCurrent(token)) return
                          setArchiveId('')
                          setMessage(
                            '资料已归档，勾选“显示已归档资料”可查看原件。',
                          )
                          await reload()
                          await onChanged?.()
                        } catch (err) {
                          if (!isCurrent(token)) return
                          setError(
                            err instanceof Error
                              ? err.message
                              : '归档失败，请核对后重试',
                          )
                        } finally {
                          finish(token)
                        }
                      }}
                    >
                      <label>
                        归档原因
                        <textarea
                          name="reason"
                          required
                          maxLength={2000}
                          disabled={blocked || photoPending}
                        />
                      </label>
                      <div className="npi-row-actions">
                        <button
                          className="npi-button"
                          disabled={blocked || photoPending}
                        >
                          {operation === 'archive' ? '正在归档…' : '确认归档'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setArchiveId('')}
                        >
                          取消
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </article>
            ))}
          {!data.files.some((f) => showArchived || !f.archivedAt) && (
            <p className="npi-muted">
              {loadError
                ? '尚未取得最新资料列表，请刷新后查看。'
                : loading
                  ? '正在刷新资料列表…'
                  : '暂无资料。可上传技术规格、供应商资料或现场照片。'}
            </p>
          )}
        </>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null)
        }}
      >
        <DialogContent className="npi-photo-lightbox">
          <DialogTitle>{preview?.title}</DialogTitle>
          <DialogDescription>
            照片预览 · {previewIndex + 1} / {images.length}
          </DialogDescription>
          {preview && (
            <img
              src={`/api/v1/npi/file-content/${preview.id}?inline=1`}
              alt={preview.title}
            />
          )}
          <div className="npi-photo-actions">
            <button
              type="button"
              disabled={previewIndex <= 0}
              onClick={() => setPreviewId(images[previewIndex - 1]!.id)}
            >
              上一张
            </button>
            <button
              type="button"
              disabled={previewIndex >= images.length - 1}
              onClick={() => setPreviewId(images[previewIndex + 1]!.id)}
            >
              下一张
            </button>
            <button type="button" onClick={() => setPreviewId(null)}>
              关闭预览
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
