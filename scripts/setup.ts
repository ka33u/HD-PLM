import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, closeDatabase } from '../src/lib/db'
import { needsSetup } from '../src/lib/auth/setup'
import { seedNpiConfig } from '../src/lib/npi/service'
try {
  await migrate(db, { migrationsFolder: './migrations' })
  await seedNpiConfig()
  console.log(
    (await needsSetup())
      ? '数据库已就绪。启动系统后，请在首次访问页面创建管理员账号。'
      : '数据库已就绪，保留已有账号、密码和岗位。',
  )
} finally {
  await closeDatabase()
}
