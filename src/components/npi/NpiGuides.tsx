// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { GuideCatalog, SopGuide } from '../../lib/npi/guide-types'
import './guides.css'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
const endpoint = '/api/v1/npi'

function initialLocation() {
  const params = new URLSearchParams(window.location.search)
  const value = params.get('page') || '1'
  return {
    id: params.get('guide') || '',
    page: /^[1-9]\d{0,2}$/.test(value) ? Number(value) : 1,
  }
}

export function NpiGuides({ api, role }: { api: Api; role: string }) {
  const [catalog, setCatalog] = useState<GuideCatalog | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [location, setLocation] = useState(initialLocation)
  const [downloading, setDownloading] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const [notice, setNotice] = useState('')
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    let active = true
    setError('')
    void api<GuideCatalog>('/guides')
      .then((next) => {
        if (active) setCatalog(next)
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : '无法读取文件目录')
      })
    return () => {
      active = false
    }
  }, [api, revision])

  const guide = catalog?.guides.find((item) => item.id === location.id)
  const page = guide ? Math.min(location.page, guide.pages.length) : 1
  const select = (id: string, nextPage = 1) => {
    setLocation({ id, page: nextPage })
    setZoom(false)
    setNotice('')
    setDownloadError('')
    const params = new URLSearchParams({ view: 'guides' })
    if (id) {
      params.set('guide', id)
      params.set('page', String(nextPage))
    }
    window.history.replaceState(null, '', '/npi?' + params)
  }

  const download = async (id: string, format: string, title: string) => {
    if (downloading) return
    setDownloading(`${id}-${format}`)
    setDownloadError('')
    setNotice('')
    try {
      const response = await fetch(
        endpoint +
          (id === 'process'
            ? '/process-guide'
            : `/guides/${id}/download/${format}`),
      )
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || '下载失败，请稍后重试')
      }
      if (
        !response.headers.get('content-disposition')?.startsWith('attachment;')
      )
        throw new Error('未收到文件，请重新登录后重试')
      const blob = await response.blob()
      if (!blob.size) throw new Error('文件为空，请联系管理员')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${title.replace(/ /g, '')}.${format}`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('已发起下载，请在浏览器下载列表中查看。')
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : '下载失败，请稍后重试')
    } finally {
      setDownloading('')
    }
  }
  const downloads = (item: SopGuide) => (
    <div className="npi-guide-downloads">
      <button
        className="npi-button secondary"
        disabled={!!downloading}
        onClick={() => void download(item.id, 'pptx', item.title)}
      >
        <Download size={15} />
        {downloading === `${item.id}-pptx` ? '正在下载…' : '下载 PPT'}
      </button>
      <button
        className="npi-guide-text-button"
        disabled={!!downloading}
        onClick={() => void download(item.id, 'pdf', item.title)}
      >
        {downloading === `${item.id}-pdf` ? '正在下载…' : '下载 PDF'}
      </button>
    </div>
  )

  return (
    <section className="npi-guides" aria-label="流程文件与部门操作 SOP">
      {error && (
        <div role="alert" className="npi-message error">
          {error}
          <button
            className="npi-button secondary"
            onClick={() => setRevision((n) => n + 1)}
          >
            重试
          </button>
        </div>
      )}
      {downloadError && (
        <div role="alert" className="npi-message error">
          {downloadError}
          <a href="/login?redirect=%2Fnpi%3Fview%3Dguides">重新登录</a>
        </div>
      )}
      {notice && (
        <p role="status" className="npi-message success">
          {notice}
        </p>
      )}
      {!catalog && !error && <p role="status">正在读取流程与 SOP…</p>}
      {catalog && !guide && (
        <>
          {location.id && (
            <p role="status">该课件链接已失效，请从下方重新选择。</p>
          )}
          <article className="npi-guide-process">
            <FileText size={25} aria-hidden="true" />
            <div>
              <span className="npi-guide-kicker">统一流程要求</span>
              <h2>设计部新品跟踪管理程序</h2>
              <p>
                职责、阶段要求、照片与报告要求；各部门操作请配合下方 SOP 使用。
              </p>
            </div>
            <button
              className="npi-button secondary"
              disabled={!!downloading}
              onClick={() =>
                void download('process', 'docx', '设计部新品跟踪管理程序')
              }
            >
              <Download size={16} />
              下载流程文件
            </button>
          </article>
          <div className="npi-guide-section-title">
            <h2>部门操作 SOP</h2>
            <p>在线查看图文步骤，或下载课件培训使用。</p>
          </div>
          <div className="npi-guide-grid">
            {[...catalog.guides]
              .sort((a, b) => Number(b.role === role) - Number(a.role === role))
              .map((item) => (
                <article
                  className={`npi-guide-card npi-guide-${item.id}`}
                  key={item.id}
                >
                  <div className="npi-guide-card-heading">
                    <BookOpen size={25} aria-hidden="true" />
                    <span>{item.department}</span>
                    {item.role === role && <small>当前岗位</small>}
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  <div className="npi-guide-meta">
                    {item.pages.length} 页 · {item.edition} 版 ·{' '}
                    {item.appliesTo}
                  </div>
                  <button
                    className="npi-button npi-guide-read"
                    onClick={() => select(item.id)}
                  >
                    <BookOpen size={17} />
                    在线查看
                    <ChevronRight size={17} />
                  </button>
                  {downloads(item)}
                </article>
              ))}
          </div>
        </>
      )}
      {guide && (
        <div className="npi-guide-reader">
          <div className="npi-guide-reader-heading">
            <button className="npi-button secondary" onClick={() => select('')}>
              <ArrowLeft size={16} />
              返回文件目录
            </button>
            <div>
              <h2>{guide.title}</h2>
              <p>
                {guide.edition} 版 · {guide.appliesTo}
              </p>
            </div>
            {downloads(guide)}
          </div>
          <div className="npi-guide-toolbar">
            <button
              className="npi-button secondary"
              disabled={page <= 1}
              onClick={() => select(guide.id, page - 1)}
            >
              <ChevronLeft size={17} />
              上一页
            </button>
            <label>
              <span className="npi-guide-sr-only">选择页码</span>
              <select
                aria-label="选择页码"
                value={page}
                onChange={(e) => select(guide.id, Number(e.target.value))}
              >
                {guide.pages.map((item, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1} / {guide.pages.length} · {item.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="npi-button secondary"
              disabled={page >= guide.pages.length}
              onClick={() => select(guide.id, page + 1)}
            >
              下一页
              <ChevronRight size={17} />
            </button>
            <button
              className="npi-button secondary"
              aria-pressed={zoom}
              onClick={() => setZoom(!zoom)}
            >
              {zoom ? <ZoomOut size={17} /> : <ZoomIn size={17} />}
              {zoom ? '适应屏幕' : '放大查看'}
            </button>
          </div>
          <p className="npi-guide-page-label" aria-live="polite">
            第 {page} / {guide.pages.length} 页 · {guide.pages[page - 1].title}
          </p>
          <div
            className={`npi-guide-canvas ${zoom ? 'zoomed' : ''}`}
            tabIndex={0}
            aria-label="课件页面，可用左右方向键翻页"
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'ArrowRight' && page < guide.pages.length) {
                e.preventDefault()
                select(guide.id, page + 1)
              }
              if (e.key === 'ArrowLeft' && page > 1) {
                e.preventDefault()
                select(guide.id, page - 1)
              }
            }}
          >
            <SlideImage key={`${guide.id}-${page}`} guide={guide} page={page} />
          </div>
          <p className="npi-guide-hint">
            截图较小时可放大查看；放大后滑动查看细节。下载 PDF 可离线阅读。
          </p>
          <details
            className="npi-guide-transcript"
            key={`${guide.id}-${page}-text`}
          >
            <summary>本页操作文字</summary>
            <div>{guide.pages[page - 1].text}</div>
          </details>
        </div>
      )}
    </section>
  )
}

function SlideImage({ guide, page }: { guide: SopGuide; page: number }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  if (failed)
    return (
      <div className="npi-guide-image-error" role="alert">
        本页暂时无法显示，请确认登录状态后重试，也可下载课件查看。
        <button
          className="npi-button secondary"
          onClick={() => {
            setFailed(false)
            setLoaded(false)
            setAttempt((n) => n + 1)
          }}
        >
          重新加载本页
        </button>
      </div>
    )
  return (
    <>
      {!loaded && <p role="status">正在加载第 {page} 页…</p>}
      <img
        src={`${endpoint}/guides/${guide.id}/pages/${page}?v=${encodeURIComponent(guide.edition)}&retry=${attempt}`}
        alt={`${guide.department} SOP 第 ${page} 页：${guide.pages[page - 1].title}`}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  )
}
