// Recreate the demo database at schema v1 with a few rows, then switch schema.ts to v2.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createClient } from '@libsql/client';

fs.rmSync('local.db', { force: true });
fs.copyFileSync('schema.v1.ts', 'schema.ts');
execSync('npx drizzle-kit push --force', { stdio: 'inherit' });
const db = createClient({ url: 'file:./local.db' });
await db.execute("insert into users (name, legacy_email) values ('Ada', 'ada@old.example'), ('Linus', 'linus@old.example'), ('Grace', 'grace@old.example')");
fs.copyFileSync('schema.v2.ts', 'schema.ts');
console.log('Demo DB ready: 3 users at schema v1; schema.ts is now v2. Run: ttysage run "npx drizzle-kit push"');
