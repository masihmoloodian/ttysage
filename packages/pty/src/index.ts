import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IPty, IDisposable } from 'node-pty';

const require = createRequire(import.meta.url);

/**
 * Under some package managers (pnpm) node-pty's prebuilt `spawn-helper` loses its exec bit,
 * which surfaces as an opaque `posix_spawnp failed`. Repair it once, best-effort.
 */
let helperChecked = false;
export function ensureSpawnHelperExecutable(): void {
  if (helperChecked || process.platform === 'win32') return;
  helperChecked = true;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const mode = fs.statSync(file).mode;
      if ((mode & 0o111) === 0) fs.chmodSync(file, mode | 0o755);
    }
  } catch {
    // Not fatal: spawn will report its own error.
  }
}

function loadNodePty(): typeof import('node-pty') {
  ensureSpawnHelperExecutable();
  return require('node-pty') as typeof import('node-pty');
}

// ---------------------------------------------------------------------------
// Keys: the ONLY way automated code may send non-text input. LLMs never send raw bytes.
// ---------------------------------------------------------------------------

export const KEY_NAMES = [
  'ENTER', 'TAB', 'SHIFT_TAB', 'SPACE', 'BACKSPACE', 'ESCAPE',
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGE_UP', 'PAGE_DOWN', 'DELETE',
  'CTRL_C', 'CTRL_D',
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export function isKeyName(value: string): value is KeyName {
  return (KEY_NAMES as readonly string[]).includes(value);
}

export interface KeyEncodingOptions {
  /** DECCKM: terminal requested application cursor keys (ESC O A instead of ESC [ A). */
  applicationCursorKeys?: boolean;
}

export function keySequence(key: KeyName, opts: KeyEncodingOptions = {}): string {
  const app = opts.applicationCursorKeys === true;
  const cursor = (c: string) => (app ? `\x1bO${c}` : `\x1b[${c}`);
  switch (key) {
    case 'ENTER': return '\r';
    case 'TAB': return '\t';
    case 'SHIFT_TAB': return '\x1b[Z';
    case 'SPACE': return ' ';
    case 'BACKSPACE': return '\x7f';
    case 'ESCAPE': return '\x1b';
    case 'UP': return cursor('A');
    case 'DOWN': return cursor('B');
    case 'RIGHT': return cursor('C');
    case 'LEFT': return cursor('D');
    case 'HOME': return cursor('H');
    case 'END': return cursor('F');
    case 'PAGE_UP': return '\x1b[5~';
    case 'PAGE_DOWN': return '\x1b[6~';
    case 'DELETE': return '\x1b[3~';
    case 'CTRL_C': return '\x03';
    case 'CTRL_D': return '\x04';
  }
}

// ---------------------------------------------------------------------------
// PTY process
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /** Shell command line, executed via `$SHELL -c` so PATH, npx, pipes etc. behave like a terminal. */
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface ExitInfo {
  /** Exit code as a shell would report it (128 + signal for signalled processes). */
  exitCode: number;
  signal: number | null;
}

const SIGNAL_NUMBERS: Record<string, number> = os.constants.signals as unknown as Record<string, number>;

export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
}

export class PtyProcess {
  readonly pid: number;
  private readonly pty: IPty;
  private readonly disposables: IDisposable[] = [];
  private exitInfo: ExitInfo | null = null;
  private readonly exitPromise: Promise<ExitInfo>;
  private dataListeners = new Set<(data: string) => void>();
  private _cols: number;
  private _rows: number;

  constructor(opts: SpawnOptions) {
    const nodePty = loadNodePty();
    const shell = opts.shell ?? defaultShell();
    const args = process.platform === 'win32' ? ['/c', opts.command] : ['-c', opts.command];
    this._cols = opts.cols ?? 120;
    this._rows = opts.rows ?? 40;
    const env = { ...(opts.env ?? process.env) };
    env.TERM = env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color';
    env.TTYSAGE = '1';
    this.pty = nodePty.spawn(shell, args, {
      name: env.TERM,
      cols: this._cols,
      rows: this._rows,
      cwd: opts.cwd ?? process.cwd(),
      env: env as Record<string, string>,
    });
    this.pid = this.pty.pid;
    this.disposables.push(
      this.pty.onData((d) => {
        for (const l of this.dataListeners) l(d);
      }),
    );
    this.exitPromise = new Promise((resolve) => {
      this.disposables.push(
        this.pty.onExit(({ exitCode, signal }) => {
          const sig = signal && signal > 0 ? signal : null;
          this.exitInfo = { exitCode: sig ? 128 + sig : exitCode, signal: sig };
          resolve(this.exitInfo);
        }),
      );
    });
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  get exited(): boolean { return this.exitInfo !== null; }
  get exit(): Promise<ExitInfo> { return this.exitPromise; }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /** Raw write. Reserved for human passthrough and validated executor output. */
  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  sendKey(key: KeyName, opts?: KeyEncodingOptions): void {
    this.write(keySequence(key, opts));
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols < 1 || rows < 1) return;
    this._cols = cols;
    this._rows = rows;
    this.pty.resize(cols, rows);
  }

  /** Send a signal to the child (process group leader). */
  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    if (this.exited) return;
    try {
      // Negative pid: whole process group, so grandchildren (npx → node) don't linger.
      if (process.platform !== 'win32' && SIGNAL_NUMBERS[signal]) process.kill(-this.pid, signal);
      else this.pty.kill(signal);
    } catch {
      try { this.pty.kill(signal); } catch { /* already gone */ }
    }
  }

  /** Terminate gracefully, escalating to SIGKILL. Resolves when the child has exited. */
  async terminate(graceMs = 1500): Promise<ExitInfo> {
    if (this.exitInfo) return this.exitInfo;
    this.kill('SIGHUP');
    const timer = setTimeout(() => this.kill('SIGKILL'), graceMs);
    try {
      return await this.exitPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.dataListeners.clear();
  }
}
