import path from 'node:path';
import { parseArgs } from 'node:util';
import { Session, type HumanChannel, type InteractionRequest, type Resolution, type InteractionRecord } from '@ttysage/core';
import { ApprovalQueue, QueueChannel, TtyDialog, buildChoices, type QueuedApproval } from '@ttysage/approval';
import { AuditLogger, ttysageHome } from '@ttysage/audit';
import { riskRank } from '@ttysage/safety';
import { ClaudeCliInterpreter, interpreterFromEnv } from '@ttysage/prompt-understanding';

const VERSION = '0.1.0';

const HELP = `TtySage ${VERSION} — an interactive terminal layer for AI coding agents

Usage:
  ttysage run [options] "<command>"     Run a command in a supervised PTY
  ttysage run [options] -- <cmd> [args]
  ttysage approvals                      Approve/reject pending requests (from MCP / non-TTY runs)
  ttysage approve <id> --choice <n> | --text <t> | --reject
  ttysage audit [--limit N] [--json]     Show recent audit events
  ttysage mcp                            Start the MCP server (stdio)

Run options:
  --intent <text>          What the agent is trying to do (used to spot mismatching consequences)
  --no-auto                Never answer automatically; always hand prompts to the human
  --cwd <dir>              Working directory
  --llm                    Enable the LLM second opinion via your local "claude" CLI login
  --approval-timeout <s>   Non-TTY: seconds to wait for \`ttysage approvals\` (default 600; 0 = deny)
  --json                   Print a JSON summary to stderr when done
  -q, --quiet              No TtySage notices

Environment: TTYSAGE_HOME (default ~/.ttysage), TTYSAGE_AUDIT=off, TTYSAGE_LLM=claude|anthropic, TTYSAGE_LLM_MODEL, TTYSAGE_CLAUDE_BIN.
MCP only: TTYSAGE_APPROVAL_MODE=human|ask-user|agent-high|bypass (who may answer risky prompts; default human).`;

const C = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', green: '\x1b[32m' };

function stderr(s: string): void {
  process.stderr.write(s);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface RunOptions {
  command: string;
  intent?: string;
  auto: boolean;
  cwd: string;
  llm: boolean;
  approvalTimeoutS: number;
  json: boolean;
  quiet: boolean;
}

function parseRun(argv: string[]): RunOptions {
  const dd = argv.indexOf('--');
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const tail = dd === -1 ? [] : argv.slice(dd + 1);
  const { values, positionals } = parseArgs({
    args: head,
    allowPositionals: true,
    options: {
      intent: { type: 'string' },
      'no-auto': { type: 'boolean', default: false },
      cwd: { type: 'string' },
      llm: { type: 'boolean', default: false },
      'approval-timeout': { type: 'string' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
  });
  const words = [...positionals, ...tail.map(shellQuote)];
  const command = tail.length ? [...positionals, ...tail.map(shellQuote)].join(' ') : positionals.join(' ');
  if (!words.length || !command.trim()) throw new UsageError('run: missing command');
  return {
    command,
    ...(values.intent ? { intent: values.intent } : {}),
    auto: !values['no-auto'],
    cwd: path.resolve(values.cwd ?? process.cwd()),
    llm: values.llm === true,
    approvalTimeoutS: values['approval-timeout'] !== undefined ? Number(values['approval-timeout']) : 600,
    json: values.json === true,
    quiet: values.quiet === true,
  };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

class UsageError extends Error {}

/** Human at this very terminal: approvals via an alternate-screen dialog; plain input is typed directly. */
class TtyChannel implements HumanChannel {
  readonly humanAvailable = true;
  readonly inputProviderAvailable = true;
  dialog: TtyDialog | null = null;
  constructor(private readonly session: () => Session) {}

  async request(req: InteractionRequest): Promise<Resolution> {
    const { decision, prompt } = req;
    const free = prompt.type === 'editor' || prompt.type === 'tui' || prompt.type === 'unknown' || prompt.type === 'multiline';
    // The human is looking at this terminal: ordinary input is simply typed into the program.
    if ((decision.kind === 'input' && riskRank(decision.risk) < riskRank('HIGH')) || free || this.session().snapshot().altScreen) {
      return { type: 'takeover' };
    }
    const { choices, focus } = buildChoices(req);
    const dialog = new TtyDialog(
      {
        write: (s) => process.stdout.write(s),
        size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
        childCursorVisible: () => this.session().snapshot().cursorVisible,
      },
      req, choices, focus,
    );
    this.dialog = dialog;
    try {
      return await dialog.done;
    } finally {
      this.dialog = null;
    }
  }
}

/**
 * Non-TTY output: stream the *rendered* terminal (what a human would see), not raw bytes, so
 * redraws, spinners and cursor movement don't turn into noise for agents and CI logs.
 */
class RenderedStream {
  private next = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly session: () => Session) {}
  start(): void {
    this.timer = setInterval(() => this.flush(this.session().scrollbackRows()), 250);
    this.timer.unref();
  }
  /** Print rendered rows up to (not including) absolute row `to`; everything if omitted. */
  flush(to?: number): void {
    if (to !== undefined && to <= this.next) return;
    const { lines, next } = this.session().renderedSince(this.next, to);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
    this.next = next;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }
}

function notice(rec: InteractionRecord): string {
  const who = rec.resolvedBy === 'auto' ? `${C.green}auto${C.reset}` : rec.resolvedBy === 'deny' ? `${C.red}denied${C.reset}` : rec.resolvedBy;
  const ans = rec.answer ? ` → ${rec.answer}` : '';
  return `${C.dim}[ttysage]${C.reset} ${rec.summary.slice(0, 120)} ${C.dim}(${rec.decision.risk})${C.reset} ${who}${ans}\n`;
}

async function run(opts: RunOptions): Promise<number> {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const audit = new AuditLogger();
  const interpreter = opts.llm ? new ClaudeCliInterpreter() : interpreterFromEnv();
  const queue = new ApprovalQueue(path.join(ttysageHome(), 'approvals'));
  let session!: Session;
  const ttyChannel = tty ? new TtyChannel(() => session) : null;
  let plain: RenderedStream | null = null;
  let channel: HumanChannel;
  if (ttyChannel) channel = ttyChannel;
  else if (opts.approvalTimeoutS > 0) {
    channel = new QueueChannel({
      queue,
      timeoutMs: opts.approvalTimeoutS * 1000,
      onQueued: (q) => {
        plain?.flush(session.scrollbackRows());
        stderr(`${C.yellow}[ttysage] ${q.kind === 'approval' ? `Human approval required (${q.risk})` : 'Input required'}: ${q.question}${C.reset}\n`);
        stderr(`[ttysage] ${q.reason}\n[ttysage] Waiting up to ${opts.approvalTimeoutS}s. In another terminal run:  ttysage approvals   (id ${q.id})\n`);
      },
    });
  } else {
    channel = { humanAvailable: false, inputProviderAvailable: false, request: async () => ({ type: 'cancel', by: 'system' }) };
  }

  session = new Session({
    command: opts.command,
    cwd: opts.cwd,
    ...(opts.intent ? { intent: opts.intent } : {}),
    autoAnswer: opts.auto,
    cols: tty ? process.stdout.columns : 120,
    rows: tty ? process.stdout.rows : 40,
    channel,
    interpreter,
    audit,
    mode: tty ? 'cli-tty' : 'cli-pipe',
  });

  // Output: straight through in a TTY (held back while a dialog owns the screen); plain text otherwise.
  const held: string[] = [];
  if (tty) {
    session.on('data', (d) => {
      if (ttyChannel?.dialog) held.push(d);
      else process.stdout.write(d);
    });
    session.on('interaction', () => {
      if (!ttyChannel?.dialog && held.length) process.stdout.write(held.splice(0).join(''));
    });
  } else {
    plain = new RenderedStream(() => session);
    plain.start();
    if (!opts.quiet) session.on('interaction', (rec) => { plain!.flush(rec.prompt.anchorLine); stderr(notice(rec)); });
  }

  // Input: raw passthrough (the human can always type), routed to the dialog while one is open.
  const onStdin = (buf: Buffer) => {
    const s = buf.toString('utf8');
    if (ttyChannel?.dialog) ttyChannel.dialog.input(s);
    else session.writeHuman(s);
  };
  if (tty) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onStdin);
  } else if (!process.stdin.isTTY) {
    // Piped stdin (e.g. `yes | ttysage run …`) is forwarded as-is.
    process.stdin.on('data', (b: Buffer) => session.writeHuman(b.toString('utf8')));
    process.stdin.on('error', () => {});
  }
  const onResize = () => {
    session.resize(process.stdout.columns, process.stdout.rows);
    ttyChannel?.dialog?.render();
  };
  if (tty) process.stdout.on('resize', onResize);

  const forward = (sig: NodeJS.Signals) => () => { void session.kill(); void sig; };
  const sigs: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const handlers = sigs.map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);

  session.start();
  const result = await session.wait();

  if (held.length) process.stdout.write(held.join(''));
  plain?.stop();
  if (tty) {
    process.stdin.setRawMode(false);
    process.stdin.off('data', onStdin);
    process.stdin.pause();
    process.stdout.off('resize', onResize);
  } else {
    process.stdin.pause();
    process.stdin.destroy();
  }
  for (const [s, h] of handlers) process.off(s, h);

  const n = result.interactions.length;
  if (!opts.quiet && n > 0) {
    const auto = result.interactions.filter((i) => i.resolvedBy === 'auto').length;
    const human = result.interactions.filter((i) => i.resolvedBy === 'human' || i.resolvedBy === 'takeover').length;
    const denied = result.interactions.filter((i) => i.resolvedBy === 'deny' || i.resolvedBy === 'cancel').length;
    if (tty) for (const rec of result.interactions) stderr(notice(rec));
    stderr(`${C.dim}[ttysage] ${n} prompt(s): ${auto} auto-answered, ${human} by a human, ${denied} denied/cancelled · exit ${result.exitCode} · audit ${audit.file}${C.reset}\n`);
  }
  if (opts.json) {
    stderr(`${JSON.stringify({ sessionId: result.sessionId, exitCode: result.exitCode, durationMs: result.durationMs, interactions: result.interactions.map((i) => ({ prompt: i.summary, decision: i.decision.decision, risk: i.decision.risk, reason: i.decision.reason, resolvedBy: i.resolvedBy, answer: i.answer })) })}\n`);
  }
  return result.exitCode;
}

// ---------------------------------------------------------------------------
// approvals / approve
// ---------------------------------------------------------------------------

function renderQueued(q: QueuedApproval, focus: number, text: string | null, index: number, total: number): string {
  const cols = process.stdout.columns || 80;
  const w = Math.min(cols - 2, 96);
  const out: string[] = [];
  out.push(`${C.bold}TtySage approval ${index + 1}/${total}${C.reset}  ${C.dim}${q.id}${C.reset}`);
  out.push(`${q.kind === 'approval' ? `${C.red}⚠ Human approval required` : `${C.cyan}✎ Input needed`}${C.reset} · risk ${C.bold}${q.risk}${C.reset}`);
  out.push(`${C.dim}Command:${C.reset} ${q.command}`);
  out.push(`${C.dim}Directory:${C.reset} ${q.cwd}`);
  if (q.intent) out.push(`${C.dim}Agent intent:${C.reset} ${q.intent}`);
  out.push('', `${C.bold}The program asks:${C.reset} ${q.question}`);
  if (q.evidence.length) {
    out.push(`${C.bold}What it said${C.reset} ${C.dim}(untrusted)${C.reset}:`);
    for (const e of q.evidence) out.push(`  ${C.yellow}•${C.reset} ${e.slice(0, w - 4)}`);
  }
  out.push(`${C.bold}Why TtySage stopped:${C.reset} ${q.reason.slice(0, w * 3)}`);
  out.push(`${C.dim}── screen ${'─'.repeat(Math.max(0, w - 10))}${C.reset}`);
  for (const l of q.screen.slice(-10)) out.push(`${C.dim}│${C.reset} ${l.slice(0, w - 2)}`);
  out.push(`${C.dim}${'─'.repeat(w)}${C.reset}`);
  if (text !== null) {
    out.push(`${C.bold}Answer:${C.reset} ${text}\x1b[7m \x1b[0m`, `${C.dim}Enter submit · Esc back${C.reset}`);
  } else {
    q.choices.forEach((c, i) => out.push(`${i === focus ? `${C.cyan}❯ ${C.bold}` : '  '}${c.label}${c.danger ? `  ${C.red}⚠${C.reset}` : ''}${C.reset}`));
    out.push('', `${C.dim}↑/↓ choose · Enter confirm · n next · q quit${C.reset}`);
  }
  return `\x1b[H\x1b[2J${out.join('\r\n')}`;
}

async function approvalsInteractive(): Promise<number> {
  const queue = new ApprovalQueue(path.join(ttysageHome(), 'approvals'));
  if (!process.stdin.isTTY) {
    const items = queue.list();
    if (!items.length) { console.log('No pending approvals.'); return 0; }
    for (const q of items) {
      console.log(`${q.id}  [${q.risk}] ${q.question}\n  ${q.command}\n  ${q.choices.map((c, i) => `${i}: ${c.label}`).join('   ')}`);
    }
    console.log('\nRespond with: ttysage approve <id> --choice <n>');
    return 0;
  }
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let idx = 0;
  let focus = 0;
  let text: string | null = null;
  let lastIds = '';
  const draw = () => {
    const items = queue.list();
    if (!items.length) {
      process.stdout.write(`\x1b[H\x1b[2J${C.bold}TtySage approvals${C.reset}\r\n\r\nNo pending approvals. Waiting… ${C.dim}(q to quit)${C.reset}`);
      return items;
    }
    idx = Math.min(idx, items.length - 1);
    const ids = items.map((i) => i.id).join();
    if (ids !== lastIds) { lastIds = ids; focus = Math.max(0, items[idx]!.choices.findIndex((c) => /^(no|cancel|abort)/i.test(c.label))); if (focus < 0) focus = 0; }
    process.stdout.write(renderQueued(items[idx]!, focus, text, idx, items.length));
    return items;
  };
  let items = draw();
  const timer = setInterval(() => { if (text === null) items = draw(); }, 700);
  return new Promise<number>((resolve) => {
    const finish = () => {
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[?1049l\x1b[?25h');
      resolve(0);
    };
    process.stdin.on('data', (b: Buffer) => {
      const s = b.toString();
      const q = items[idx];
      if (text !== null && q) {
        if (s === '\x1b') text = null;
        else if (s === '\r') { queue.respond(q.id, { text }); text = null; }
        else if (s === '\x7f') text = text.slice(0, -1);
        // eslint-disable-next-line no-control-regex
        else if (!/[\x00-\x1f]/.test(s)) text += s;
        items = draw();
        return;
      }
      if (s === 'q' || s === '\x03') return finish();
      if (!q) return;
      if (s === '\x1b[A' || s === 'k') focus = (focus + q.choices.length - 1) % q.choices.length;
      else if (s === '\x1b[B' || s === 'j') focus = (focus + 1) % q.choices.length;
      else if (s === 'n') { idx = (idx + 1) % items.length; lastIds = ''; }
      else if (s === '\r') {
        if (q.choices[focus]?.text) text = '';
        else queue.respond(q.id, { choice: focus });
      }
      items = draw();
    });
  });
}

function approveCommand(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { choice: { type: 'string' }, text: { type: 'string' }, reject: { type: 'boolean', default: false } },
  });
  const id = positionals[0];
  if (!id) throw new UsageError('approve: missing <id>');
  const queue = new ApprovalQueue(path.join(ttysageHome(), 'approvals'));
  const q = queue.get(id);
  if (!q) { stderr(`No pending approval ${id}\n`); return 1; }
  if (values.reject) {
    const cancel = q.choices.findIndex((c) => /^Cancel the command/.test(c.label));
    queue.respond(q.id, { choice: cancel });
  } else if (values.text !== undefined) {
    if (!q.allowText) { stderr('This request does not accept text.\n'); return 1; }
    queue.respond(q.id, { text: values.text });
  } else if (values.choice !== undefined) {
    const n = Number(values.choice);
    if (!Number.isInteger(n) || n < 0 || n >= q.choices.length || q.choices[n]!.text) { stderr(`Invalid choice. Options:\n${q.choices.map((c, i) => `  ${i}: ${c.label}`).join('\n')}\n`); return 1; }
    queue.respond(q.id, { choice: n });
  } else {
    stderr(`Options for ${q.id} (${q.question}):\n${q.choices.map((c, i) => `  ${i}: ${c.label}`).join('\n')}\nUse --choice <n>, --text <t> or --reject.\n`);
    return 1;
  }
  console.log(`Responded to ${q.id}.`);
  return 0;
}

function auditCommand(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { limit: { type: 'string', default: '30' }, json: { type: 'boolean', default: false } } });
  const audit = new AuditLogger();
  const events = audit.readRecent(Number(values.limit));
  if (values.json) { for (const e of events) console.log(JSON.stringify(e)); return 0; }
  for (const e of events) {
    const t = e.timestamp.replace('T', ' ').slice(0, 19);
    if (e.type === 'session_start') console.log(`${C.dim}${t}${C.reset} ${C.bold}▶ ${e.command}${C.reset} ${C.dim}(${e.mode}, ${e.cwd})${C.reset}`);
    else if (e.type === 'session_end') console.log(`${C.dim}${t}${C.reset} ■ exit ${e.exitCode} · ${e.interactions} prompt(s), ${e.autoAnswered} auto, ${e.humanAnswered} human, ${e.denied} denied · ${e.durationMs}ms`);
    else console.log(`${C.dim}${t}${C.reset}   ${e.decision.padEnd(9)} ${e.risk.padEnd(8)} ${e.promptType}: ${e.prompt} → ${e.resolvedBy}${e.answerSent ? ` (${e.answerSent})` : ''}\n${C.dim}             ${e.reason}${C.reset}`);
  }
  if (!events.length) console.log(`No audit events in ${audit.dir}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'run': return run(parseRun(rest));
    case 'approvals': return approvalsInteractive();
    case 'approve': return approveCommand(rest);
    case 'audit': return auditCommand(rest);
    case 'mcp': {
      const { startMcpServer } = await import('@ttysage/mcp-server');
      await startMcpServer();
      return new Promise<number>(() => {}); // runs until stdin closes
    }
    case '--version': case '-v': console.log(VERSION); return 0;
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return 0;
    default: throw new UsageError(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      stderr(`ttysage: ${(err as Error).message}\n\n${HELP}\n`);
      process.exit(2);
    }
    stderr(`ttysage: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(70);
  },
);
