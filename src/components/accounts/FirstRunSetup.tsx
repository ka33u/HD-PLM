import { useState } from 'react'
import type { FormEvent } from 'react'
import { request, useAccount } from '../../lib/auth/context'

export function FirstRunSetup() {
  const { setup, reload } = useAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError('')
    if (form.get('password') !== form.get('confirmPassword')) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await request('/api/auth/setup', 'POST', {
        name: form.get('name'),
        email: form.get('email'),
        password: form.get('password'),
        confirmPassword: form.get('confirmPassword'),
        setupToken: form.get('setupToken'),
      })
      location.assign('/npi')
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败，请刷新状态后重试')
      setBusy(false)
    }
  }
  return (
    <div className="login-page setup-page">
      <aside className="login-intro">
        <span className="wordmark">新品协同</span>
        <h1>
          从这里开始，
          <br />
          建立你的协同空间。
        </h1>
        <p>HD-PLM · 新品开发管理</p>
        <div className="login-line" />
        <ol className="setup-steps">
          <li>
            <strong>创建管理员</strong>
            <span>设置你的登录账号与密码</span>
          </li>
          <li>
            <strong>邀请团队</strong>
            <span>在系统设置中开通成员账号、分配岗位</span>
          </li>
          <li>
            <strong>开始协作</strong>
            <span>新建项目，导入 BOM，跟踪制造与采购</span>
          </li>
        </ol>
      </aside>
      <main className="login-card setup-card">
        <p className="eyebrow">首次使用 · 账号设置</p>
        <h2>创建管理员账号</h2>
        <p className="muted">设置首位管理员，完成后即可进入工作空间。</p>
        {setup?.access === 'unavailable' ? (
          <>
            <p className="notice" role="status">
              请在服务器本机完成首次设置，或联系部署人员配置初始化密钥后刷新此页。
            </p>
            <button type="button" onClick={() => void reload()}>
              刷新初始化状态
            </button>
          </>
        ) : (
          <>
            <form onSubmit={(event) => void submit(event)}>
              <fieldset disabled={busy}>
                <label>
                  管理员姓名
                  <input
                    name="name"
                    autoComplete="name"
                    maxLength={100}
                    required
                  />
                </label>
                <label>
                  登录邮箱
                  <input
                    name="email"
                    type="email"
                    autoComplete="username"
                    maxLength={254}
                    required
                  />
                </label>
                <label>
                  设置密码
                  <input
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={128}
                    aria-describedby="setup-password-help"
                    required
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
                  />
                </label>
                <label className="setup-show-password">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(event) => setShowPassword(event.target.checked)}
                  />
                  显示密码
                </label>
                <p id="setup-password-help" className="muted small">
                  使用 10 至 128 个字符，建议组合字母、数字和符号。
                </p>
                {setup?.access === 'token' && (
                  <label>
                    初始化密钥
                    <input
                      name="setupToken"
                      type="password"
                      autoComplete="off"
                      maxLength={256}
                      required
                    />
                    <span className="muted small">
                      由部署人员提供，仅首次创建管理员时使用。
                    </span>
                  </label>
                )}
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <button className="primary" type="submit">
                  {busy ? '正在创建管理员…' : '创建管理员并进入系统'}
                </button>
              </fieldset>
            </form>
            {error && (
              <button type="button" onClick={() => void reload()}>
                刷新初始化状态
              </button>
            )}
            <p className="muted small">
              本入口仅在没有账号时开放。团队成员的账号由管理员统一开通。
            </p>
          </>
        )}
      </main>
    </div>
  )
}
