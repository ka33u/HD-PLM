import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'
import { npiDepartments } from './npi'

// Pending requests have an inactive user and no collaboration membership.
// Administrative accounts do not need a registration row.
export const accountRegistrations = pgTable('account_registrations', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  departmentId: uuid('department_id')
    .notNull()
    .references(() => npiDepartments.id),
  status: varchar('status', { length: 20 })
    .$type<'pending' | 'approved' | 'rejected'>()
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
})
