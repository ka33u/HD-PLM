import { useEffect, useState, type FormEvent } from 'react'
import { request } from '../../lib/auth/context'
import { loginReturnTo } from '../../lib/auth/return-to'
import {
  departmentCategories,
  type DepartmentCategory,
  type RegistrationDepartment,
} from '../../lib/auth/department-categories'

export function Register() {
  const [departments, setDepartments] = useState<RegistrationDepartment[]>([])
  const [category, setCategory] = useState<DepartmentCategory | ''>('')
  const [departmentId, setDepartmentId] = useState('')
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [loadError, setLoadError] = useState('')
  const [showPassword, setShowPassword] = useState(false),
    [submitted, setSubmitted] = useState(false)
  const loginLink =
    '/login?redirect=' + encodeURIComponent(loginReturnTo(location))
  const load = async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await request<{ departments: RegistrationDepartment[] }>(
        '/api/auth/register',
      )
      setDepartments(result.departments)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '部门读取失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (busy) return
    setError('')
    const data = Object.fromEntries(new FormData(e.currentTarget))
    if (data.password !== data.confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await request('/api/auth/register', 'POST', {
        name: data.name,
        email: data.email,
        password: data.password,
        confirmPassword: data.confirmPassword,
        departmentId,
      })
      try {
        sessionStorage.setItem(
          'npi-registered-email',
          String(data.email).trim(),
        )
      } catch {
        /* Optional convenience only. */
      }
      setSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '注册提交失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login-page register-page">
      <div className="login-intro">
        <span className="wordmark">新品协同</span>
        <h1>
          加入项目协作
          <br />
          从选择部门开始。
        </h1>
        <p>设计 · 生产 · 采购</p>
        <div className="login-line" />
        <p>
          填写信息、选择部门，
          <br />
          管理员确认后即可登录。
        </p>
      </div>
      <main className="login-card register-card">
        <p className="eyebrow">NPI WORKSPACE</p>
        <h2>{submitted ? '注册申请已提交' : '注册新账号'}</h2>
        {submitted ? (
          <>
            <p role="status" className="notice">
              等待管理员确认部门并开通账号。开通后，使用刚才填写的邮箱和密码登录，无需重新注册。
            </p>
            <p className="muted">
              可联系本系统管理员在“系统设置 → 账号与部门”查看申请。
            </p>
            <a className="auth-switch" href={loginLink}>
              返回登录
            </a>
          </>
        ) : (
          <>
            <p className="muted">邮箱作为登录账号，部门决定业务岗位。</p>
            {loadError ? (
              <div role="alert">
                <p className="form-error">{loadError}</p>
                <button onClick={() => void load()} disabled={loading}>
                  重新读取部门
                </button>
              </div>
            ) : null}
            {!loading && !loadError && !departments.length && (
              <p role="status" className="notice">
                尚未配置可注册部门，请联系管理员在系统设置中新增部门。
              </p>
            )}
            <form onSubmit={(e) => void submit(e)}>
              <fieldset disabled={busy}>
                <label>
                  姓名
                  <input
                    name="name"
                    autoComplete="name"
                    maxLength={100}
                    required
                    enterKeyHint="next"
                  />
                </label>
                <label>
                  邮箱
                  <input
                    name="email"
                    type="email"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    autoComplete="username"
                    maxLength={254}
                    required
                    enterKeyHint="next"
                  />
                </label>
                <div className="register-departments">
                  <label>
                    部门类别
                    <select
                      aria-label="部门类别"
                      value={category}
                      required
                      disabled={loading || !!loadError}
                      onChange={(e) => {
                        const value = e.target.value as DepartmentCategory | ''
                        setCategory(value)
                        const available = departments.filter(
                          (d) => d.role === value,
                        )
                        setDepartmentId(
                          available.length === 1 ? available[0]!.id : '',
                        )
                      }}
                    >
                      <option value="">
                        {loading ? '读取中…' : '请选择类别'}
                      </option>
                      {Object.entries(departmentCategories).map(
                        ([value, label]) => (
                          <option
                            key={value}
                            value={value}
                            disabled={
                              !departments.some((d) => d.role === value)
                            }
                          >
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    所属部门
                    <select
                      aria-label="所属部门"
                      value={departmentId}
                      required
                      disabled={!category || loading || !!loadError}
                      onChange={(e) => setDepartmentId(e.target.value)}
                    >
                      <option value="">请选择部门</option>
                      {departments
                        .filter((d) => d.role === category)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <label>
                  设置密码
                  <input
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                    enterKeyHint="next"
                    aria-describedby="registration-password-hint"
                  />
                </label>
                <label>
                  确认密码
                  <input
                    name="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    required
                    enterKeyHint="done"
                  />
                </label>
                <div className="login-options">
                  <span id="registration-password-hint" className="muted small">
                    10至128个字符
                  </span>
                  <label className="setup-show-password">
                    <input
                      type="checkbox"
                      checked={showPassword}
                      onChange={(e) => setShowPassword(e.target.checked)}
                    />
                    显示密码
                  </label>
                </div>
                {error && (
                  <p role="alert" className="form-error">
                    {error}
                  </p>
                )}
                <button
                  className="primary"
                  disabled={loading || !!loadError || !departmentId}
                  type="submit"
                >
                  {busy ? '正在提交…' : '提交注册申请'}
                </button>
              </fieldset>
            </form>
            <p className="muted small">
              管理员确认后开通。管理员、主管岗位由管理员指定。
            </p>
            <a className="auth-switch" href={loginLink}>
              已有账号？返回登录
            </a>
          </>
        )}
      </main>
    </div>
  )
}
