import { z } from 'zod';
import { KEY_NAMES } from '@ttysage/pty';
import type { PromptModel, SemanticInterpreter, InterpretResult } from '@ttysage/prompt-understanding';
import {
  assessRisk, intentMismatch, isDestructive, maxRisk, riskRank, POLICY,
  type RiskOrUnknown, type RiskSignal,
} from '@ttysage/safety';

// ---------------------------------------------------------------------------
// Actions: the closed vocabulary anything (policy, human UI, agent, LLM) may request.
// The executor validates every action against the current prompt before sending keys.
// ---------------------------------------------------------------------------

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ACCEPT_DEFAULT') }),
  z.object({ type: z.literal('SELECT_OPTION'), optionIndex: z.number().int().min(0).max(500) }),
  z.object({ type: z.literal('SELECT_OPTIONS'), optionIndices: z.array(z.number().int().min(0).max(500)).max(100) }),
  z.object({ type: z.literal('CONFIRM'), value: z.enum(['yes', 'no']) }),
  z.object({ type: z.literal('TEXT'), text: z.string().max(4096), submit: z.boolean().default(true) }),
  z.object({ type: z.literal('KEYS'), keys: z.array(z.enum(KEY_NAMES)).min(1).max(64) }),
  z.object({ type: z.literal('CANCEL') }),
]);
export type Action = z.infer<typeof ActionSchema>;

export function describeAction(a: Action, prompt?: PromptModel | null): string {
  switch (a.type) {
    case 'ACCEPT_DEFAULT': return `accept default${prompt?.default ? ` (${prompt.default})` : ''}`;
    case 'SELECT_OPTION': return `select option ${a.optionIndex}${prompt?.options[a.optionIndex] ? ` (${prompt.options[a.optionIndex]!.label})` : ''}`;
    case 'SELECT_OPTIONS': return `select options [${a.optionIndices.join(', ')}]`;
    case 'CONFIRM': return `answer ${a.value}`;
    case 'TEXT': return prompt?.type === 'password' ? 'type [REDACTED]' : `type ${JSON.stringify(a.text.slice(0, 80))}`;
    case 'KEYS': return `keys ${a.keys.join(' ')}`;
    case 'CANCEL': return 'cancel (Ctrl+C)';
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type DecisionKind = 'AUTO' | 'ASK_HUMAN' | 'DENY';
/** approval: consequences need a human's consent. input: the program needs information. */
export type AskKind = 'approval' | 'input';

export interface Decision {
  decision: DecisionKind;
  kind: AskKind;
  action?: Action;
  /** Human-readable answer for AUTO decisions. */
  answer?: string;
  risk: RiskOrUnknown;
  confidence: number;
  reason: string;
  signals: RiskSignal[];
  injection: boolean;
  intentMismatch: boolean;
  destructive: boolean;
  llm?: {
    used: boolean;
    model?: string;
    risk?: RiskOrUnknown;
    confidence?: number;
    summary?: string;
    consequences?: string[];
    intentAlignment?: string;
    reason?: string;
    error?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface DecisionContext {
  command: string;
  cwd: string;
  intent?: string;
  /** Whether automatic answers are allowed at all (user flag). */
  autoAnswer?: boolean;
  /** Is there a human who can approve (TTY dialog, MCP elicitation, approval queue)? */
  humanAvailable?: boolean;
  /** Is there someone (human or calling agent) who can supply ordinary input? */
  inputProviderAvailable?: boolean;
  /** How many times this exact prompt instance was already answered automatically. */
  previousAutoAttempts?: number;
  interpreter?: SemanticInterpreter | null;
  signal?: AbortSignal;
}

function topSignals(signals: RiskSignal[], n = 3): string {
  const seen = new Set<string>();
  return [...signals]
    .sort((a, b) => riskRank(b.level) - riskRank(a.level))
    .map((s) => `${s.category} ("${s.match.trim()}")`)
    .filter((t) => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true)))
    .slice(0, n)
    .join(', ');
}

function intentOptionMatch(intent: string, prompt: PromptModel): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const hay = ` ${norm(intent)} `;
  const has = (needle: string) => needle.length >= 2 && new RegExp(`(?:^|[\\s(])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s),.])`).test(hay);
  const full = prompt.options.map((o, i) => (has(norm(o.label)) ? i : -1)).filter((i) => i !== -1);
  if (full.length === 1) return full[0]!;
  if (full.length > 1) return null;
  const first = prompt.options
    .map((o, i) => {
      const w = norm(o.label).split(' ').find((t) => t.length >= 3);
      return w && has(w) ? i : -1;
    })
    .filter((i) => i !== -1);
  return first.length === 1 ? first[0]! : null;
}

function sameAction(a: Action, b: { type: string; optionIndex: number | null }, prompt: PromptModel): boolean {
  if (a.type === 'ACCEPT_DEFAULT') {
    return b.type === 'ACCEPT_DEFAULT' || (b.type === 'SELECT_OPTION' && b.optionIndex === prompt.defaultIndex);
  }
  if (a.type === 'SELECT_OPTION') {
    return (b.type === 'SELECT_OPTION' && b.optionIndex === a.optionIndex) ||
      (b.type === 'ACCEPT_DEFAULT' && prompt.defaultIndex === a.optionIndex);
  }
  return false;
}

interface Draft {
  decision: Decision;
  /** Candidate AUTO action that still needs LLM agreement (if an LLM is configured). */
  pendingAuto?: Action;
  /** Preference selection where only an LLM could map intent → option. */
  llmMayChoose?: boolean;
}

/** The deterministic policy. Never calls the network. */
export function decideDeterministic(prompt: PromptModel, ctx: DecisionContext): Draft {
  const options = prompt.options.map((o) => o.label);
  // In an editor the buffer is content being authored (often full of help comments), not the
  // program's consequence statement: judge an editor session by its command.
  const assessment = prompt.type === 'editor'
    ? assessRisk({ command: ctx.command })
    : assessRisk({ command: ctx.command, question: [prompt.question, prompt.inputLabel].filter(Boolean).join(' '), options, context: prompt.context });
  const injection = assessment.injection.length > 0;
  const signals = [...assessment.signals, ...assessment.injection];
  const mismatch = intentMismatch(ctx.intent, assessment.signals);
  const destructive = isDestructive(assessment.signals);
  const conf = prompt.detection.confidence;
  let risk: RiskOrUnknown = assessment.level;
  const choiceLike = prompt.type === 'confirmation' || prompt.type === 'selection';

  const base = (over: Partial<Decision> & Pick<Decision, 'decision' | 'reason'>): Decision => ({
    kind: 'input',
    risk,
    confidence: conf,
    signals,
    injection,
    intentMismatch: mismatch,
    destructive,
    ...over,
  });
  const askKind = (r: RiskOrUnknown): AskKind =>
    riskRank(r) >= riskRank(POLICY.humanOnlyRisk) || (choiceLike && riskRank(r) >= riskRank('MEDIUM')) ? 'approval' : 'input';

  // 1. Not confidently interactive ⇒ never answer.
  if (prompt.detection.interactive !== true || prompt.type === 'unknown') {
    risk = maxRisk(risk, 'UNKNOWN');
    return { decision: base({ decision: 'ASK_HUMAN', kind: riskRank(risk) >= riskRank('HIGH') ? 'approval' : 'input', risk, reason: 'Unable to confidently determine what the program is waiting for; TtySage will not guess.' }) };
  }
  // 2. Prompt-injection markers in untrusted output.
  if (injection) {
    risk = maxRisk(risk, 'HIGH');
    return { decision: base({ decision: 'ASK_HUMAN', kind: 'approval', risk, reason: `Terminal output contains text that tries to instruct an AI/automation (${assessment.injection[0]!.match}); treated as hostile, human approval required.` }) };
  }
  // 3. Secrets are never typed by automation.
  if (prompt.type === 'password') {
    risk = maxRisk(risk, 'MEDIUM');
    return { decision: base({ decision: 'ASK_HUMAN', kind: riskRank(risk) >= riskRank('HIGH') ? 'approval' : 'input', risk, reason: 'The program is asking for a secret. TtySage never types secrets automatically.' }) };
  }
  // 4. Free-form interaction surfaces (incl. a nested shell / REPL: arbitrary command execution).
  if (prompt.style === 'shell') {
    risk = maxRisk(risk, 'MEDIUM');
    return { decision: base({ decision: 'ASK_HUMAN', kind: askKind(risk), risk, reason: 'An interactive shell/REPL is waiting for commands; anything typed there runs as code.' }) };
  }
  if (prompt.type === 'editor' || prompt.type === 'tui' || prompt.type === 'multiline') {
    risk = maxRisk(risk, prompt.type === 'multiline' ? 'LOW' : 'MEDIUM');
    return { decision: base({ decision: 'ASK_HUMAN', kind: askKind(risk), risk, reason: `The program opened a free-form ${prompt.type} interaction; it needs a human (or the agent) to drive it.` }) };
  }
  // 5. Any consequence signal ⇒ human.
  if (assessment.level !== 'LOW') {
    const why = `${mismatch ? 'The prompt implies destructive effects the agent intent did not ask for. ' : ''}Risk signals: ${topSignals(assessment.signals)}.`;
    return { decision: base({ decision: 'ASK_HUMAN', kind: askKind(risk), reason: `${risk} risk. ${why}${risk === 'CRITICAL' ? ' Destructive operations are never auto-approved.' : ''}` }) };
  }
  // 6. The same prompt instance came back after an automatic answer.
  if ((ctx.previousAutoAttempts ?? 0) > 0) {
    return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', risk: 'UNKNOWN', reason: 'An automatic answer did not resolve this prompt (it was asked again); escalating instead of retrying.' }) };
  }
  if (conf < POLICY.autoMinDetectionConfidence) {
    return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', risk: 'UNKNOWN', reason: `Prompt detected with low confidence (${conf.toFixed(2)}); TtySage will not guess.` }) };
  }
  if (ctx.autoAnswer === false) {
    return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', reason: 'Automatic answers are disabled.' }) };
  }

  // 7. LOW risk, confident. Only answers TtySage does not have to invent.
  if (prompt.type === 'confirmation') {
    if (prompt.defaultIndex !== null && !prompt.typedText) {
      const action: Action = { type: 'ACCEPT_DEFAULT' };
      return { pendingAuto: action, decision: base({ decision: 'AUTO', action, answer: prompt.default ?? 'default', reason: 'Low-risk confirmation; accepting the program\'s own default.' }) };
    }
    return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', reason: 'Confirmation without a default; TtySage will not guess the answer.' }) };
  }
  if (prompt.type === 'selection') {
    if (prompt.multiple) {
      return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', reason: 'Multi-select prompt; choices are a preference TtySage will not invent.' }) };
    }
    if (ctx.intent) {
      const idx = intentOptionMatch(ctx.intent, prompt);
      if (idx !== null) {
        const action: Action = { type: 'SELECT_OPTION', optionIndex: idx };
        return { pendingAuto: action, decision: base({ decision: 'AUTO', action, answer: prompt.options[idx]!.label, reason: `Low-risk selection; the agent intent names "${prompt.options[idx]!.label}".` }) };
      }
      return { llmMayChoose: true, decision: base({ decision: 'ASK_HUMAN', kind: 'input', reason: 'Preference choice; the agent intent does not name one of the options.' }) };
    }
    return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', reason: 'Preference choice with no agent intent; TtySage will not pick for you.' }) };
  }
  // text
  if (prompt.default !== null && prompt.typedText === '') {
    const action: Action = { type: 'ACCEPT_DEFAULT' };
    return { pendingAuto: action, decision: base({ decision: 'AUTO', action, answer: prompt.default, reason: 'Low-risk text prompt; accepting the program\'s default value.' }) };
  }
  return { decision: base({ decision: 'ASK_HUMAN', kind: 'input', reason: 'Text input without a default; the value must come from a human or the agent.' }) };
}

function applyAvailability(d: Decision, ctx: DecisionContext, prompt: PromptModel): Decision {
  if (d.decision !== 'ASK_HUMAN') return d;
  const needsHuman = d.kind === 'approval' || prompt.type === 'password';
  if (needsHuman && ctx.humanAvailable === false) {
    return { ...d, decision: 'DENY', reason: `${d.reason} No human is available to approve, so TtySage refuses to answer.` };
  }
  if (!needsHuman && ctx.humanAvailable === false && ctx.inputProviderAvailable === false) {
    return { ...d, decision: 'DENY', reason: `${d.reason} Nobody is available to provide input.` };
  }
  return d;
}

function llmInput(prompt: PromptModel, ctx: DecisionContext, d: Decision) {
  const sel = prompt.selectedIndex !== null ? prompt.options[prompt.selectedIndex]?.label ?? null : null;
  return {
    command: ctx.command,
    cwd: ctx.cwd,
    ...(ctx.intent ? { intent: ctx.intent } : {}),
    prompt: { type: prompt.type, question: prompt.question, options: prompt.options.map((o) => o.label), selectedOption: sel, default: prompt.default },
    screen: prompt.context.slice(-40),
    deterministic: {
      risk: (d.risk === 'UNKNOWN' ? 'MEDIUM' : d.risk) as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
      signals: d.signals.map((s) => ({ category: s.category, level: s.level, match: s.match })),
    },
  };
}

function llmInfo(r: InterpretResult): NonNullable<Decision['llm']> {
  return {
    used: true,
    model: r.model,
    risk: r.assessment.risk,
    confidence: r.assessment.confidence,
    summary: r.assessment.summary,
    consequences: r.assessment.consequences,
    intentAlignment: r.assessment.intentAlignment,
    reason: r.assessment.reason,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  };
}

/**
 * Full decision: deterministic floor, then (optionally) one LLM call that may only add caution,
 * explain consequences to the human, or map an explicit intent onto a low-risk preference choice.
 */
export async function decide(prompt: PromptModel, ctx: DecisionContext): Promise<Decision> {
  const draft = decideDeterministic(prompt, ctx);
  let d = draft.decision;
  const interp = ctx.interpreter;
  const wantsLlm = !!interp && (draft.pendingAuto !== undefined || draft.llmMayChoose || (d.decision === 'ASK_HUMAN' && d.kind === 'approval'));
  if (!interp || !wantsLlm) return applyAvailability(d, ctx, prompt);

  let result: InterpretResult;
  try {
    result = await interp.interpret(llmInput(prompt, ctx, d), ctx.signal);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (d.decision === 'AUTO') {
      // Fail closed: if the configured second opinion is unavailable, do not automate.
      d = { ...d, decision: 'ASK_HUMAN', kind: 'input', action: undefined, answer: undefined, reason: `${d.reason} However the semantic check failed (${error}); asking instead.` };
    }
    return applyAvailability({ ...d, llm: { used: false, error } }, ctx, prompt);
  }
  const a = result.assessment;
  const info = llmInfo(result);
  const combinedRisk = maxRisk(d.risk, a.risk);

  if (draft.pendingAuto) {
    const agrees =
      a.risk === 'LOW' && a.confidence >= POLICY.autoMinLlmConfidence && a.intentAlignment !== 'mismatch' && !a.destructive &&
      sameAction(draft.pendingAuto, a.recommendedAction, prompt);
    if (agrees) return { ...d, llm: info };
    return applyAvailability({
      ...d,
      decision: 'ASK_HUMAN',
      kind: combinedRisk === 'LOW' || combinedRisk === 'UNKNOWN' ? 'input' : riskRank(combinedRisk) >= riskRank('MEDIUM') && (prompt.type === 'confirmation' || prompt.type === 'selection') ? 'approval' : riskRank(combinedRisk) >= riskRank('HIGH') ? 'approval' : 'input',
      action: undefined,
      answer: undefined,
      risk: combinedRisk,
      destructive: d.destructive || a.destructive,
      intentMismatch: d.intentMismatch || a.intentAlignment === 'mismatch',
      reason: `Semantic check did not confirm the automatic answer: ${a.reason}`,
      llm: info,
    }, ctx, prompt);
  }
  if (draft.llmMayChoose) {
    const idx = a.recommendedAction.optionIndex;
    if (
      a.risk === 'LOW' && a.confidence >= POLICY.autoMinDetectionConfidence && a.intentAlignment === 'aligned' && !a.destructive &&
      a.recommendedAction.type === 'SELECT_OPTION' && idx !== null && idx < prompt.options.length
    ) {
      const action: Action = { type: 'SELECT_OPTION', optionIndex: idx };
      return { ...d, decision: 'AUTO', action, answer: prompt.options[idx]!.label, reason: `Low-risk preference choice mapped from the agent intent: ${a.reason}`, llm: info };
    }
    return applyAvailability({ ...d, risk: combinedRisk, llm: info }, ctx, prompt);
  }
  // Approval: LLM explains, and may raise (never lower) risk.
  return applyAvailability({ ...d, risk: combinedRisk, destructive: d.destructive || a.destructive, intentMismatch: d.intentMismatch || a.intentAlignment === 'mismatch', llm: info }, ctx, prompt);
}
