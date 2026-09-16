import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

export async function freshTestDatabase(prefix: string) {
  const configured = process.env.TEST_DATABASE_URL
  if (!configured || !new URL(configured).pathname.endsWith('_test'))
    throw new Error('Explicit _test database required')
  if (!/^[a-z_]+$/.test(prefix)) throw new Error('Invalid test prefix')
  const target = new URL(configured)
  target.pathname = `/${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}_test`
  const base = new URL(configured)
  base.pathname = '/postgres'
  const admin = postgres(base.href, { max: 1 })
  try {
    await admin.unsafe('create database ' + target.pathname.slice(1))
  } finally {
    await admin.end()
  }
  return target.href
}
