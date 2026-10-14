// SPDX-License-Identifier: AGPL-3.0-or-later
import { NpiMotorOrderFields } from './NpiMotorTypes'
import { useEffect, useState } from 'react'
import { profileFields } from '../../lib/npi/project-profile'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import type { FormEvent } from 'react'
import type { NpiMetadata, ProjectDetail } from '../../lib/npi/service'
import type { NpiProjectChangePreview } from '../../lib/npi/project-change-service'

type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>
export function NpiProjectChange({
  api,
  meta,
  project,
  onChanged,
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  api: Api
  meta: NpiMetadata
  project: ProjectDetail
  onChanged: (canContinue: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [preview, setPreview] = useState<NpiProjectChangePreview | null>(null)
  const [proposal, setProposal] = useState<Record<string, unknown>>({})
  useEffect(() => {
    if (!open) return
    setError('')
    setPreview(null)
    setProposal({})
  }, [open])
  const review = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const data = {
      ...Object.fromEntries(new FormData(e.currentTarget)),
      expectedVersion: project.version,
    }
    try {
      setProposal(data)
      setPreview(
        await api<NpiProjectChangePreview>(
          `/projects/${project.id}/change-preview`,
          'POST',
          data,
        ),
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '预览失败')
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ canContinue: boolean }>(
        `/projects/${project.id}/plan`,
        'PATCH',
        { ...proposal, expectedSnapshot: preview.expectedSnapshot },
      )
      onOpenChange(false)
      await onChanged(result.canContinue)
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : '提交失败，请刷新核对',
      )
    } finally {
      setBusy(false)
    }
  }
  const fieldValue = (key: string, fallback: string) =>
    typeof proposal[key] === 'string' ? proposal[key] : fallback
  return (
    <>
      <button
        className="npi-button secondary"
        onClick={() => onOpenChange(true)}
      >
        编辑项目信息
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) onOpenChange(value)
        }}
      >
        <DialogContent className="npi-modal npi-project-edit-modal">
          <DialogTitle>
            {preview ? '确认项目变更范围' : '编辑项目信息'}
          </DialogTitle>
          <DialogDescription>
            修改基本资料、计划日期或负责人，预览后保存。电机编码同步用于整机完成任务，历史承诺与实际完成记录保留。
          </DialogDescription>
          {error && (
            <div className="npi-error" role="alert">
              {error}
            </div>
          )}
          {!preview ? (
            <form onSubmit={(e) => void review(e)}>
              <div className="npi-form-grid">
                <label>
                  项目编号 / 订单编号
                  <input
                    name="code"
                    defaultValue={fieldValue('code', project.code)}
                    maxLength={50}
                    required
                  />
                </label>
                <NpiMotorOrderFields
                  meta={meta}
                  motorType={fieldValue('motorType', project.profile.motorType)}
                  orderQuantity={fieldValue(
                    'orderQuantity',
                    project.profile.orderQuantity,
                  )}
                  legacy={!project.profile.motorType}
                />
                <label>
                  电机型号
                  <input
                    name="motorModel"
                    defaultValue={fieldValue('motorModel', project.motorModel)}
                    required
                    maxLength={150}
                  />
                </label>
                {profileFields.map((field) => (
                  <label
                    key={field.key}
                    className={field.kind === 'textarea' ? 'wide' : ''}
                  >
                    {field.label}
                    {field.kind === 'textarea' ? (
                      <textarea
                        name={field.key}
                        aria-label={field.label}
                        defaultValue={fieldValue(
                          field.key,
                          project.profile[field.key],
                        )}
                        maxLength={field.max}
                        rows={2}
                      />
                    ) : (
                      <input
                        name={field.key}
                        aria-label={field.label}
                        defaultValue={fieldValue(
                          field.key,
                          project.profile[field.key],
                        )}
                        maxLength={field.max}
                        inputMode={
                          field.kind === 'decimal'
                            ? 'decimal'
                            : field.kind === 'integer'
                              ? 'numeric'
                              : 'text'
                        }
                      />
                    )}
                  </label>
                ))}
                <details className="wide">
                  <summary>计划日期与负责人</summary>
                  <div className="npi-form-grid">
                    <label>
                      要求齐套日期
                      <input
                        name="requiredKitDate"
                        type="date"
                        defaultValue={fieldValue(
                          'requiredKitDate',
                          project.requiredKitDate,
                        )}
                        required
                      />
                    </label>
                    <label>
                      样机要求日期
                      <input
                        name="prototypeRequiredDate"
                        type="date"
                        defaultValue={fieldValue(
                          'prototypeRequiredDate',
                          project.prototypeRequiredDate,
                        )}
                        required
                      />
                    </label>
                    {(['technical', 'manufacturing'] as const).map((role) => {
                      const key = `${role}OwnerId` as const
                      const selected = fieldValue(key, project[key])
                      const options = meta.users.filter(
                        (u) => u.role === role || u.id === selected,
                      )
                      return (
                        <label key={role}>
                          {role === 'technical' ? '技术负责人' : '制造负责人'}
                          <select
                            name={key}
                            aria-label={
                              role === 'technical' ? '技术负责人' : '制造负责人'
                            }
                            defaultValue={selected}
                            required
                          >
                            {!options.some((u) => u.id === selected) && (
                              <option value={selected}>
                                原负责人已停用，请选择接任者
                              </option>
                            )}
                            {options.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name || u.email} · {u.email}
                              </option>
                            ))}
                          </select>
                        </label>
                      )
                    })}
                  </div>
                </details>
                <label className="wide">
                  变更原因
                  <textarea
                    name="reason"
                    rows={2}
                    defaultValue={fieldValue('reason', '')}
                    required
                    maxLength={2000}
                  />
                </label>
              </div>
              <p>
                原技术/制造负责人名下的未完成非采购物料和未关闭问题随职责转交；采购件仍按采购责任人管理。整机任务由新制造负责人办理，单独调整或已完成的要求日期保留。
              </p>
              <div className="npi-actions">
                <button
                  type="button"
                  className="npi-button secondary"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  取消
                </button>
                <button type="submit" className="npi-button" disabled={busy}>
                  {busy ? '正在预览…' : '预览变更'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <section aria-label="项目变更预览">
                {preview.changes.map((c) => (
                  <p key={c.key}>
                    <strong>{c.label}</strong>：{c.before} → {c.after}
                  </p>
                ))}
                {!preview.changes.length &&
                  !preview.tracking.length &&
                  !preview.issues.length && <p>没有需要修改的内容。</p>}
                <h3>整机与零部件 · {preview.tracking.length} 项</h3>
                {preview.tracking.map((t) => (
                  <p key={t.id}>
                    <strong>{t.name}</strong>
                    <br />
                    {t.ownerBefore !== t.ownerAfter && (
                      <>
                        责任人：{t.ownerBefore} → {t.ownerAfter}
                        <br />
                      </>
                    )}
                    {t.qtyBefore !== t.qtyAfter && (
                      <>
                        订单台数：{t.qtyBefore} → {t.qtyAfter}
                        <br />
                      </>
                    )}
                    {t.specificationBefore !== t.specificationAfter && (
                      <>
                        电机型号：{t.specificationBefore || '未填写'} →{' '}
                        {t.specificationAfter}
                        <br />
                      </>
                    )}
                    {t.requiredBefore !== t.requiredAfter && (
                      <>
                        要求日期：{t.requiredBefore} → {t.requiredAfter}
                      </>
                    )}
                  </p>
                ))}
                <h3>未关闭问题 · {preview.issues.length} 项</h3>
                {preview.issues.map((i) => (
                  <p key={i.id}>
                    {i.name}：{i.ownerBefore} → {i.ownerAfter}
                  </p>
                ))}
                {!!preview.retainedDates.length && (
                  <p>
                    保留要求日期：
                    {preview.retainedDates
                      .map((t) => `${t.name}（${t.requiredDate}）`)
                      .join('、')}
                    。
                  </p>
                )}
                <p>
                  交接后，相关任务由新负责人办理，已有承诺和完成记录保留原操作人。
                </p>
                {!preview.canContinue && (
                  <p>交接后你将不再担任本项目负责人，保存后返回新品列表。</p>
                )}
              </section>
              <div className="npi-actions">
                <button
                  className="npi-button secondary"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null)
                    setError('')
                  }}
                >
                  返回修改
                </button>
                <button
                  className="npi-button"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  {busy ? '正在保存…' : '确认变更'}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
