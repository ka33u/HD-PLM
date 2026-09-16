import { Hono } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { deleteCookie, setCookie } from 'hono/cookie'
import { validateRequestSession, requestToken } from '../../lib/auth/server'
import { invalidateSession, SESSION_SECONDS } from '../../lib/auth/session'
import { login } from '../../lib/auth/login'
import { changePassword } from '../../lib/auth/accounts'
import { getActor } from '../../lib/npi/service'
import { NpiError } from '../../lib/npi/domain'
import { initializeAdministrator, setupStatus } from '../../lib/auth/setup'

const app = new Hono()
function remoteAddress(c: Parameters<typeof getConnInfo>[0]) {
  try {
    return getConnInfo(c).remote.address || ''
  } catch {
    return ''
  }
}
export function sessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
) {
  setCookie(c, 'session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: process.env.BASE_URL?.startsWith('https://') || false,
    maxAge: SESSION_SECONDS,
  })
}
app.get('/setup', async (c) => c.json(await setupStatus(remoteAddress(c))))
app.post('/setup', async (c) => {
  const result = await initializeAdministrator(
    await c.req.json(),
    remoteAddress(c),
  )
  sessionCookie(c, result.sessionToken)
  return c.json({ user: result.user }, 201)
})
app.post('/login', async (c) => {
  const result = await login(await c.req.json(), remoteAddress(c) || 'local')
  sessionCookie(c, result.sessionToken)
  return c.json({ user: result.user })
})
app.get('/me', async (c) => {
  const session = await validateRequestSession(c.req.raw)
  if (!session)
    return c.json(
      {
        error: '请先登录',
        code: 'AUTH_REQUIRED',
        setup: await setupStatus(remoteAddress(c)),
      },
      401,
    )
  const actor = await getActor(session.user.id)
  if (session.renewed) sessionCookie(c, requestToken(c.req.raw))
  return c.json({
    user: {
      id: actor.id,
      name: actor.name,
      email: session.user.email,
      role: actor.role,
      mustChangePassword: session.user.mustChangePassword,
    },
  })
})
app.post('/logout', async (c) => {
  await invalidateSession(requestToken(c.req.raw))
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})
app.post('/password', async (c) => {
  const session = await validateRequestSession(c.req.raw)
  if (!session) throw new NpiError('AUTH_REQUIRED', '请先登录', 401)
  if (c.req.header('x-npi-actor') !== session.user.id)
    throw new NpiError(
      'ACTOR_CONTEXT_CHANGED',
      '登录账号已改变，请刷新后操作',
      409,
    )
  return c.json(
    await changePassword(
      session.user.id,
      session.session.id,
      await c.req.json(),
    ),
  )
})
export default app
