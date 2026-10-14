import path from 'node:path';
import {
  Session, validateAction, describeAction, ActionSchema,
  type HumanChannel, type InteractionRequest, type Resolution, type InteractionRecord, type SessionResult, type Action,
} from '@ttysage/core';
import { ApprovalQueue, QueueChannel, buildChoices, type Choice } from '@ttysage/approval';
import { AuditLogger, ttysageHome } from '@ttysage/audit';
import { riskRank, POLICY, agentMayApprove, type ApprovalMode } from '@ttysage/safety';
import { interpreterFromEnv } from '@ttysage/prompt-understanding';

/**
 * Agent-facing session manager. Transport-agnostic: MCP is one adapter over it; an HTTP or SDK adapter
 * would reuse it unchanged.
 */

/**
 * A client answer to an approval dialog faster than this was not given by a person: the client
 * declined without showing a dialog (e.g. Claude Code in bypass-permissions mode).
 */
export const UNSHOWN_DIALOG_MS = 1500;

export type AgentStatus = 'running' | 'needs_input' | 'awaiting_human' | 'blocked' | 'completed';

/** Asks a human through the agent's client UI (MCP elicitation). Returns null if unsupported/failed. */
export type HumanAsker = (req: InteractionRequest, choices: Choice[]) => Promise<Resolution | null>;

interface Pending {
  req: InteractionRequest;
  who: 'agent' | 'human';
  /** For agent-answerable prompts. */
  resolve?: (r: Resolution) => void;
  approvalId?: string;
  message: string;
  /** A human-level approval handed to the agent by the operator's approval mode. */
  delegated?: boolean;
  /** Approval mode "ask-user": the agent must ask the user in its own UI and relay their exact choice. */
  askUser?: boolean;
}

export interface StartOptions {
  command: string;
  cwd?: string;
  intent?: string;
  autoAnswer?: boolean;
  cols?: number;
  rows?: number;
}

const OUTPUT_LIMIT = 12_000;

export class ManagedSession implements HumanChannel {
  readonly humanAvailable = true;
  readonly inputProviderAvailable = true;
  readonly session: Session;
  pending: Pending | null = null;
  result: SessionResult | null = null;
  lastTouched = Date.now();
  private waiters = new Set<() => void>();
  private readonly queueChannel: QueueChannel;

  constructor(
    opts: StartOptions,
    private readonly askHuman: HumanAsker | null,
    queue: ApprovalQueue,
    audit: AuditLogger,
    readonly approvalMode: ApprovalMode = 'human',
  ) {
    this.queueChannel = new QueueChannel({
      queue,
      onQueued: (q) => {
        if (this.pending) this.pending.approvalId = q.id;
        this.notify();
      },
    });
    this.session = new Session({
      command: opts.command,
      cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
      ...(opts.intent ? { intent: opts.intent } : {}),
      autoAnswer: opts.autoAnswer !== false,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      channel: this,
      interpreter: interpreterFromEnv(),
      audit,
      mode: approvalMode === 'human' ? 'mcp' : `mcp (approval mode: ${approvalMode})`,
      approvalMode,
    });
    this.session.on('interaction', () => this.notify());
    this.session.on('exit', (r) => {
      this.result = r;
      this.pending = null;
      this.notify();
    });
    this.session.start();
  }

  private notify(): void {
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  /** HumanChannel: route each request to the agent or to a human. */
  async request(req: InteractionRequest): Promise<Resolution> {
    const needsHuman = req.decision.kind === 'approval' || riskRank(req.decision.risk) >= riskRank(POLICY.humanOnlyRisk);
    if (req.prompt.type === 'password') {
      return this.waitForAgent(req, 'human',
        'The program is asking for a secret. TtySage never lets an agent or LLM type secrets. Ask the user to run this command in their own terminal (e.g. `ttysage run "<command>"`), then cancel this session with interactive_cancel.');
    }
    if (!needsHuman) {
      return this.waitForAgent(req, 'agent', 'The program needs input. Answer with interactive_respond using one of allowedActions.');
    }
    // The operator chose to let the agent approve this level of risk. Still validated and audited.
    if (agentMayApprove(this.approvalMode, req.decision, req.prompt.type)) {
      return this.waitForAgent(req, 'agent',
        `Approval delegated to you by the operator (approval mode "${this.approvalMode}"). ${req.decision.risk} risk: ${req.decision.reason} ` +
        'Answer only if it matches what the user asked for; otherwise CANCEL. Your answer is recorded in the audit log.', true);
    }
    // Human-only: try the client UI first (elicitation), then the local approval queue.
    this.pending = { req, who: 'human', message: 'Waiting for the human to approve.' };
    if (this.askHuman) {
      const { choices } = buildChoices(req, { allowTakeover: false, allowText: false });
      const asked = this.askHuman(req, choices).catch(() => null);
      // Report "awaiting_human" only once the client is plausibly showing a dialog, so a client that
      // declines without one goes straight to the fallback below.
      const settled = await Promise.race([asked.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), UNSHOWN_DIALOG_MS))]);
      if (!settled) this.notify();
      const r = await asked;
      if (r) { this.pending = null; return r; }
    } else {
      this.notify();
    }
    // The client showed no dialog: in "ask-user" mode the agent asks the user in its own UI instead.
    if (this.approvalMode === 'ask-user') {
      return this.waitForAgent(req, 'agent',
        `Human approval required (${req.decision.risk} risk: ${req.decision.reason}). Your client showed no approval dialog, so ASK THE USER NOW ` +
        'with your own question UI (e.g. AskUserQuestion): show the program\'s question, the options and the risk. Then answer with exactly ' +
        'the option the user picked, or CANCEL if they decline or do not answer. Never choose for them. Your answer is recorded in the audit log.',
        true, true);
    }
    this.pending.message = 'Human approval required. Ask the user to run `ttysage approvals` in a terminal to approve or reject, then poll interactive_status.';
    this.notify();
    const r = await this.queueChannel.request(req);
    this.pending = null;
    return r;
  }

  private waitForAgent(req: InteractionRequest, who: 'agent' | 'human', message: string, delegated = false, askUser = false): Promise<Resolution> {
    return new Promise<Resolution>((resolve) => {
      this.pending = { req, who, message, ...(delegated ? { delegated } : {}), ...(askUser ? { askUser } : {}), resolve: (r) => { this.pending = null; resolve(r); } };
      req.signal.addEventListener('abort', () => { if (this.pending?.req === req) this.pending = null; resolve({ type: 'takeover' }); }, { once: true });
      this.notify();
    });
  }

  get status(): AgentStatus {
    if (this.result) return 'completed';
    if (!this.pending) return 'running';
    if (this.pending.req.prompt.type === 'password') return 'blocked';
    return this.pending.who === 'agent' ? 'needs_input' : 'awaiting_human';
  }

  /** Wait until something needs attention or `ms` elapses. */
  async waitForAttention(ms: number): Promise<void> {
    if (this.status === 'completed') return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.waiters.delete(done); resolve(); }, ms);
      const done = () => { clearTimeout(t); resolve(); };
      this.waiters.add(done);
    });
    // A notification may fire for an auto-answered interaction while still running: keep waiting.
  }

  /** Agent answers a pending prompt. Authorization is enforced here, legality by the executor. */
  respond(raw: unknown): { ok: true } | { ok: false; error: string } {
    const p = this.pending;
    if (p && !p.resolve) {
      const a = ActionSchema.safeParse(raw);
      if (a.success && a.data.type === 'CANCEL') { void this.cancel(); return { ok: true }; }
      return { ok: false, error: 'This prompt requires a human. The only action an agent may take is CANCEL.' };
    }
    if (!p || !p.resolve) return { ok: false, error: 'Nothing is waiting for agent input.' };
    const v = validateAction(raw, p.req.prompt);
    if (!v.ok) return { ok: false, error: v.error };
    if (p.who === 'human' && v.action.type !== 'CANCEL') {
      return { ok: false, error: 'This prompt requires a human. The only action an agent may take is CANCEL.' };
    }
    if (v.action.type === 'CANCEL') { p.resolve({ type: 'cancel', by: 'agent' }); return { ok: true }; }
    p.resolve({ type: 'action', action: v.action, by: 'agent', label: describeAction(v.action, p.req.prompt) });
    return { ok: true };
  }

  async cancel(): Promise<void> {
    if (this.result) return;
    if (this.pending?.resolve) { this.pending.resolve({ type: 'cancel', by: 'agent' }); return; }
    this.session.sendKey('CTRL_C');
    await new Promise((r) => setTimeout(r, 1500));
    if (!this.result) await this.session.kill();
  }

  view(includeScreen = false): Record<string, unknown> {
    this.lastTouched = Date.now();
    const out = this.result?.output ?? this.session.outputText();
    const status = this.status;
    const view: Record<string, unknown> = {
      sessionId: this.session.id,
      status,
      approvalMode: this.approvalMode,
      command: this.session.command,
      ...(this.result ? { exitCode: this.result.exitCode, durationMs: this.result.durationMs } : {}),
      output: out.length > OUTPUT_LIMIT ? `…[truncated]\n${out.slice(-OUTPUT_LIMIT)}` : out,
      interactiveEvents: this.session.interactions.map(eventView),
    };
    if (this.pending) {
      const { req } = this.pending;
      view.pending = {
        requestId: req.id,
        who: this.pending.who,
        ...(this.pending.delegated ? { delegatedApproval: true } : {}),
        ...(this.pending.askUser ? { askUser: true } : {}),
        message: this.pending.message,
        prompt: {
          type: req.prompt.type,
          question: req.prompt.question,
          ...(req.prompt.inputLabel ? { inputLabel: req.prompt.inputLabel } : {}),
          options: req.prompt.options.map((o) => ({ index: o.index, label: o.label, ...(o.checked !== undefined ? { checked: o.checked } : {}) })),
          default: req.prompt.default,
          selectedIndex: req.prompt.selectedIndex,
          multiple: req.prompt.multiple,
        },
        decision: { decision: req.decision.decision, kind: req.decision.kind, risk: req.decision.risk, reason: req.decision.reason, ...(req.decision.llm?.summary ? { summary: req.decision.llm.summary } : {}) },
        allowedActions: allowedActions(this.pending.who, req),
        ...(this.pending.approvalId ? { approvalId: this.pending.approvalId } : {}),
      };
    }
    if (includeScreen || this.pending || status === 'running') view.screen = this.session.screenText().slice(-40);
    return view;
  }
}

function eventView(i: InteractionRecord): Record<string, unknown> {
  return {
    id: i.id, prompt: i.summary, decision: i.decision.decision, risk: i.decision.risk,
    resolvedBy: i.resolvedBy, answer: i.answer, executed: i.executed?.ok ?? false,
    ...(i.executed?.detail ? { detail: i.executed.detail } : {}), reason: i.decision.reason,
  };
}

function allowedActions(who: 'agent' | 'human', req: InteractionRequest): unknown[] {
  if (who === 'human') return [{ type: 'CANCEL' }];
  const p = req.prompt;
  const a: unknown[] = [];
  if (p.type === 'confirmation' || p.type === 'selection') {
    if (p.multiple) a.push({ type: 'SELECT_OPTIONS', optionIndices: '[number, …]' });
    else a.push({ type: 'SELECT_OPTION', optionIndex: `0..${p.options.length - 1}` });
    if (p.type === 'confirmation') a.push({ type: 'CONFIRM', value: 'yes | no' });
  } else {
    a.push({ type: 'TEXT', text: 'string', submit: true });
  }
  if (p.default !== null || p.defaultIndex !== null) a.push({ type: 'ACCEPT_DEFAULT' });
  if (['editor', 'tui', 'unknown', 'multiline'].includes(p.type)) a.push({ type: 'KEYS', keys: ['ENTER | ESCAPE | UP | DOWN | ... (allowlisted names)'] });
  a.push({ type: 'CANCEL' });
  return a;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  readonly queue: ApprovalQueue;
  readonly audit: AuditLogger;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly askHuman: HumanAsker | null = null, readonly approvalMode: ApprovalMode = 'human') {
    this.queue = new ApprovalQueue(path.join(ttysageHome(), 'approvals'));
    this.audit = new AuditLogger();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  start(opts: StartOptions): ManagedSession {
    const s = new ManagedSession(opts, this.askHuman, this.queue, this.audit, this.approvalMode);
    this.sessions.set(s.session.id, s);
    return s;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  private sweep(): void {
    for (const [id, s] of this.sessions) {
      if (s.result && Date.now() - s.lastTouched > 15 * 60_000) this.sessions.delete(id);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => (s.result ? null : s.session.kill())));
  }
}

export type { Action };
