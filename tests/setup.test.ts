import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { freshTestDatabase } from './helpers/fresh-database'

process.env.DATABASE_URL = await freshTestDatabase('hd_setup')
process.env.BASE_URL = 'http://localhost:3495'
delete process.env.SETUP_TOKEN
const setupCli = () =>
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/setup.ts'], {
    env: {
      ...process.env,
      ADMIN_EMAIL: 'unused@test.invalid',
      ADMIN_PASSWORD: 'unused-admin-password',
    },
    encoding: 'utf8',
  })
setupCli()
const { db, client, closeDatabase } = await import('../src/lib/db')
const { users, sessions, accountEvents } =
  await import('../src/lib/db/schema/users')
const { npiUserRoles } = await import('../src/lib/db/schema/npi')
const { checkPassword } = await import('../src/lib/auth/accounts')
const { tokenHash } = await import('../src/lib/auth/session')
const { app } = await import('../src/server/app')
const password = 'Personal-' + crypto.randomUUID()
const input = {
  name: '首次管理员',
  email: 'FIRST@setup.test.invalid',
  password,
  confirmPassword: password,
}
async function call(
  path = '/api/auth/setup',
  method = 'GET',
  body?: unknown,
  address = '127.0.0.1',
  headers: Record<string, string> = {},
) {
  const base = process.env.BASE_URL!
  const response = await app.request(
    base + path,
    {
      method,
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      incoming: {
        socket: {
          remoteAddress: address,
          remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4',
        },
      },
    },
  )
  return { response, data: await response.json() }
}
let userId = '',
  token = ''
try {
  await test('Fresh setup prepares schema/templates without creating a predefined account; anonymous status advertises first-run', async () => {
    assert.equal((await db.select().from(users)).length, 0)
    assert.equal(
      (await client`select count(*)::int as n from npi_import_templates`)[0].n,
      1,
    )
    assert.deepEqual((await call()).data, { required: true, access: 'local' })
    const me = await call('/api/auth/me')
    assert.equal(me.response.status, 401)
    assert.deepEqual(me.data.setup, { required: true, access: 'local' })
  })
  await test('Cross-origin, unknown sockets and remote spoofing cannot claim the initial administrator', async () => {
    assert.equal(
      (
        await call(undefined, 'POST', input, '127.0.0.1', {
          origin: 'https://attacker.invalid',
        })
      ).response.status,
      403,
    )
    assert.equal(
      (await call(undefined, 'POST', input, '')).response.status,
      403,
    )
    assert.equal(
      (
        await call(undefined, 'POST', input, '10.2.3.4', {
          'x-forwarded-for': '127.0.0.1',
        })
      ).response.status,
      403,
    )
    process.env.BASE_URL = 'https://plm.example.invalid'
    try {
      assert.equal(
        (await call(undefined, 'POST', input, '127.0.0.1')).response.status,
        403,
      )
    } finally {
      process.env.BASE_URL = 'http://localhost:3495'
    }
    assert.equal((await db.select().from(users)).length, 0)
  })
  await test('Validation rejects malformed, missing, weak and mismatched fields without creating users', async () => {
    for (const body of [
      [],
      {},
      { ...input, name: ' ' },
      { ...input, email: 'bad' },
      { ...input, password: 'short' },
      { ...input, confirmPassword: password + 'x' },
    ]) {
      assert.equal((await call(undefined, 'POST', body)).response.status, 422)
    }
    assert.equal((await db.select().from(users)).length, 0)
  })
  await test('Remote setup requires a configured secret, never exposes it and limits repeated guesses', async () => {
    const secret = crypto.randomUUID() + crypto.randomUUID()
    process.env.SETUP_TOKEN = secret
    try {
      const state = await call(undefined, 'GET', undefined, '10.2.3.5')
      assert.deepEqual(state.data, { required: true, access: 'token' })
      assert.ok(!JSON.stringify(state.data).includes(secret))
      for (let i = 0; i < 20; i++)
        assert.equal(
          (
            await call(
              undefined,
              'POST',
              { ...input, setupToken: 'incorrect' },
              '10.2.3.5',
            )
          ).response.status,
          403,
        )
      assert.equal(
        (
          await call(
            undefined,
            'POST',
            { ...input, setupToken: secret },
            '10.2.3.5',
          )
        ).response.status,
        429,
      )
      process.env.SETUP_TOKEN = 'short'
      assert.equal(
        (
          await call(
            undefined,
            'POST',
            { ...input, setupToken: 'short' },
            '10.2.3.6',
          )
        ).response.status,
        403,
      )
    } finally {
      delete process.env.SETUP_TOKEN
    }
    assert.equal((await db.select().from(users)).length, 0)
  })
  await test('Audit failure rolls back account, role and session together', async () => {
    await client.unsafe(
      "create function reject_setup_test() returns trigger language plpgsql as $$ begin if NEW.action = 'ADMIN_INITIALIZED' then raise exception 'forced setup audit failure'; end if; return NEW; end $$",
    )
    await client.unsafe(
      'create trigger reject_setup_test before insert on account_events for each row execute function reject_setup_test()',
    )
    try {
      assert.equal((await call(undefined, 'POST', input)).response.status, 500)
    } finally {
      await client.unsafe('drop trigger reject_setup_test on account_events')
      await client.unsafe('drop function reject_setup_test()')
    }
    assert.equal((await db.select().from(users)).length, 0)
    assert.equal((await db.select().from(npiUserRoles)).length, 0)
    assert.equal((await db.select().from(sessions)).length, 0)
  })
  await test('Concurrent initializations create exactly one admin, one audit event and one authenticated session', async () => {
    const secret = crypto.randomUUID() + crypto.randomUUID()
    process.env.SETUP_TOKEN = secret
    let results
    try {
      results = await Promise.all(
        ['first', 'second'].map((prefix) =>
          call(
            undefined,
            'POST',
            {
              ...input,
              email: prefix.toUpperCase() + '@setup.test.invalid',
              setupToken: secret,
            },
            '10.2.3.7',
          ),
        ),
      )
    } finally {
      delete process.env.SETUP_TOKEN
    }
    assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 409])
    const winner = results.find((r) => r.response.status === 201)!
    assert.equal(winner.data.user.role, 'admin')
    assert.equal(winner.data.user.mustChangePassword, false)
    assert.doesNotMatch(
      JSON.stringify(winner.data),
      /passwordHash|sessionToken|setupToken/,
    )
    token = /session=([a-f0-9]{64})/.exec(
      winner.response.headers.get('set-cookie') || '',
    )![1]!
    assert.match(winner.response.headers.get('set-cookie')!, /HttpOnly/i)
    assert.match(winner.response.headers.get('set-cookie')!, /SameSite=Strict/i)
    const all = await db.select().from(users)
    assert.equal(all.length, 1)
    userId = all[0]!.id
    assert.equal(all[0]!.email, all[0]!.email.toLowerCase())
    assert.ok(await checkPassword(all[0]!.passwordHash, password))
    assert.equal((await db.select().from(npiUserRoles))[0]!.role, 'admin')
    const audit = await db.select().from(accountEvents)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]!.action, 'ADMIN_INITIALIZED')
    assert.ok(!JSON.stringify(audit).includes(password))
    const stored = await db.select().from(sessions)
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.id, tokenHash(token))
    assert.equal(
      (
        await call('/api/accounts', 'GET', undefined, '127.0.0.1', {
          cookie: 'session=' + token,
        })
      ).response.status,
      200,
    )
  })
  await test('Existing accounts permanently close setup, even if disabled; rerunning CLI cannot change them', async () => {
    assert.deepEqual((await call()).data, { required: false, access: null })
    assert.equal((await call(undefined, 'POST', input)).response.status, 409)
    await db.update(users).set({ active: false }).where(eq(users.id, userId))
    assert.deepEqual((await call()).data, { required: false, access: null })
    assert.equal((await call(undefined, 'POST', input)).response.status, 409)
    const before = await db.select().from(users)
    setupCli()
    assert.deepEqual(await db.select().from(users), before)
  })
} finally {
  await closeDatabase()
}
