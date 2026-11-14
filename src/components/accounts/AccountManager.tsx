import { useEffect, useMemo, useState } from 'react'
import { request, useAccount } from '../../lib/auth/context'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/Dialog'
import {
  departmentCategories,
  type RegistrationDepartment,
} from '../../lib/auth/department-categories'
import type { FormEvent } from 'react'
type Account = {
  id: string
  name: string
  email: string
  role: string
  active: boolean
  version: number
  mustChangePassword: boolean
  lockedUntil: string | null
  departmentName: string | null
  registrationStatus: 'pending' | 'approved' | 'rejected' | null
  requestedDepartmentId: string | null
  requestedDepartmentName: string | null
}
type Audit = {
  id: string
  actorId: string | null
  targetId: string | null
  action: string
  detail: Record<string, unknown>
  createdAt: string
}
const roles: Record<string, string> = {
  technical: '技术负责人',
  manufacturing: '制造负责人',
  procurement: '采购责任人',
  quality: '质量人员',
  supervisor: '主管',
  admin: '管理员',
}
const actions: Record<string, string> = {
  REGISTRATION_SUBMITTED: '提交注册',
  REGISTRATION_APPROVED: '开通注册账号',
  REGISTRATION_REJECTED: '驳回注册申请',
  ACCOUNT_CREATED: '创建账号',
  ACCOUNT_UPDATED: '调整账号',
  PASSWORD_RESET: '重置密码',
  PASSWORD_CHANGED: '本人修改密码',
  LOGIN_SUCCEEDED: '登录成功',
  LOGIN_FAILED: '登录失败',
  LOGIN_LOCKED: '登录锁定',
  ADMIN_INITIALIZED: '初始化管理员',
}
export function AccountManager({
  embedded = false,
  revision = 0,
  onChanged,
}: {
  embedded?: boolean
  revision?: number
  onChanged?: () => void | Promise<void>
}) {
  const Content = embedded ? 'section' : 'main'
  const { user } = useAccount(),
    [accounts, setAccounts] = useState<Account[]>([]),
    [events, setEvents] = useState<Audit[]>([])
  const [departments, setDepartments] = useState<RegistrationDepartment[]>([])
  const [filter, setFilter] = useState('all')
  const [decision, setDecision] = useState('approve')
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<{
    kind: 'create' | 'edit' | 'password' | 'review'
    account?: Account
  } | null>(null)
  const refresh = async () => {
    setLoading(true)
    try {
      const [a, e, d] = await Promise.all([
        request<{ accounts: Account[] }>('/api/accounts'),
        request<{ events: Audit[] }>('/api/accounts/history'),
        request<{ departments: RegistrationDepartment[] }>(
          '/api/auth/register',
        ),
      ])
      setAccounts(a.accounts)
      setEvents(e.events)
      setDepartments(d.departments)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (user?.role === 'admin') void refresh().catch((e) => setError(e.message))
  }, [user?.id, revision])
  const people = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (filter === 'all' || a.registrationStatus === filter) &&
          (
            a.name +
            ' ' +
            a.email +
            ' ' +
            roles[a.role] +
            ' ' +
            (a.departmentName || a.requestedDepartmentName || '')
          )
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [accounts, query, filter],
  )
  if (user?.role !== 'admin')
    return (
      <Content className="loading-page">
        <h1>无权管理账号</h1>
        <a href="/npi">返回工作空间</a>
      </Content>
    )
  const open = (
    kind: 'create' | 'edit' | 'password' | 'review',
    account?: Account,
  ) => {
    setError('')
    setNotice('')
    setDecision('approve')
    setModal({ kind, account })
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!modal || busy) return
    const data = Object.fromEntries(new FormData(e.currentTarget)),
      a = modal.account
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (modal.kind === 'review')
        await request(
          `/api/accounts/${a!.id}/registration`,
          'POST',
          { ...data, expectedVersion: a!.version },
          user.id,
        )
      else if (modal.kind === 'create')
        await request('/api/accounts', 'POST', data, user.id)
      else if (modal.kind === 'password')
        await request(
          `/api/accounts/${a!.id}/password`,
          'POST',
          { ...data, expectedVersion: a!.version },
          user.id,
        )
      else
        await request(
          `/api/accounts/${a!.id}`,
          'PATCH',
          {
            ...data,
            active: data.active === 'true',
            expectedVersion: a!.version,
          },
          user.id,
        )
      const resettingSelf = modal.kind === 'password' && a?.id === user.id
      setNotice(
        modal.kind === 'review'
          ? decision === 'approve'
            ? '账号已开通，用户可以使用注册时设置的密码登录。'
            : '申请已驳回，账号未开通。可在已驳回列表中重新审核。'
          : '已保存。账号停用、改岗和密码重置会使原登录失效。',
      )
      if (resettingSelf) {
        setModal(null)
        location.assign('/login')
        return
      }
      try {
        await onChanged?.()
        await refresh()
      } catch {
        setError('保存已成功，列表刷新失败，请点击刷新；不要重复提交。')
      }
      setModal(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={embedded ? 'account-embedded' : 'account-layout'}>
      {!embedded && (
        <header>
          <a href="/npi">← 新品协同</a>
          <a href="/account">我的账号</a>
        </header>
      )}
      <Content>
        <div className="account-heading">
          <div>
            {!embedded && <p className="eyebrow">系统设置</p>}
            {embedded ? <h2>账号管理</h2> : <h1>账号管理</h1>}
            <p className="muted">统一管理账号、业务岗位和登录权限。</p>
          </div>
          <button className="primary" onClick={() => open('create')}>
            新增账号
          </button>
        </div>
        {!modal && error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {accounts.some((a) => a.registrationStatus === 'pending') && (
          <div className="notice account-registration-notice" role="status">
            <span>
              {
                accounts.filter((a) => a.registrationStatus === 'pending')
                  .length
              }{' '}
              个新用户等待确认部门
            </span>
            <button
              onClick={() => {
                setFilter('pending')
                setQuery('')
              }}
            >
              查看待审核注册
            </button>
          </div>
        )}
        <section className="account-card" aria-label="账号列表">
          <div className="account-toolbar">
            <label>
              查找账号
              <input
                type="search"
                placeholder="姓名、邮箱、岗位或部门"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <label>
              账号范围
              <select
                aria-label="账号范围"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部账号</option>
                <option value="pending">待审核注册</option>
                <option value="rejected">已驳回注册</option>
              </select>
            </label>
            <button
              disabled={loading}
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              刷新账号
            </button>
          </div>
          <p className="muted small">
            {loading ? '正在读取…' : `共 ${people.length} 个账号`} ·
            管理员创建及密码重置后须本人改密；自行注册使用本人设置的密码。
          </p>
          <div className="account-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>姓名 / 邮箱</th>
                  <th>岗位 / 部门</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {people.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <small>{a.email}</small>
                    </td>
                    <td>
                      {roles[a.role] || '未分配'}
                      <small>
                        {a.departmentName ||
                          (a.requestedDepartmentName
                            ? '申请：' + a.requestedDepartmentName
                            : '未分组')}
                      </small>
                    </td>
                    <td>
                      {a.registrationStatus === 'pending'
                        ? '待审核注册'
                        : a.registrationStatus === 'rejected'
                          ? '注册已驳回'
                          : !a.active
                            ? '已停用'
                            : a.lockedUntil &&
                                new Date(a.lockedUntil) > new Date()
                              ? '暂时锁定'
                              : a.mustChangePassword
                                ? '待修改初始密码'
                                : '已启用'}
                    </td>
                    <td>
                      <div className="account-actions">
                        {a.registrationStatus === 'pending' ||
                        a.registrationStatus === 'rejected' ? (
                          <button onClick={() => open('review', a)}>
                            {a.registrationStatus === 'pending'
                              ? '审核注册'
                              : '重新审核'}
                          </button>
                        ) : (
                          <>
                            <button onClick={() => open('edit', a)}>
                              编辑账号
                            </button>
                            <button onClick={() => open('password', a)}>
                              重置密码
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !people.length && <p>没有匹配的账号。</p>}
        </section>
        <details className="account-card">
          <summary>最近的账号与登录记录（{events.length} 条）</summary>
          <div className="account-audit">
            {events.map((event) => (
              <article key={event.id}>
                <strong>{actions[event.action] || event.action}</strong>
                <span>
                  {accounts.find((a) => a.id === event.targetId)?.name ||
                    '系统'}
                </span>
                <small>
                  {new Date(event.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}{' '}
                  · 操作人：
                  {accounts.find((a) => a.id === event.actorId)?.name ||
                    '登录服务'}
                </small>
                {typeof event.detail.reason === 'string' && (
                  <p>{event.detail.reason}</p>
                )}
              </article>
            ))}
          </div>
        </details>
      </Content>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !busy) setModal(null)
        }}
      >
        <DialogContent
          className="account-dialog"
          onInteractOutside={(e) => {
            if (busy) e.preventDefault()
          }}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault()
          }}
        >
          <DialogTitle>
            {modal?.kind === 'review'
              ? `审核注册 · ${modal.account?.name}`
              : modal?.kind === 'create'
                ? '新增账号'
                : modal?.kind === 'password'
                  ? `重置密码 · ${modal.account?.name}`
                  : `编辑账号 · ${modal?.account?.name}`}
          </DialogTitle>
          <DialogDescription>
            {modal?.kind === 'review'
              ? '核对人员和所属部门后开通。生产、采购成员会加入该部门的任务协作范围。'
              : modal?.kind === 'password'
                ? '设置临时密码后，所有已登录设备会退出；用户下次登录须修改密码。'
                : '每个账号对应一个业务岗位。停用或改岗前，请先核对并交接未完成任务。'}
          </DialogDescription>
          <form
            key={modal?.kind + '-' + modal?.account?.id}
            onSubmit={(e) => void submit(e)}
          >
            <fieldset disabled={busy}>
              {modal?.kind !== 'password' && modal?.kind !== 'review' && (
                <>
                  <label>
                    姓名
                    <input
                      name="name"
                      defaultValue={modal?.account?.name}
                      maxLength={100}
                      required
                    />
                  </label>
                  <label>
                    邮箱
                    <input
                      name="email"
                      type="email"
                      autoComplete="off"
                      defaultValue={modal?.account?.email}
                      maxLength={254}
                      required
                    />
                  </label>
                  <label>
                    业务岗位
                    <select
                      name="role"
                      aria-label="业务岗位"
                      defaultValue={modal?.account?.role || 'technical'}
                    >
                      {Object.entries(roles).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {modal?.kind !== 'edit' && modal?.kind !== 'review' && (
                <label>
                  临时密码
                  <input
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                  />
                </label>
              )}
              {modal?.kind === 'edit' && (
                <label>
                  账号状态
                  <select
                    name="active"
                    aria-label="账号状态"
                    defaultValue={String(modal.account?.active)}
                  >
                    <option value="true">启用</option>
                    <option value="false">停用</option>
                  </select>
                </label>
              )}
              {modal?.kind === 'review' && (
                <>
                  <p>
                    <strong>{modal.account?.name}</strong>
                    <br />
                    {modal.account?.email}
                    <br />
                    <span className="muted">
                      申请部门：{modal.account?.requestedDepartmentName}
                    </span>
                  </p>
                  <label>
                    审核结果
                    <select
                      name="decision"
                      aria-label="审核结果"
                      value={decision}
                      onChange={(e) => setDecision(e.target.value)}
                    >
                      <option value="approve">确认部门并开通</option>
                      <option value="reject">驳回申请</option>
                    </select>
                  </label>
                  {decision === 'approve' && (
                    <label>
                      开通部门
                      <select
                        name="departmentId"
                        aria-label="开通部门"
                        defaultValue={
                          modal.account?.requestedDepartmentId || ''
                        }
                        required
                      >
                        <option value="">请选择部门</option>
                        {Object.entries(departmentCategories).map(
                          ([category, label]) => (
                            <optgroup key={category} label={label}>
                              {departments
                                .filter((d) => d.role === category)
                                .map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name}
                                  </option>
                                ))}
                            </optgroup>
                          ),
                        )}
                      </select>
                    </label>
                  )}
                  <label>
                    审核说明{decision === 'approve' ? '（可选）' : ''}
                    <textarea
                      name="reason"
                      maxLength={2000}
                      required={decision === 'reject'}
                      rows={3}
                      placeholder={
                        decision === 'reject'
                          ? '说明需要核对的信息，便于后续重新审核'
                          : '如调整部门，请注明原因'
                      }
                    />
                  </label>
                </>
              )}
              {modal?.kind !== 'create' && modal?.kind !== 'review' && (
                <label>
                  调整原因
                  <textarea name="reason" maxLength={2000} required rows={3} />
                </label>
              )}
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              <div className="account-actions">
                <button type="submit" className="primary">
                  {busy
                    ? '正在保存…'
                    : modal?.kind === 'review'
                      ? decision === 'approve'
                        ? '确认开通'
                        : '驳回申请'
                      : '保存'}
                </button>
                <button type="button" onClick={() => setModal(null)}>
                  取消
                </button>
              </div>
            </fieldset>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
