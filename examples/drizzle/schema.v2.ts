import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// v2: rename users.name -> users.full_name, drop users.legacy_email, add users.email
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  fullName: text('full_name').notNull(),
  email: text('email'),
});
