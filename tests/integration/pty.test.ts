import { describe, it, expect } from 'vitest';
import { PtyProcess, keySequence } from '@ttysage/pty';

function collect(p: PtyProcess): { text: () => string } {
  let buf = '';
  p.onData((d) => { buf += d; });
  return { text: () => buf };
}
async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Phase 1: PTY', () => {
  it('P1.1 child sees a real TTY on stdin and stdout', async () => {
    const p = new PtyProcess({ command: '[ -t 0 ] && [ -t 1 ] && echo TTY-YES || echo TTY-NO' });
    const out = collect(p);
    const exit = await p.exit;
    expect(out.text()).toContain('TTY-YES');
    expect(exit.exitCode).toBe(0);
  });

  it('P1.2 dimensions propagate and resize updates them', async () => {
    const p = new PtyProcess({ command: 'stty size; read x; stty size', cols: 91, rows: 33 });
    const out = collect(p);
    await until(() => out.text().includes('33 91'));
    p.resize(100, 20);
    p.write('\r');
    await p.exit;
    expect(out.text()).toContain('20 100');
  });

  it('P1.3 interactive input round-trips', async () => {
    const p = new PtyProcess({ command: 'printf "name? "; read n; echo "hello <$n>"' });
    const out = collect(p);
    await until(() => out.text().includes('name?'));
    p.write('sage');
    p.sendKey('ENTER');
    await p.exit;
    expect(out.text()).toContain('hello <sage>');
  });

  it('P1.4 allowlisted keys encode correctly', () => {
    expect(keySequence('UP')).toBe('\x1b[A');
    expect(keySequence('UP', { applicationCursorKeys: true })).toBe('\x1bOA');
    expect(keySequence('DOWN')).toBe('\x1b[B');
    expect(keySequence('CTRL_C')).toBe('\x03');
    expect(keySequence('CTRL_D')).toBe('\x04');
    expect(keySequence('ESCAPE')).toBe('\x1b');
    expect(keySequence('TAB')).toBe('\t');
    expect(keySequence('BACKSPACE')).toBe('\x7f');
    expect(keySequence('ENTER')).toBe('\r');
  });

  it('P1.5 Ctrl+C interrupts the foreground process', async () => {
    const p = new PtyProcess({ command: 'echo ready; exec sleep 30' });
    const out = collect(p);
    await until(() => out.text().includes('ready'));
    await new Promise((r) => setTimeout(r, 100));
    p.sendKey('CTRL_C');
    const exit = await p.exit;
    expect(exit.exitCode).toBe(130);
  });

  it('P1.6 exit codes pass through', async () => {
    const p = new PtyProcess({ command: 'exit 7' });
    expect((await p.exit).exitCode).toBe(7);
  });

  it('P1.7 terminate() kills the process group', async () => {
    const p = new PtyProcess({ command: 'sleep 31.37 & sleep 31.37; wait' });
    await new Promise((r) => setTimeout(r, 200));
    const exit = await p.terminate(500);
    expect(exit.exitCode).not.toBe(0);
    p.dispose();
    await new Promise((r) => setTimeout(r, 200));
    const { execSync } = await import('node:child_process');
    const left = execSync('pgrep -f "sleep 31.37" || true').toString().trim();
    expect(left).toBe('');
  });

  it('Ctrl+D ends input (EOF)', async () => {
    const p = new PtyProcess({ command: 'cat >/dev/null; echo EOF-OK' });
    const out = collect(p);
    await new Promise((r) => setTimeout(r, 200));
    p.sendKey('CTRL_D');
    await p.exit;
    expect(out.text()).toContain('EOF-OK');
  });
});
