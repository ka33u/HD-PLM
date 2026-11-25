import { sql } from 'drizzle-orm'
import type { db } from '../../src/lib/db'

// Legacy fixtures need explicit department membership, just like new accounts.
// Each user gets a separate department so existing access-isolation tests stay valid.
export async function manufacturingTestDepartments(
  run: Pick<typeof db, 'execute'>,
  ids: string[],
) {
  for (const id of ids) {
    const name = '制造验证-' + id
    await run.execute(
      sql`insert into npi_departments(name, role) values (${name}, 'manufacturing') on conflict (name) do nothing`,
    )
    await run.execute(
      sql`update npi_user_roles set department_id=(select id from npi_departments where name=${name}) where user_id=${id} and role='manufacturing' and department_id is null`,
    )
  }
}
