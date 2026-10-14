// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react'
import type { NpiMetadata } from '../../lib/npi/service'
export function NpiMotorOrderFields({
  meta,
  motorType = '',
  orderQuantity = '1',
  legacy = false,
}: {
  meta: NpiMetadata
  motorType?: string
  orderQuantity?: string
  legacy?: boolean
}) {
  return (
    <>
      <label>
        电机类型
        <select
          name="motorType"
          aria-label="电机类型"
          required={!legacy}
          defaultValue={motorType}
        >
          <option value="">
            {legacy ? '未分类（保留历史名称）' : '请选择电机类型'}
          </option>
          {meta.motorTypes
            .filter((t) => t.enabled || t.name === motorType)
            .map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
                {t.enabled ? '' : '（已停用）'}
              </option>
            ))}
          {motorType && !meta.motorTypes.some((t) => t.name === motorType) && (
            <option value={motorType}>{motorType}（历史类型）</option>
          )}
        </select>
      </label>
      <label>
        订单台数
        <input
          aria-label="订单台数"
          name="orderQuantity"
          type="number"
          min="1"
          max="999999"
          step="1"
          required={!legacy || !!orderQuantity}
          defaultValue={orderQuantity}
          placeholder="填写订单总台数"
        />
      </label>
    </>
  )
}
export function NpiMotorTypes({
  meta,
  api,
  onChanged,
}: {
  meta: NpiMetadata
  api: <T>(path: string, method?: string, data?: unknown) => Promise<T>
  onChanged: () => Promise<void>
}) {
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  async function save(type?: NpiMetadata['motorTypes'][number]) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(
        '/motor-types',
        'POST',
        type
          ? { ...type, expectedVersion: type.version, enabled: !type.enabled }
          : { name, expectedVersion: 0, enabled: true },
      )
      if (!type) setName('')
      await onChanged()
      setNotice(
        type
          ? '选项状态已更新，历史项目保留原类型。'
          : '电机类型已添加，可在新建项目时选择。',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="npi-panel" aria-label="电机类型管理">
      <div className="npi-panel-title">
        <div>
          <h2>电机类型</h2>
          <p>用于新建项目和项目计划；停用后保留历史记录。</p>
        </div>
      </div>
      <form
        className="npi-motor-type-add"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label>
          新增电机类型
          <input
            value={name}
            maxLength={100}
            required
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：伺服电机"
            disabled={busy}
          />
        </label>
        <button className="npi-button" disabled={busy || !name.trim()}>
          添加类型
        </button>
      </form>
      {error && (
        <p role="alert" className="npi-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="npi-motor-type-list">
        {meta.motorTypes.map((t) => (
          <div key={t.id}>
            <span>
              {t.name} {!t.enabled && <small>已停用</small>}
            </span>
            <button
              className="npi-link"
              disabled={busy}
              onClick={() => void save(t)}
              aria-label={`${t.enabled ? '停用' : '启用'}${t.name}`}
            >
              {t.enabled ? '停用' : '启用'}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
