/**
 * Real third-party CLIs driven through TtySage. Nothing here is CLI-specific in TtySage itself:
 * these tests only check that the generic pipeline handles famous tools correctly.
 *
 * Opt-in (needs network / installed tools):  TTYSAGE_REAL_TOOLS=1 pnpm test:real
 * Everything runs in temp dirs with temp config; no accounts or global state are touched.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScripted } from '../helpers/scripted';
import type { InteractionRequest, Resolution } from '@ttysage/core';
import { PtyProcess } from '@ttysage/pty';
import { HeadlessTerminal } from '@ttysage/terminal';

const ENABLED = process.env.TTYSAGE_REAL_TOOLS === '1';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const has = (bin: string) => { try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; } };
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ttysage-${name}-`));
const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'd', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'd', GIT_COMMITTER_EMAIL: 'd@x' } }).toString();
const tool = (bin: string) => (ENABLED && has(bin) ? it : it.skip);

const human = (fn: (r: InteractionRequest) => Resolution) => fn;
const select = (label: RegExp) => human((r) => {
  const i = r.prompt.options.findIndex((o) => label.test(o.label));
  if (i === -1) throw new Error(`no option ${label} in ${r.prompt.options.map((o) => o.label)}`);
  return { type: 'action', action: { type: 'SELECT_OPTION', optionIndex: i }, by: 'human' };
});

describe.runIf(ENABLED)('real tools', () => {
  beforeAll(() => {
    for (const ex of ['drizzle', 'prisma']) {
      if (!fs.existsSync(path.join(ROOT, 'examples', ex, 'node_modules'))) sh('npm install --no-audit --no-fund', path.join(ROOT, 'examples', ex));
    }
  }, 240_000);

  tool('terraform')('terraform apply: add-only plan is HIGH, plan with destroy is CRITICAL; human types "yes"', async () => {
    const dir = tmp('tf');
    fs.copyFileSync(path.join(ROOT, 'examples/terraform/main.tf'), path.join(dir, 'main.tf'));
    sh('terraform init -input=false', dir);
    const approve = (r: InteractionRequest): Resolution => ({ type: 'action', action: { type: 'TEXT', text: 'yes', submit: true }, by: 'human' });
    const a = await runScripted('terraform apply', approve, { cwd: dir, timeoutMs: 60_000 });
    expect(a.channel.requests[0]!.decision).toMatchObject({ decision: 'ASK_HUMAN', kind: 'approval', risk: 'HIGH' });
    expect(a.channel.requests[0]!.prompt.question).toBe('Do you want to perform these actions?');
    expect(a.result.output).toContain('Apply complete! Resources: 2 added');
    const b = await runScripted('terraform apply -var release=v2', approve, { cwd: dir, timeoutMs: 60_000 });
    expect(b.channel.requests[0]!.decision.risk).toBe('CRITICAL');
    expect(b.result.exitCode).toBe(0);
    // Agent-only (no human): never applied.
    const c = await runScripted('terraform apply -var release=v3', () => { throw new Error('no'); }, { cwd: dir, humanAvailable: false, timeoutMs: 60_000 });
    expect(c.result.interactions[0]!.resolvedBy).toBe('deny');
    expect(c.result.output).not.toContain('Apply complete');
  }, 180_000);

  tool('npx')('drizzle-kit push: rename ambiguity + data-loss confirmation, human approves rename, data kept', async () => {
    const dir = path.join(ROOT, 'examples/drizzle');
    sh('node reset.mjs', dir);
    const { result, channel } = await runScripted('npx drizzle-kit push', (r) => {
      if (/full_name/.test(r.prompt.question)) return select(/name › full_name/)(r); // it IS a rename
      if (/email column/.test(r.prompt.question)) return select(/create column/)(r);
      expect(r.decision.risk).toBe('CRITICAL');
      return select(/^Yes/)(r);
    }, { cwd: dir, timeoutMs: 120_000, intent: 'Rename users.name to full_name and add an email column' });
    expect(channel.requests.every((r) => r.decision.decision === 'ASK_HUMAN')).toBe(true);
    expect(channel.requests[0]!.decision.risk).toBe('HIGH');
    const last = channel.requests[channel.requests.length - 1]!;
    expect(last.decision.intentMismatch).toBe(true); // intent never asked to delete legacy_email
    expect(result.output).toContain('Changes applied');
    expect(result.exitCode).toBe(0);
    const rows = sh(`node -e "import('@libsql/client').then(async ({createClient})=>{const r=await createClient({url:'file:./local.db'}).execute('select full_name from users order by id');console.log(r.rows.map(x=>x.full_name).join(','))})"`, dir).trim();
    expect(rows).toBe('Ada,Linus,Grace');
  }, 180_000);

  tool('npx')('drizzle-kit push: agent alone cannot destroy data', async () => {
    const dir = path.join(ROOT, 'examples/drizzle');
    sh('node reset.mjs', dir);
    const { result } = await runScripted('npx drizzle-kit push', () => { throw new Error('no human'); }, { cwd: dir, humanAvailable: false, timeoutMs: 120_000 });
    expect(result.interactions.every((i) => i.resolvedBy === 'deny')).toBe(true);
    expect(result.output).not.toContain('Changes applied');
  }, 180_000);

  tool('sqlite3')('prisma migrate dev: data-loss (y/N) needs a human; agent supplies the migration name; no stray Enter', async () => {
    const dir = path.join(ROOT, 'examples/prisma');
    sh('./reset.sh', dir);
    const { result, channel } = await runScripted('npx prisma migrate dev', (r) =>
      r.prompt.type === 'text'
        ? { type: 'action', action: { type: 'TEXT', text: 'drop_legacy_email', submit: true }, by: 'agent' }
        : { type: 'action', action: { type: 'CONFIRM', value: 'yes' }, by: 'human' }, { cwd: dir, timeoutMs: 120_000 });
    expect(channel.requests[0]!.decision).toMatchObject({ kind: 'approval', risk: 'CRITICAL' });
    expect(channel.requests[0]!.prompt).toMatchObject({ type: 'confirmation', default: 'No' });
    expect(channel.requests[1]!.prompt.question).toBe('Enter a name for the new migration');
    expect(fs.readdirSync(path.join(dir, 'prisma/migrations')).some((m) => m.endsWith('_drop_legacy_email'))).toBe(true);
    expect(result.exitCode).toBe(0);
  }, 180_000);

  tool('npm')('npm init: defaults auto-accepted, free-text fields go to the agent', async () => {
    const dir = tmp('npm');
    const { result } = await runScripted('npm init', (r) => {
      expect(r.decision.kind).toBe('input');
      return { type: 'action', action: { type: 'TEXT', text: r.prompt.question === 'description' ? 'made by an agent' : '', submit: true }, by: 'agent' };
    }, { cwd: dir, timeoutMs: 60_000 });
    expect(result.exitCode).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: path.basename(dir).toLowerCase(), version: '1.0.0', description: 'made by an agent', license: 'ISC' });
    expect(result.interactions.filter((i) => i.resolvedBy === 'auto').length).toBeGreaterThanOrEqual(5);
  }, 90_000);

  tool('vim')('git rebase -i: editor detected, agent drives it with validated text', async () => {
    const dir = tmp('git');
    sh('git init -q && for i in 1 2 3 4; do echo $i > f$i; git add .; git commit -qm "c$i"; done', dir);
    const { result, channel } = await runScripted('git rebase -i HEAD~3', () => ({ type: 'action', action: { type: 'TEXT', text: ':wq', submit: true }, by: 'agent' }), { cwd: dir, timeoutMs: 60_000, env: { ...process.env, GIT_EDITOR: 'vim' } });
    expect(channel.requests[0]!.prompt.type).toBe('editor');
    expect(channel.requests[0]!.decision.kind).toBe('input');
    expect(result.output).toContain('Successfully rebased');
  }, 90_000);

  tool('git')('git add -p: bracketed key list is not mistaken for a default', async () => {
    const dir = tmp('gitp');
    sh('git init -q && echo a > f && git add f && git commit -qm a && echo b >> f', dir);
    const { result, channel } = await runScripted('git add -p', () => ({ type: 'action', action: { type: 'TEXT', text: 'y', submit: true }, by: 'agent' }), { cwd: dir, timeoutMs: 30_000 });
    expect(channel.requests[0]!.prompt).toMatchObject({ type: 'text', default: null });
    expect(channel.requests[0]!.prompt.question).toContain('Stage this hunk');
    expect(result.exitCode).toBe(0);
    expect(sh('git diff --cached --stat', dir)).toContain('f');
  }, 60_000);

  tool('npm')('npm create vite: intent picks framework + variant, safe confirmations auto-answered', async () => {
    const dir = tmp('vite');
    const { result, channel } = await runScripted('npm create vite@latest my-app', (r) => {
      // Anything the intent does not settle is answered conservatively ("No" / default).
      const no = r.prompt.options.findIndex((o) => /^no/i.test(o.label));
      return no !== -1
        ? { type: 'action', action: { type: 'SELECT_OPTION', optionIndex: no }, by: 'human' }
        : { type: 'action', action: { type: 'ACCEPT_DEFAULT' }, by: 'human' };
    }, { cwd: dir, timeoutMs: 120_000, intent: 'Scaffold a React app with TypeScript' });
    const autos = result.interactions.filter((i) => i.resolvedBy === 'auto').map((i) => i.answer);
    expect(autos.join(' | ')).toMatch(/\(React\).*\(TypeScript\)/);
    expect(fs.existsSync(path.join(dir, 'my-app/package.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'my-app/package.json'), 'utf8')).dependencies.react).toBeDefined();
    void channel;
  }, 180_000);

  tool('ssh')('ssh unknown host key: HIGH-risk approval; human answers "no"', async () => {
    const dir = tmp('ssh');
    const { result, channel } = await runScripted(`ssh -o UserKnownHostsFile=${dir}/known_hosts -o StrictHostKeyChecking=ask -o BatchMode=no git@github.com`,
      () => ({ type: 'action', action: { type: 'CONFIRM', value: 'no' }, by: 'human' }), { cwd: dir, timeoutMs: 30_000 });
    expect(channel.requests[0]!.prompt).toMatchObject({ type: 'confirmation', answerForm: 'word' });
    expect(channel.requests[0]!.decision).toMatchObject({ kind: 'approval', risk: 'HIGH' });
    expect(result.exitCode).not.toBe(0);
    expect(fs.existsSync(`${dir}/known_hosts`) && fs.readFileSync(`${dir}/known_hosts`, 'utf8').includes('github')).toBe(false);
  }, 60_000);

  tool('aws')('aws configure (temp config): credential prompts are human-only and never auto-filled', async () => {
    const dir = tmp('aws');
    const env = { ...process.env, AWS_CONFIG_FILE: `${dir}/config`, AWS_SHARED_CREDENTIALS_FILE: `${dir}/credentials` };
    const { result, channel } = await runScripted('aws configure', () => ({ type: 'cancel', by: 'human' }), { cwd: dir, env, timeoutMs: 30_000 });
    expect(channel.requests[0]!.prompt.question).toBe('AWS Access Key ID');
    expect(channel.requests[0]!.decision).toMatchObject({ decision: 'ASK_HUMAN', kind: 'approval' });
    expect(result.interactions.some((i) => i.resolvedBy === 'auto')).toBe(false);
    expect(fs.existsSync(`${dir}/credentials`)).toBe(false);
  }, 60_000);

  tool('sudo')('sudo password prompt: detected as password, never typed', async () => {
    const { result, channel } = await runScripted('sudo -k && sudo -v', () => ({ type: 'cancel', by: 'human' }), { cwd: os.tmpdir(), timeoutMs: 30_000 });
    expect(channel.requests[0]!.prompt.type).toBe('password');
    expect(channel.requests[0]!.decision.decision).toBe('ASK_HUMAN');
    expect(result.interactions.every((i) => i.resolvedBy !== 'auto')).toBe(true);
  }, 60_000);

  tool('npx')('DEFINITION OF SUCCESS: `ttysage run "npx drizzle-kit push"` in a real terminal with a human at the dialog', async () => {
    const dir = path.join(ROOT, 'examples/drizzle');
    sh('node reset.mjs', dir);
    const home = tmp('home');
    const screen = new HeadlessTerminal({ cols: 110, rows: 45 });
    const p = new PtyProcess({ command: `${ROOT}/node_modules/.bin/tsx ${ROOT}/apps/cli/src/main.ts run "npx drizzle-kit push"`, cwd: dir, cols: 110, rows: 45, env: { ...process.env, TTYSAGE_HOME: home } });
    p.onData((d) => void screen.write(d));
    const text = () => screen.snapshot().lines.join('\n');
    const waitFor = async (re: RegExp, ms = 60_000) => {
      const t0 = Date.now();
      while (!re.test(text())) { if (Date.now() - t0 > ms) throw new Error(`timeout ${re}\n${text()}`); await new Promise((r) => setTimeout(r, 50)); }
    };
    const choose = async (label: RegExp) => {
      for (let i = 0; i < 8 && !new RegExp(`❯ ${label.source}`).test(text()); i++) { p.write('\x1b[B'); await new Promise((r) => setTimeout(r, 120)); }
      expect(text()).toMatch(new RegExp(`❯ ${label.source}`));
      p.write('\r');
      await new Promise((r) => setTimeout(r, 400));
    };
    // 1. rename ambiguity for full_name → human says it is a rename of `name`
    await waitFor(/Human approval required[\s\S]*full_name column in users table created or renamed/);
    await choose(/~ name › full_name/);
    // 2. email: created
    await waitFor(/Human approval required[\s\S]*email column in users table created or renamed/);
    await choose(/\+ email/);
    // 3. data loss: legacy_email drop → CRITICAL, focus starts on "No, abort"
    await waitFor(/Human approval required[\s\S]*Do you still want to push changes\?/);
    expect(text()).toMatch(/CRITICAL/);
    expect(text()).toMatch(/❯ No, abort/);
    await choose(/Yes, I want to remove 1 column/);
    const exit = await p.exit;
    await waitFor(/Changes applied/);
    expect(exit.exitCode).toBe(0);
    const rows = sh(`node -e "import('@libsql/client').then(async ({createClient})=>{const r=await createClient({url:'file:./local.db'}).execute('select full_name, email from users order by id');console.log(JSON.stringify(r.rows.map(x=>[x.full_name,x.email])))})"`, dir).trim();
    expect(JSON.parse(rows)).toEqual([['Ada', null], ['Linus', null], ['Grace', null]]);
    const events = fs.readdirSync(path.join(home, 'audit')).flatMap((f) => fs.readFileSync(path.join(home, 'audit', f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
    const inter = events.filter((e) => e.type === 'interaction');
    expect(inter.map((e) => [e.decision, e.risk, e.resolvedBy])).toEqual([['ASK_HUMAN', 'HIGH', 'human'], ['ASK_HUMAN', 'HIGH', 'human'], ['ASK_HUMAN', 'CRITICAL', 'human']]);
    expect(inter[2].humanDecision).toBe('Yes, I want to remove 1 column');
    expect(events.find((e) => e.type === 'session_end').exitCode).toBe(0);
  }, 180_000);
});
