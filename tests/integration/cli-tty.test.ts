import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PtyProcess } from '@ttysage/pty';
import { HeadlessTerminal } from '@ttysage/terminal';
import { FIXTURES } from '../helpers/scripted';

const ROOT = path.resolve(FIXTURES, '../..');
const CLI = path.join(ROOT, 'apps/cli/src/main.ts');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');

/** A fake human: an outer terminal running `ttysage run …`, which we read and type into. */
function humanTerminal(args: string, home: string) {
  const screen = new HeadlessTerminal({ cols: 100, rows: 40 });
  let raw = '';
  const p = new PtyProcess({ command: `${TSX} ${CLI} run ${args}`, cwd: FIXTURES, cols: 100, rows: 40, env: { ...process.env, TTYSAGE_HOME: home } });
  p.onData((d) => { raw += d; void screen.write(d); });
  const text = () => screen.snapshot().lines.join('\n');
  const waitFor = async (re: RegExp, ms = 15_000) => {
    const t0 = Date.now();
    while (!re.test(text()) && !re.test(raw)) {
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n--- screen ---\n${text()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { p, text, raw: () => raw, waitFor };
}

describe('ttysage run in a real terminal (human-in-the-loop)', () => {
  it('shows an approval dialog for a destructive prompt; human approves; same process continues; audit written', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttysage-'));
    const h = humanTerminal('"node schema-sync.mjs"', home);
    await h.waitFor(/Human approval required/);
    const dialog = h.text();
    expect(dialog).toContain('CRITICAL');
    expect(dialog).toContain('Do you still want to apply these changes?');
    expect(dialog).toContain('drop column users.legacy_email');
    expect(dialog).toMatch(/❯ No, abort/); // focus starts on the safe option
    h.p.write('\x1b[B'); // human moves to "Yes, apply changes"
    await new Promise((r) => setTimeout(r, 150));
    expect(h.text()).toMatch(/❯ Yes, apply changes/);
    h.p.write('\r');
    const exit = await h.p.exit;
    await h.waitFor(/APPLIED/);
    expect(exit.exitCode).toBe(0);
    // The program's own screen is restored after the dialog (alternate screen).
    expect(h.text()).toContain('✔ Do you still want to apply these changes? Yes, apply changes');
    const log = fs.readdirSync(path.join(home, 'audit')).map((f) => fs.readFileSync(path.join(home, 'audit', f), 'utf8')).join('');
    const events = log.trim().split('\n').map((l) => JSON.parse(l));
    const interaction = events.find((e) => e.type === 'interaction');
    expect(interaction).toMatchObject({ decision: 'ASK_HUMAN', risk: 'CRITICAL', resolvedBy: 'human', humanDecision: 'Yes, apply changes', executed: true });
    expect(events.find((e) => e.type === 'session_end')).toMatchObject({ exitCode: 0 });
  }, 40_000);

  it('human cancels from the dialog ⇒ Ctrl+C reaches the program', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttysage-'));
    const h = humanTerminal('"node schema-sync.mjs"', home);
    await h.waitFor(/Human approval required/);
    h.p.write('\x03');
    const exit = await h.p.exit;
    expect(exit.exitCode).not.toBe(0);
    expect(h.raw()).not.toContain('APPLIED');
  }, 40_000);

  it('plain text input is typed directly by the human (takeover, no dialog)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttysage-'));
    const h = humanTerminal(`'printf "Your name: "; read n; echo "RESULT $n"'`, home);
    await h.waitFor(/Your name:/);
    await new Promise((r) => setTimeout(r, 900));
    expect(h.text()).not.toContain('TtySage');
    h.p.write('Ada\r');
    await h.p.exit;
    await h.waitFor(/RESULT Ada/);
  }, 40_000);
});
