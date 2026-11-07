// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react'
import { Camera, Images, X } from 'lucide-react'
import { request, useAccount } from '../../lib/auth/context'
import { requestId } from '../../lib/request-id'
import {
  PHOTO_ACCEPT,
  PHOTO_BATCH_LIMIT,
  preparePhoto,
} from '../../lib/npi/prepare-photo'
import type { FileScope, NpiFileList } from '../../lib/npi/file-service'
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
type Photo = {
  id: string
  file: File
  preview: string
  title: string
  status: 'ready' | 'uploading' | 'done' | 'error'
  error?: string
  attempted?: boolean
}
export function NpiPhotos({
  api,
  scope,
  category,
  disabled,
  onPendingChange,
  onChanged,
}: {
  api: Api
  scope: FileScope
  category: string
  disabled: boolean
  onPendingChange: (pending: boolean) => void
  onChanged: () => Promise<void>
}) {
  const { user } = useAccount()
  const [photos, setPhotos] = useState<Photo[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reauth, setReauth] = useState(false),
    [authBusy, setAuthBusy] = useState(false)
  const camera = useRef<HTMLInputElement>(null),
    gallery = useRef<HTMLInputElement>(null)
  const current = useRef(photos),
    active = useRef(false),
    mounted = useRef(true)
  const categoryRef = useRef(category)
  // A picked batch retains its classification and request IDs through every retry.
  if (!photos.length) categoryRef.current = category
  const notify = useRef(onPendingChange)
  notify.current = onPendingChange
  const update = (next: Photo[]) => {
    current.current = next
    if (mounted.current) setPhotos(next)
  }
  const patch = (id: string, values: Partial<Photo>) =>
    update(current.current.map((p) => (p.id === id ? { ...p, ...values } : p)))
  const waiting = photos.filter((p) => p.status !== 'done').length
  useEffect(() => {
    notify.current(busy || waiting > 0)
  }, [busy, waiting])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const p of current.current) URL.revokeObjectURL(p.preview)
      notify.current(false)
    }
  }, [])
  const pick = async (files: FileList | null) => {
    if (!files?.length || active.current || disabled) return
    const selected = Array.from(files)
    if (current.current.length + selected.length > PHOTO_BATCH_LIMIT) {
      setError(
        `每批最多${PHOTO_BATCH_LIMIT}张，请分批上传；已上传照片可清除预览。`,
      )
      return
    }
    active.current = true
    setBusy(true)
    setError('')
    setNotice('正在准备照片…')
    const failures: string[] = []
    try {
      for (const original of selected) {
        try {
          const file = await preparePhoto(original)
          if (!mounted.current) return
          update([
            ...current.current,
            {
              id: requestId(),
              file,
              preview: URL.createObjectURL(file),
              title: original.name.replace(/\.[^.]+$/, '').slice(0, 200),
              status: 'ready',
            },
          ])
        } catch (e) {
          failures.push(
            `${original.name}：${e instanceof Error ? e.message : '无法处理'}`,
          )
        }
      }
      setNotice('核对照片和说明后，点击“上传照片”。')
      setError(failures.join('；'))
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const upload = async () => {
    if (active.current || disabled || !waiting || reauth) return
    active.current = true
    setBusy(true)
    setError('')
    setNotice('')
    let successes = 0
    const path = `/files/${scope.kind}/${scope.id}`
    try {
      for (const photo of current.current.filter((p) => p.status !== 'done')) {
        if (!mounted.current) return
        patch(photo.id, { status: 'uploading', error: '', attempted: true })
        try {
          // Refresh the version for each file; other tabs cannot silently overwrite a record.
          const latest = await api<NpiFileList>(path)
          if (!latest.canUpload)
            throw new Error(
              '记录已提交或权限已变化，不能继续上传；请保留手机原片并核对记录。',
            )
          const data = new FormData()
          data.set('file', photo.file)
          data.set('title', photo.title.trim() || photo.file.name)
          data.set('category', categoryRef.current)
          data.set('requestId', photo.id)
          if (scope.kind === 'lifecycle')
            data.set('expectedRecordVersion', String(latest.recordVersion))
          await api(path, 'POST', data)
          if (!mounted.current) return
          patch(photo.id, { status: 'done', error: '' })
          successes++
        } catch (e) {
          if (!mounted.current) return
          const status = (e as { status?: number }).status
          patch(photo.id, {
            status: 'error',
            error:
              e instanceof Error ? e.message : '上传结果未确认，请重试核对',
          })
          if (status === 401) {
            setReauth(true)
            setError('登录已过期，照片保留在当前页面。重新登录后继续上传。')
            break
          }
          if (status === 403 || status === 409) {
            setError('权限或记录状态已变化，请核对后重试。')
            break
          }
        }
      }
      const left = current.current.filter((p) => p.status !== 'done').length
      setNotice(
        left
          ? `本次成功 ${successes} 张，还有 ${left} 张未确认；重试不会重复保存已接收的照片。`
          : `本批 ${current.current.length} 张照片已全部上传，可在下方查看。`,
      )
      // Even a lost response may have committed. Refresh the record after the batch.
      try {
        await onChanged()
      } catch {
        setError('照片状态已保留，资料列表暂未刷新；请稍后重试核对。')
      }
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const remove = (id: string) => {
    if (active.current) return
    const photo = current.current.find((p) => p.id === id)
    if (photo) URL.revokeObjectURL(photo.preview)
    update(current.current.filter((p) => p.id !== id))
  }
  return (
    <section className="npi-photo-upload" aria-label="批量上传照片">
      <div className="npi-photo-actions">
        <button
          type="button"
          className="npi-button"
          disabled={disabled || busy}
          onClick={() => camera.current?.click()}
        >
          <Camera size={17} />
          拍照
        </button>
        <button
          type="button"
          className="npi-button secondary"
          disabled={disabled || busy}
          onClick={() => gallery.current?.click()}
        >
          <Images size={17} />
          相册多选
        </button>
        <input
          ref={camera}
          type="file"
          aria-label="拍照选择"
          accept={PHOTO_ACCEPT}
          capture="environment"
          hidden
          onChange={(e) => {
            void pick(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={gallery}
          type="file"
          aria-label="相册多选"
          accept={PHOTO_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            void pick(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      <p className="npi-muted">
        每批最多20张，自动缩小大图。请核对编号和读数清晰，保留手机原片；照片说明建议填写“日期＋对象＋部位或现象”。
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="npi-error">
          {error}
        </p>
      )}
      {!!photos.length && (
        <>
          <div className="npi-photo-queue">
            {photos.map((p, i) => (
              <article
                key={p.id}
                className="npi-photo-item"
                data-status={p.status}
              >
                <img src={p.preview} alt={`待上传照片 ${i + 1}`} />
                <label>
                  照片 {i + 1} 说明
                  <input
                    aria-label={`照片 ${i + 1} 说明`}
                    value={p.title}
                    maxLength={200}
                    disabled={busy || p.attempted || disabled}
                    onChange={(e) => patch(p.id, { title: e.target.value })}
                  />
                </label>
                <p role={p.status === 'uploading' ? 'status' : undefined}>
                  {
                    {
                      ready: '待上传',
                      uploading: '正在上传…',
                      done: '已上传',
                      error: '未确认',
                    }[p.status]
                  }
                </p>
                {p.error && <p className="npi-error">{p.error}</p>}
                <button
                  type="button"
                  className="npi-photo-remove"
                  aria-label={`移除照片 ${i + 1} 预览`}
                  disabled={busy}
                  onClick={() => remove(p.id)}
                >
                  <X size={16} />
                </button>
              </article>
            ))}
          </div>
          <div className="npi-photo-actions">
            <button
              type="button"
              className="npi-button"
              disabled={disabled || busy || !waiting || reauth}
              onClick={() => void upload()}
            >
              {busy
                ? '正在处理…'
                : !waiting
                  ? '全部已上传'
                  : photos.some((p) => p.status === 'error')
                    ? `重试未确认照片（${waiting}）`
                    : `上传照片（${waiting}）`}
            </button>
            <span aria-live="polite">
              {photos.length - waiting} / {photos.length} 已上传
            </span>
            <button
              type="button"
              className="npi-button secondary"
              disabled={busy}
              onClick={() => {
                if (
                  waiting &&
                  !window.confirm(
                    '未确认的照片仍只保留在当前页面，确认清除本批预览？已成功上传的文件不会删除。',
                  )
                )
                  return
                for (const p of current.current) URL.revokeObjectURL(p.preview)
                update([])
                setNotice('')
                setError('')
              }}
            >
              清除预览
            </button>
          </div>
          {!!waiting && (
            <p className="npi-muted">
              请保持当前页面至上传完成。移除预览不会删除服务器已接收的照片；修改已尝试上传的说明请先核对原件，再归档重传。
            </p>
          )}
        </>
      )}
      {reauth && (
        <form
          className="npi-photo-reauth"
          aria-label="继续上传登录"
          onSubmit={async (e) => {
            e.preventDefault()
            if (authBusy) return
            const form = e.currentTarget,
              input = new FormData(form)
            setAuthBusy(true)
            setError('')
            try {
              const result = await request<{
                user: { id: string; mustChangePassword: boolean }
              }>('/api/auth/login', 'POST', {
                email: user?.email,
                password: input.get('password'),
              })
              form.reset()
              if (result.user.id !== user?.id)
                throw new Error('登录账号已改变，请保留原片并重新打开项目。')
              if (result.user.mustChangePassword)
                throw new Error(
                  '管理员已要求修改密码，请先在“账号与安全”中修改，再返回重试。',
                )
              await onChanged()
              setReauth(false)
              setNotice('登录已恢复，请点击重试继续上传。')
            } catch (e) {
              setError(e instanceof Error ? e.message : '登录失败')
            } finally {
              setAuthBusy(false)
            }
          }}
        >
          <strong>重新登录，保留本批照片</strong>
          <label>
            邮箱
            <input
              name="username"
              value={user?.email || ''}
              autoComplete="username"
              readOnly
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              disabled={authBusy}
            />
          </label>
          <button className="npi-button" disabled={authBusy}>
            {authBusy ? '正在登录…' : '登录并保留照片'}
          </button>
        </form>
      )}
    </section>
  )
}
