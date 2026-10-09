import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { PtyProcess, keySequence, type KeyName, type ExitInfo } from '@ttysage/pty';
import { HeadlessTerminal, type ScreenSnapshot } from '@ttysage/terminal';
import { detect, type Detection } from '@ttysage/detector';
import { understand, describePrompt, type PromptModel, type SemanticInterpreter } from '@ttysage/prompt-understanding';
import { decide, describeAction, type Action, type Decision } from '@ttysage/decision-engine';
import { POLICY } from '@ttysage/safety';
import type { AuditLogger } from '@ttysage/audit';
import { executeAction, validateAction, type ExecutionResult } from './executor';

// ---------------------------------------------------------------------------
// Human channel: how a session reaches whoever can answer (TTY human, MCP agent, approval queue).
// ---------------------------------------------------------------------------

export type ResolvedBy = 'auto' | 'human' | 'agent' | 'takeover' | 'cancel' | 'deny';

export type Resolution =
  /** Send this (validated) action. */
  | { type: 'action'; action: Action; by: 'human' | 'agent'; label?: string }
  /** A human answers directly in the terminal; TtySage steps aside for this prompt. */
  | { type: 'takeover' }
  /** Abort the command (Ctrl+C). */
  | { type: 'cancel'; by: 'human' | 'agent' | 'system'; reason?: string };

export interface InteractionRequest {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  intent?: string;
  prompt: PromptModel;
  decision: Decision;
  /** Current visible screen (untrusted). */
  screen: string[];
  /** Aborted when the process exits or the prompt disappears. */
  signal: AbortSignal;
  /** Set when a previous attempt for this prompt failed. */
  note?: string;
}

export interface HumanChannel {
  readonly humanAvailable: boolean;
  /** Can someone (human or agent) supply ordinary input? */
  readonly inputProviderAvailable: boolean;
  request(req: InteractionRequest): Promise<Resolution>;
}

export interface InteractionRecord {
  id: string;
  at: string;
  prompt: Omit<PromptModel, 'context'>;
  summary: string;
  decision: Omit<Decision, 'signals'> & { signals: string[] };
  resolvedBy: ResolvedBy;
  answer: string | null;
  executed: ExecutionResult | null;
  latencyMs: number;
}

export interface SessionOptions {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  intent?: string;
  autoAnswer?: boolean;
  channel: HumanChannel;
  interpreter?: SemanticInterpreter | null;
  audit?: AuditLogger | null;
  /** Output quiescence before the screen is analysed. */
  quiescenceMs?: number;
  /** Free-form label for audit ("cli-tty", "mcp", ...). */
  mode?: string;
}

export interface SessionResult {
  sessionId: string;
  exitCode: number;
  signal: number | null;
  durationMs: number;
  /** Rendered terminal text (what a human would have seen), not raw bytes. */
  output: string;
  interactions: InteractionRecord[];
}

export type SessionState = 'running' | 'deciding' | 'awaiting' | 'executing' | 'exited';

export interface SessionEvents {
  data: [string];
  interaction: [InteractionRecord];
  request: [InteractionRequest];
  state: [SessionState];
  exit: [SessionResult];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Session extends EventEmitter<SessionEvents> {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly intent?: string;
  readonly startedAt = Date.now();
  readonly interactions: InteractionRecord[] = [];

  private readonly opts: SessionOptions;
  private readonly term: HeadlessTerminal;
  private pty: PtyProcess | null = null;
  private _state: SessionState = 'running';
  private lastOutputAt = Date.now();
  private lastHumanInputAt = 0;
  private analysisTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private screenVersion = 0;
  private settleWaiters: (() => void)[] = [];
  /** Prompt instance (fingerprint@anchor) handled by human/takeover — skip while it stays on screen. */
  private activeKey: string | null = null;
  /** Prompt instance we answered with an action — seeing it again means the answer failed. */
  private lastAnswered: { key: string; by: ResolvedBy } | null = null;
  /** Absolute buffer line where the next interaction's context starts. */
  private contextFrom = 0;
  private interactionSeq = 0;
  private currentAbort: AbortController | null = null;
  private result: SessionResult | null = null;
  private readonly done: Promise<SessionResult>;
  private resolveDone!: (r: SessionResult) => void;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    this.id = randomBytes(4).toString('hex');
    this.command = opts.command;
    this.cwd = opts.cwd ?? process.cwd();
    if (opts.intent) this.intent = opts.intent;
    this.term = new HeadlessTerminal({ cols: opts.cols ?? 120, rows: opts.rows ?? 40 });
    this.done = new Promise((r) => { this.resolveDone = r; });
  }

  get state(): SessionState { return this._state; }
  get pid(): number | null { return this.pty?.pid ?? null; }
  get exited(): boolean { return this._state === 'exited'; }

  private setState(s: SessionState): void {
    if (this._state === 'exited') return;
    this._state = s;
    this.emit('state', s);
  }

  start(): this {
    if (this.pty) return this;
    this.pty = new PtyProcess({
      command: this.opts.command,
      cwd: this.cwd,
      env: this.opts.env,
      cols: this.term.cols,
      rows: this.term.rows,
    });
    this.opts.audit?.log({
      type: 'session_start', timestamp: new Date().toISOString(), sessionId: this.id, command: this.command,
      cwd: this.cwd, ...(this.intent ? { intent: this.intent } : {}), pid: this.pty.pid, mode: this.opts.mode ?? 'sdk',
    });
    this.pty.onData((d) => this.onData(d));
    void this.pty.exit.then((e) => this.onExit(e));
    return this;
  }

  wait(): Promise<SessionResult> {
    return this.done;
  }

  // ---- I/O -----------------------------------------------------------------

  private onData(data: string): void {
    this.lastOutputAt = Date.now();
    this.emit('data', data);
    void this.term.write(data).then(() => {
      this.screenVersion++;
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      for (const w of waiters) w();
      this.schedule(this.opts.quiescenceMs ?? 300);
    });
  }

  /** Human keystrokes from a real terminal (passthrough). Suppresses automation briefly. */
  writeHuman(data: string): void {
    this.lastHumanInputAt = Date.now();
    this.pty?.write(data);
  }

  sendKey(key: KeyName): void {
    this.pty?.write(keySequence(key, { applicationCursorKeys: this.term.snapshot().applicationCursorKeys }));
  }

  private sendText(text: string): void {
    this.pty?.write(text);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    this.pty?.resize(cols, rows);
    this.schedule(this.opts.quiescenceMs ?? 300);
  }

  snapshot(): ScreenSnapshot {
    return this.term.snapshot();
  }

  /** Visible screen as text (trailing blank lines removed). */
  screenText(): string[] {
    const lines = [...this.term.snapshot().lines];
    while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines;
  }

  /**
   * Rendered lines of the normal buffer from absolute row `from` up to `to` (default: everything).
   * Rows that scrolled off the screen (`scrollbackRows()`) can no longer change.
   */
  renderedSince(from: number, to?: number): { lines: string[]; next: number } {
    return this.term.normalRows(from, to);
  }

  scrollbackRows(): number {
    return this.term.normalScrollback();
  }

  outputText(): string {
    return this.term.fullText();
  }

  /** Kill the process tree. */
  async kill(): Promise<void> {
    this.currentAbort?.abort();
    await this.pty?.terminate();
  }

  // ---- Analysis loop -------------------------------------------------------

  private schedule(ms: number): void {
    if (this.exited) return;
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    this.analysisTimer = setTimeout(() => {
      this.analysisTimer = null;
      void this.analyze();
    }, ms);
  }

  /** Detect on the current screen. Exposed for adapters (e.g. "what is on screen right now?"). */
  async currentPrompt(): Promise<{ detection: Detection; prompt: PromptModel | null }> {
    await this.term.flush();
    const snap = this.term.snapshot();
    const detection = detect(snap, { idleMs: Date.now() - this.lastOutputAt, processAlive: !this.exited });
    const prompt = understand(detection, snap, { contextLines: this.term.textSince(this.contextFrom) });
    return { detection, prompt };
  }

  private async analyze(): Promise<void> {
    if (this.exited || this.busy) return;
    const { detection, prompt } = await this.currentPrompt();
    if (detection.interactive === false || !prompt) {
      if (detection.recheckAfterMs) this.schedule(detection.recheckAfterMs);
      // A prompt we stepped aside for has gone: forget it.
      if (!detection.signals.includes('awaiting-stability')) this.activeKey = null;
      return;
    }
    const key = `${prompt.fingerprint}@${prompt.anchorLine}`;
    if (key === this.activeKey) return;
    const reasked = this.lastAnswered?.key === key && this.lastAnswered.by === 'auto';
    this.busy = true;
    try {
      await this.handle(prompt, key, reasked);
    } catch (err) {
      // Never crash the user's command because of an analysis bug: step aside.
      this.activeKey = key;
      process.emitWarning(`ttysage: interaction handling failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
      if (!this.exited) {
        this.setState('running');
        this.schedule(this.opts.quiescenceMs ?? 300);
      }
    }
  }

  private async handle(prompt: PromptModel, key: string, reasked: boolean): Promise<void> {
    const started = Date.now();
    const id = `${this.id}-${++this.interactionSeq}`;
    const channel = this.opts.channel;
    this.setState('deciding');
    const abort = new AbortController();
    this.currentAbort = abort;
    const humanActive = Date.now() - this.lastHumanInputAt < POLICY.humanActivityWindowMs;
    let decision = await decide(prompt, {
      command: this.command,
      cwd: this.cwd,
      ...(this.intent ? { intent: this.intent } : {}),
      autoAnswer: this.opts.autoAnswer !== false && !humanActive,
      humanAvailable: channel.humanAvailable,
      inputProviderAvailable: channel.inputProviderAvailable,
      previousAutoAttempts: reasked ? 1 : 0,
      interpreter: this.opts.interpreter ?? null,
      signal: abort.signal,
    });
    if (this.exited) return;

    let resolution: Resolution;
    let resolvedBy: ResolvedBy;
    if (decision.decision === 'AUTO' && decision.action) {
      resolution = { type: 'action', action: decision.action, by: 'human' };
      resolvedBy = 'auto';
    } else if (decision.decision === 'DENY') {
      resolution = { type: 'cancel', by: 'system', reason: decision.reason };
      resolvedBy = 'deny';
    } else {
      this.setState('awaiting');
      const req: InteractionRequest = {
        id, sessionId: this.id, command: this.command, cwd: this.cwd,
        ...(this.intent ? { intent: this.intent } : {}),
        prompt, decision, screen: this.screenText(), signal: abort.signal,
        ...(reasked ? { note: 'The previous automatic answer did not resolve this prompt.' } : {}),
      };
      this.emit('request', req);
      // If the screen changes to a different prompt (e.g. a human typed in the terminal), stop waiting.
      const watcher = this.watchPromptGone(key, abort);
      try {
        resolution = await channel.request(req);
      } catch (err) {
        resolution = abort.signal.aborted ? { type: 'takeover' } : { type: 'cancel', by: 'system', reason: (err as Error).message };
      } finally {
        watcher();
      }
      resolvedBy = resolution.type === 'takeover' ? 'takeover' : resolution.type === 'cancel' ? 'cancel' : resolution.by;
    }
    if (this.exited) return;

    // Execute.
    let executed: ExecutionResult | null = null;
    let answer: string | null = null;
    this.setState('executing');
    if (resolution.type === 'action') {
      // Re-validate against the *current* screen (it may have changed while we waited).
      const fresh = (await this.currentPrompt()).prompt;
      const target = fresh && fresh.fingerprint === prompt.fingerprint ? fresh : prompt;
      const valid = validateAction(resolution.action, target);
      if (!valid.ok) {
        executed = { ok: false, detail: valid.error };
      } else {
        answer = resolution.label ?? describeAction(valid.action, target);
        executed = await executeAction(this.executionTarget(), target, valid.action);
      }
      if (executed.ok) this.lastAnswered = { key, by: resolvedBy };
      else this.activeKey = resolvedBy === 'auto' ? null : key;
      if (!executed.ok && resolvedBy === 'auto') {
        // Never retry blindly: turn it into a human question next round.
        this.lastAnswered = { key, by: 'auto' };
      }
    } else if (resolution.type === 'cancel') {
      answer = 'cancel (Ctrl+C)';
      this.sendKey('CTRL_C');
      executed = { ok: true, detail: resolution.reason ? `sent Ctrl+C: ${resolution.reason}` : 'sent Ctrl+C' };
      this.activeKey = key;
      if (resolvedBy === 'deny') decision = { ...decision, decision: 'DENY' };
    } else {
      this.activeKey = key;
    }
    this.contextFrom = this.term.absoluteCursorLine();
    this.record(id, prompt, decision, resolvedBy, answer, executed, Date.now() - started);
  }

  private watchPromptGone(key: string, abort: AbortController): () => void {
    let stopped = false;
    const tick = async (): Promise<void> => {
      while (!stopped && !abort.signal.aborted && !this.exited) {
        await sleep(400);
        if (stopped) return;
        if (Date.now() - this.lastHumanInputAt > 5000) continue; // only react to human activity
        const { detection, prompt } = await this.currentPrompt();
        if (detection.interactive === false && detection.signals.includes('awaiting-stability')) continue;
        const k = prompt ? `${prompt.fingerprint}@${prompt.anchorLine}` : null;
        if (k !== key) { abort.abort(); return; }
      }
    };
    void tick();
    return () => { stopped = true; };
  }

  private executionTarget() {
    return {
      sendKey: (k: KeyName) => this.sendKey(k),
      sendText: (t: string) => this.sendText(t),
      settle: async (timeoutMs = 500): Promise<PromptModel | null> => {
        const v = this.screenVersion;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, timeoutMs);
          this.settleWaiters.push(() => { clearTimeout(t); resolve(); });
        });
        // Let the redraw finish (renderers often write in several chunks).
        let last = this.screenVersion;
        for (let i = 0; i < 10; i++) {
          await sleep(40);
          if (this.screenVersion === last) break;
          last = this.screenVersion;
        }
        void v;
        await this.term.flush();
        const snap = this.term.snapshot();
        const d = detect(snap, { idleMs: 100_000, processAlive: !this.exited });
        return understand(d, snap);
      },
    };
  }

  private record(
    id: string, prompt: PromptModel, decision: Decision, resolvedBy: ResolvedBy, answer: string | null,
    executed: ExecutionResult | null, latencyMs: number,
  ): void {
    const { context: _ctx, ...promptLite } = prompt;
    void _ctx;
    const rec: InteractionRecord = {
      id,
      at: new Date().toISOString(),
      prompt: promptLite,
      summary: describePrompt(prompt),
      decision: { ...decision, signals: decision.signals.map((s) => `${s.level}:${s.category}:${s.match}`) },
      resolvedBy,
      answer,
      executed,
      latencyMs,
    };
    this.interactions.push(rec);
    this.emit('interaction', rec);
    this.opts.audit?.log({
      type: 'interaction',
      timestamp: rec.at,
      sessionId: this.id,
      command: this.command,
      interactionId: id,
      ...(this.intent ? { intent: this.intent } : {}),
      prompt: prompt.question || prompt.inputLabel || '',
      promptType: prompt.type,
      options: prompt.options.map((o) => o.label),
      default: prompt.default,
      detectionConfidence: prompt.detection.confidence,
      decision: decision.decision,
      kind: decision.kind,
      risk: decision.risk,
      confidence: decision.confidence,
      reason: decision.reason,
      signals: rec.decision.signals,
      injection: decision.injection,
      intentMismatch: decision.intentMismatch,
      llmUsed: decision.llm?.used === true,
      resolvedBy,
      ...(resolvedBy === 'human' ? { humanDecision: answer ?? undefined } : {}),
      answerSent: answer,
      executed: executed?.ok ?? false,
      ...(executed ? { executionDetail: executed.detail } : {}),
      latencyMs,
    });
  }

  private async onExit(e: ExitInfo): Promise<void> {
    if (this.analysisTimer) clearTimeout(this.analysisTimer);
    this.currentAbort?.abort();
    await this.term.flush();
    this._state = 'exited';
    this.emit('state', 'exited');
    const result: SessionResult = {
      sessionId: this.id,
      exitCode: e.exitCode,
      signal: e.signal,
      durationMs: Date.now() - this.startedAt,
      output: this.term.fullText(),
      interactions: this.interactions,
    };
    this.result = result;
    this.opts.audit?.log({
      type: 'session_end',
      timestamp: new Date().toISOString(),
      sessionId: this.id,
      command: this.command,
      exitCode: e.exitCode,
      signal: e.signal,
      durationMs: result.durationMs,
      interactions: this.interactions.length,
      autoAnswered: this.interactions.filter((i) => i.resolvedBy === 'auto').length,
      humanAnswered: this.interactions.filter((i) => i.resolvedBy === 'human' || i.resolvedBy === 'takeover').length,
      denied: this.interactions.filter((i) => i.resolvedBy === 'deny').length,
    });
    this.pty?.dispose();
    this.emit('exit', result);
    this.resolveDone(result);
  }

  get finalResult(): SessionResult | null {
    return this.result;
  }
}

export function hashScreen(lines: string[]): string {
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
}
