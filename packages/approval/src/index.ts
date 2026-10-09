import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { HumanChannel, InteractionRequest, Resolution } from '@ttysage/core';
import { isAffirmative, isNegative } from '@ttysage/detector';
import { redactSecrets, riskRank } from '@ttysage/safety';

// ---------------------------------------------------------------------------
// Choices offered to the human. A human can only pick from these — never free-form keys.
// ---------------------------------------------------------------------------

export interface Choice {
  label: string;
  resolution: Resolution | { type: 'text-entry' };
  note?: string;
  danger?: boolean;
}

export function buildChoices(req: InteractionRequest, opts: { allowTakeover?: boolean; allowText?: boolean } = {}): { choices: Choice[]; focus: number } {
  const { prompt, decision } = req;
  const choices: Choice[] = [];
  const risky = decision.destructive || riskRank(decision.risk) >= riskRank('HIGH');
  if ((prompt.type === 'confirmation' || prompt.type === 'selection') && !prompt.multiple) {
    prompt.options.forEach((o, i) => {
      choices.push({
        label: o.label,
        resolution: { type: 'action', action: { type: 'SELECT_OPTION', optionIndex: i }, by: 'human', label: o.label },
        ...(i === prompt.defaultIndex ? { note: 'program default' } : {}),
        danger: risky && (prompt.type === 'selection' || isAffirmative(o.label)),
      });
    });
  }
  if ((opts.allowText ?? true) && ['text', 'password', 'unknown'].includes(prompt.type)) {
    choices.push({ label: prompt.type === 'password' ? 'Enter the secret (hidden)…' : 'Type an answer…', resolution: { type: 'text-entry' } });
    if (prompt.default !== null && prompt.type === 'text') {
      choices.push({ label: `Accept default: ${prompt.default}`, resolution: { type: 'action', action: { type: 'ACCEPT_DEFAULT' }, by: 'human', label: prompt.default }, danger: risky });
    }
  }
  if (opts.allowTakeover ?? true) choices.push({ label: 'Take over — answer in the terminal myself', resolution: { type: 'takeover' } });
  choices.push({ label: 'Cancel the command (Ctrl+C)', resolution: { type: 'cancel', by: 'human' } });

  // Focus: the program default unless the situation is risky, then the safest option.
  let focus = choices.length - 1;
  if (risky) {
    const neg = choices.findIndex((c) => c.resolution.type === 'action' && isNegative(c.label));
    focus = neg !== -1 ? neg : choices.length - 1;
  } else if (prompt.defaultIndex !== null && prompt.defaultIndex < choices.length) {
    focus = prompt.defaultIndex;
  } else {
    focus = 0;
  }
  return { choices, focus };
}

// ---------------------------------------------------------------------------
// Rendering (pure, testable)
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
  cyan: '\x1b[36m', inverse: '\x1b[7m', magenta: '\x1b[35m',
};

function riskColor(r: string): string {
  return r === 'CRITICAL' || r === 'HIGH' ? C.red : r === 'MEDIUM' || r === 'UNKNOWN' ? C.yellow : C.green;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + ' ' + word).trim().length > width) {
        if (line) out.push(line);
        line = word.length > width ? word.slice(0, width - 1) + '…' : word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

// Visible width (strip ANSI).
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length;
}

export interface DialogState {
  focus: number;
  textMode: boolean;
  text: string;
  error?: string;
}

export function evidenceLines(req: InteractionRequest, max = 6): string[] {
  const lines = new Set<string>();
  for (const s of [...req.decision.signals].sort((a, b) => riskRank(b.level) - riskRank(a.level))) {
    if (s.source === 'context' || s.source === 'question' || s.source === 'option') lines.add(s.line);
    if (lines.size >= max) break;
  }
  return [...lines];
}

export function renderDialog(req: InteractionRequest, choices: Choice[], state: DialogState, cols: number, rows: number): string {
  const width = Math.max(40, Math.min(cols - 2, 96));
  const inner = width - 4;
  const body: string[] = [];
  const { decision, prompt } = req;
  const approval = decision.kind === 'approval';
  body.push(`${C.bold}${approval ? `${riskColor(decision.risk)}⚠ Human approval required` : `${C.cyan}✎ Input needed`}${C.reset}   ${C.dim}risk:${C.reset} ${riskColor(decision.risk)}${C.bold}${decision.risk}${C.reset}`);
  body.push('');
  body.push(`${C.dim}Command:${C.reset} ${redactSecrets(req.command).slice(0, inner - 9)}`);
  body.push(`${C.dim}Directory:${C.reset} ${req.cwd.slice(-(inner - 11))}`);
  if (req.intent) for (const l of wrap(`Agent intent: ${req.intent}`, inner)) body.push(`${C.dim}${l}${C.reset}`);
  body.push('');
  body.push(`${C.bold}The program asks:${C.reset}`);
  for (const l of wrap(prompt.question || prompt.inputLabel || '(no question text)', inner - 2)) body.push(`  ${l}`);
  const evidence = evidenceLines(req);
  if (evidence.length) {
    body.push('');
    body.push(`${C.bold}What the program said:${C.reset} ${C.dim}(untrusted program output)${C.reset}`);
    for (const e of evidence) for (const l of wrap(e, inner - 4).slice(0, 2)) body.push(`  ${C.yellow}•${C.reset} ${l}`);
  }
  body.push('');
  body.push(`${C.bold}Why TtySage stopped:${C.reset}`);
  for (const l of wrap(decision.reason, inner - 2).slice(0, 5)) body.push(`  ${l}`);
  if (decision.llm?.summary) {
    body.push(`${C.bold}Assessment:${C.reset}`);
    for (const l of wrap(decision.llm.summary, inner - 2).slice(0, 3)) body.push(`  ${l}`);
    for (const c of (decision.llm.consequences ?? []).slice(0, 4)) body.push(`  ${C.magenta}→${C.reset} ${c.slice(0, inner - 4)}`);
  }
  if (req.note) body.push(`${C.yellow}${req.note}${C.reset}`);
  body.push('');
  if (state.textMode) {
    const shown = prompt.type === 'password' ? '•'.repeat(state.text.length) : state.text;
    body.push(`${C.bold}Answer:${C.reset} ${shown}${C.inverse} ${C.reset}`);
    body.push(`${C.dim}Enter submit · Esc back${C.reset}`);
  } else {
    choices.forEach((c, i) => {
      const sep = c.resolution.type === 'takeover' || (c.resolution.type === 'cancel' && choices[i - 1]?.resolution.type !== 'takeover');
      if (sep && i > 0) body.push(`  ${C.dim}${'─'.repeat(Math.min(30, inner - 2))}${C.reset}`);
      const focused = i === state.focus;
      const label = `${c.label}${c.note ? `${C.dim}  (${c.note})${C.reset}` : ''}${c.danger ? `  ${C.red}⚠${C.reset}` : ''}`;
      body.push(`${focused ? `${C.cyan}❯ ${C.bold}` : '  '}${label}${C.reset}`);
    });
    body.push('');
    body.push(`${C.dim}↑/↓ choose · Enter confirm · 1-9 jump · Ctrl+C cancel command${C.reset}`);
  }
  if (state.error) body.push(`${C.red}${state.error}${C.reset}`);

  const title = ` TtySage `;
  const top = `╭─${C.bold}${title}${C.reset}${'─'.repeat(Math.max(0, width - 3 - title.length))}╮`;
  const bottom = `╰${'─'.repeat(width - 2)}╯`;
  const lines = [top, ...body.map((l) => {
    const pad = Math.max(0, inner - vlen(l));
    return `│ ${l}${' '.repeat(pad)} │`;
  }), bottom];
  const visible = lines.slice(0, Math.max(5, rows - 1));
  return `\x1b[H\x1b[2J${visible.join('\r\n')}`;
}

// ---------------------------------------------------------------------------
// TTY dialog: shown in the alternate screen buffer so the program's screen is untouched.
// ---------------------------------------------------------------------------

export interface TtyIO {
  write(s: string): void;
  size(): { cols: number; rows: number };
  /** Whether the child currently shows its cursor (restored on close). */
  childCursorVisible(): boolean;
}

export class TtyDialog {
  private state: DialogState;
  private resolve!: (r: Resolution) => void;
  readonly done: Promise<Resolution>;
  private closed = false;

  constructor(
    private readonly io: TtyIO,
    private readonly req: InteractionRequest,
    private readonly choices: Choice[],
    focus: number,
  ) {
    this.state = { focus, textMode: false, text: '' };
    this.done = new Promise((r) => { this.resolve = r; });
    io.write('\x07\x1b[?1049h\x1b[?25l');
    this.render();
    req.signal.addEventListener('abort', () => this.finish({ type: 'takeover' }), { once: true });
  }

  render(): void {
    if (this.closed) return;
    const { cols, rows } = this.io.size();
    this.io.write(renderDialog(this.req, this.choices, this.state, cols, rows));
  }

  private finish(r: Resolution): void {
    if (this.closed) return;
    this.closed = true;
    this.io.write(`\x1b[?1049l${this.io.childCursorVisible() ? '\x1b[?25h' : '\x1b[?25l'}`);
    this.resolve(r);
  }

  /** Feed raw stdin bytes. */
  input(data: string): void {
    if (this.closed) return;
    if (this.state.textMode) return this.textInput(data);
    if (data === '\x03') return this.finish({ type: 'cancel', by: 'human' });
    if (data === '\x1b[A' || data === '\x1bOA' || data === 'k') this.state.focus = (this.state.focus + this.choices.length - 1) % this.choices.length;
    else if (data === '\x1b[B' || data === '\x1bOB' || data === 'j' || data === '\t') this.state.focus = (this.state.focus + 1) % this.choices.length;
    else if (/^[1-9]$/.test(data) && Number(data) <= this.choices.length) this.state.focus = Number(data) - 1;
    else if (data === '\r' || data === '\n') return this.choose();
    this.render();
  }

  private choose(): void {
    const c = this.choices[this.state.focus]!;
    if (c.resolution.type === 'text-entry') {
      this.state.textMode = true;
      this.state.text = '';
      this.render();
      return;
    }
    this.finish(c.resolution);
  }

  private textInput(data: string): void {
    if (data === '\x1b') { this.state.textMode = false; this.render(); return; }
    if (data === '\x03') return this.finish({ type: 'cancel', by: 'human' });
    if (data === '\r' || data === '\n') {
      this.finish({ type: 'action', action: { type: 'TEXT', text: this.state.text, submit: true }, by: 'human', label: this.req.prompt.type === 'password' ? '[secret]' : this.state.text });
      return;
    }
    if (data === '\x7f' || data === '\b') this.state.text = [...this.state.text].slice(0, -1).join('');
    // eslint-disable-next-line no-control-regex
    else if (!/[\x00-\x1f]/.test(data)) this.state.text += data;
    this.render();
  }
}

// ---------------------------------------------------------------------------
// File-based approval queue: lets a human approve from another terminal (`ttysage approvals`)
// when the caller (MCP server, non-TTY CLI) has no terminal of its own.
// ---------------------------------------------------------------------------

export interface QueuedApproval {
  id: string;
  createdAt: string;
  pid: number;
  sessionId: string;
  command: string;
  cwd: string;
  intent?: string;
  question: string;
  promptType: string;
  risk: string;
  kind: string;
  reason: string;
  evidence: string[];
  screen: string[];
  choices: { label: string; danger?: boolean; text?: boolean }[];
  allowText: boolean;
}

export interface QueuedResponse {
  choice?: number;
  text?: string;
  respondedAt: string;
}

export class ApprovalQueue {
  constructor(readonly dir: string) {}

  private ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  list(): QueuedApproval[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: QueuedApproval[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^[a-z0-9-]+\.json$/.test(f) || f.endsWith('.response.json')) continue;
      try {
        const q = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as QueuedApproval;
        if (!processAlive(q.pid)) { this.remove(q.id); continue; }
        out.push(q);
      } catch { /* partial write */ }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): QueuedApproval | null {
    return this.list().find((q) => q.id === id || q.id.startsWith(id)) ?? null;
  }

  enqueue(q: QueuedApproval): void {
    this.ensure();
    const file = path.join(this.dir, `${q.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(q, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  respond(id: string, r: Omit<QueuedResponse, 'respondedAt'>): void {
    this.ensure();
    const file = path.join(this.dir, `${id}.response.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...r, respondedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  readResponse(id: string): QueuedResponse | null {
    const file = path.join(this.dir, `${id}.response.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8')) as QueuedResponse;
      fs.rmSync(file, { force: true }); // responses may contain typed text: delete immediately
      return r;
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    fs.rmSync(path.join(this.dir, `${id}.response.json`), { force: true });
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface QueueChannelOptions {
  queue: ApprovalQueue;
  timeoutMs?: number;
  /** Called when a request is queued (to tell someone to go approve it). */
  onQueued?: (q: QueuedApproval) => void;
  onResolved?: (q: QueuedApproval, r: Resolution) => void;
}

export function toQueued(req: InteractionRequest, choices: Choice[]): QueuedApproval {
  return {
    id: `${req.id}-${randomBytes(2).toString('hex')}`,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    sessionId: req.sessionId,
    command: redactSecrets(req.command),
    cwd: req.cwd,
    ...(req.intent ? { intent: req.intent } : {}),
    question: req.prompt.question || req.prompt.inputLabel || '',
    promptType: req.prompt.type,
    risk: req.decision.risk,
    kind: req.decision.kind,
    reason: req.decision.reason,
    evidence: evidenceLines(req),
    screen: req.screen.slice(-25).map(redactSecrets),
    choices: choices.map((c) => ({ label: c.label, ...(c.danger ? { danger: true } : {}), ...(c.resolution.type === 'text-entry' ? { text: true } : {}) })),
    allowText: choices.some((c) => c.resolution.type === 'text-entry'),
  };
}

/** Human channel backed by the approval queue. */
export class QueueChannel implements HumanChannel {
  readonly humanAvailable = true;
  readonly inputProviderAvailable = true;
  constructor(private readonly opts: QueueChannelOptions) {}

  async request(req: InteractionRequest): Promise<Resolution> {
    // No terminal to take over from here, and secrets are never written to disk.
    if (req.prompt.type === 'password') return { type: 'cancel', by: 'system', reason: 'password prompt with no interactive terminal' };
    const { choices } = buildChoices(req, { allowTakeover: false });
    const q = toQueued(req, choices);
    this.opts.queue.enqueue(q);
    this.opts.onQueued?.(q);
    const deadline = Date.now() + (this.opts.timeoutMs ?? 10 * 60_000);
    try {
      while (!req.signal.aborted) {
        const r = this.opts.queue.readResponse(q.id);
        if (r) {
          const res = this.toResolution(choices, r);
          this.opts.onResolved?.(q, res);
          return res;
        }
        if (Date.now() > deadline) {
          const res: Resolution = { type: 'cancel', by: 'system', reason: 'approval timed out' };
          this.opts.onResolved?.(q, res);
          return res;
        }
        await new Promise((r2) => setTimeout(r2, 200));
      }
      return { type: 'takeover' };
    } finally {
      this.opts.queue.remove(q.id);
    }
  }

  private toResolution(choices: Choice[], r: QueuedResponse): Resolution {
    if (typeof r.text === 'string' && choices.some((c) => c.resolution.type === 'text-entry')) {
      return { type: 'action', action: { type: 'TEXT', text: r.text, submit: true }, by: 'human', label: r.text };
    }
    const c = typeof r.choice === 'number' ? choices[r.choice] : undefined;
    if (!c || c.resolution.type === 'text-entry') return { type: 'cancel', by: 'system', reason: 'invalid approval response' };
    return c.resolution;
  }
}
