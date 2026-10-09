import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './schema.ts',
  dbCredentials: { url: 'file:./local.db' },
});
