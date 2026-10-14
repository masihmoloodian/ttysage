/**
 * Trusted safety policy primitives. Nothing here knows about any specific CLI: the lexicon describes
 * *consequences* (data loss, deletion, deployment, credentials...) in generic language.
 */

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type RiskOrUnknown = RiskLevel | 'UNKNOWN';

export function riskRank(r: RiskOrUnknown): number {
  // UNKNOWN ranks between MEDIUM and HIGH for "max" purposes: it always blocks AUTO.
  return { LOW: 0, MEDIUM: 1, UNKNOWN: 1.5, HIGH: 2, CRITICAL: 3 }[r];
}
export function maxRisk(a: RiskOrUnknown, b: RiskOrUnknown): RiskOrUnknown {
  return riskRank(a) >= riskRank(b) ? a : b;
}

export type RiskCategory =
  | 'data-loss' | 'deletion' | 'irreversible' | 'schema-change' | 'infrastructure' | 'deployment'
  | 'credentials' | 'permissions' | 'history-rewrite' | 'overwrite' | 'cost' | 'privacy'
  | 'warning' | 'remote-code' | 'state-change' | 'injection';

export type TextSource = 'command' | 'question' | 'option' | 'context' | 'intent';

export interface RiskSignal {
  category: RiskCategory;
  level: RiskLevel;
  source: TextSource;
  match: string;
  /** The line the match came from (redacted, truncated). */
  line: string;
}

interface Rule {
  re: RegExp;
  category: RiskCategory;
  level: RiskLevel;
  /** Restrict where the rule applies (default: everywhere except intent). */
  sources?: TextSource[];
}

const DB_NOUN = '(?:table|column|database|schema|index|constraint|collection|row|record|data|enum|view|bucket|volume|cluster)s?';

const RULES: Rule[] = [
  // --- CRITICAL: data loss / irreversible / destruction -------------------------------------
  { re: /\bdata[\s-]+loss\b/i, category: 'data-loss', level: 'CRITICAL' },
  { re: /\b(?:will|may|might|could|would)\s+(?:be\s+)?(?:permanently\s+)?(?:lose|lost|erased?|wiped?|destroyed|deleted|truncated|dropped)\b/i, category: 'data-loss', level: 'CRITICAL' },
  { re: /\b(?:lose|losing)\s+(?:all\s+)?(?:\w+\s+){0,2}(?:data|changes|work|rows|records|files)\b/i, category: 'data-loss', level: 'CRITICAL' },
  { re: new RegExp(`\\bdrop(?:s|ping|ped)?\\b[^\\n]{0,40}\\b${DB_NOUN}\\b`, 'i'), category: 'data-loss', level: 'CRITICAL' },
  { re: new RegExp(`\\b${DB_NOUN}\\b[^\\n]{0,40}\\b(?:dropped|drop)\\b`, 'i'), category: 'data-loss', level: 'CRITICAL' },
  { re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|COLUMN|INDEX|VIEW)\b/, category: 'data-loss', level: 'CRITICAL' },
  { re: /\btruncat(?:e|es|ed|ing)\b/i, category: 'data-loss', level: 'CRITICAL' },
  { re: /\bdestr(?:oy|oys|oyed|oying|uction|uctive)\b/i, category: 'irreversible', level: 'CRITICAL' },
  { re: /\b(?:irreversibl[ey]|cannot\s+be\s+(?:undone|reversed|recovered)|can(?:'|no)t\s+be\s+undone|not\s+(?:be\s+)?reversible|unrecoverable|permanently)\b/i, category: 'irreversible', level: 'CRITICAL' },
  { re: /\b(?:wipe|wiping|wiped|purge|purging|purged|erase|erasing|nuke)\b/i, category: 'deletion', level: 'CRITICAL' },
  { re: /\b(?:delete|deleting|remove|removing)\s+(?:all|every|existing|everything|the\s+entire)\b/i, category: 'deletion', level: 'CRITICAL' },
  { re: /\breset(?:ting)?\b[^\n]{0,30}\b(?:database|db|data|schema|--hard|hard|everything|all)\b/i, category: 'data-loss', level: 'CRITICAL' },
  { re: /\breset\s+--hard\b|\bclean\s+-[a-z]*f/i, category: 'data-loss', level: 'CRITICAL' },
  { re: /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/i, category: 'deletion', level: 'CRITICAL' },
  { re: /\bforce[\s-]?push\b|\bpush\b[^\n]{0,20}(?:--force\b|\s-f\b)/i, category: 'history-rewrite', level: 'CRITICAL' },
  { re: /\b(?:production|prod)\b[^\n]{0,40}\b(?:deploy|release|migrat|apply|push)|\b(?:deploy|release|migrat\w*|apply|push)\b[^\n]{0,40}\b(?:production|prod)\b/i, category: 'deployment', level: 'CRITICAL' },

  // --- HIGH ---------------------------------------------------------------------------------
  { re: /\b(?:delete|deletes|deleted|deleting|deletion|remove|removes|removed|removing|removal|drop|drops|dropping|unlink)\b/i, category: 'deletion', level: 'HIGH' },
  { re: /\boverwrit(?:e|es|ing|ten)\b|\breplace\s+(?:the\s+)?existing\b|\b--force\b/i, category: 'overwrite', level: 'HIGH' },
  { re: /\b(?:production|prod|live\s+environment)\b/i, category: 'deployment', level: 'HIGH' },
  { re: /\b(?:deploy|deploys|deploying|deployment|publish|publishing|release\s+to)\b/i, category: 'deployment', level: 'HIGH' },
  { re: /\b(?:launch|launches|launching)\b/i, category: 'deployment', level: 'MEDIUM' },
  { re: /\b(?:perform|apply|applying|execute)\s+(?:these|the\s+following|this|all)?\s*(?:actions|changes|plan|operations)\b/i, category: 'infrastructure', level: 'HIGH' },
  { re: /\b(?:will\s+be\s+(?:replaced|destroyed|modified|changed|updated\s+in-place)|to\s+(?:destroy|replace|change))\b/i, category: 'infrastructure', level: 'HIGH' },
  { re: /\b(?:credential|credentials|secret|secrets|api[\s-]?key|access[\s-]?key|private[\s-]?key|ssh[\s-]?key|certificate|keychain|keyring)\b/i, category: 'credentials', level: 'HIGH' },
  { re: /\b(?:permission|permissions|chmod|chown|privilege|privileges|iam|sudoers|role\s+binding|grant|revoke)\b/i, category: 'permissions', level: 'HIGH' },
  { re: /\b(?:billing|charge|charges|charged|payment|purchase|paid\s+plan|subscription|cost\s+money|invoice)\b/i, category: 'cost', level: 'HIGH' },
  { re: /\breset\b/i, category: 'state-change', level: 'HIGH' },
  { re: /\brename(?:s|d)?\b[^\n]{0,40}\b(?:column|table|field)\b|\b(?:column|table|field)\b[^\n]{0,40}\brenamed?\b/i, category: 'schema-change', level: 'HIGH' },
  { re: /\b(?:is\s+not\s+empty|not\s+empty|already\s+exists)\b/i, category: 'overwrite', level: 'HIGH' },
  { re: /\bauthenticity\s+of\s+host\b|\bfingerprint\b|\bknown_hosts\b|\btrust\s+(?:this|the)\s+(?:host|author|folder|workspace)/i, category: 'credentials', level: 'HIGH' },
  { re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\$\(\s*(?:curl|wget)\b/i, category: 'remote-code', level: 'HIGH' },
  { re: /\bkey\s*pair\b|(?:^|[\s/~])\.ssh\/|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\bgpg\s+key\b/i, category: 'credentials', level: 'HIGH' },

  // --- MEDIUM -------------------------------------------------------------------------------
  { re: /\bmigrat(?:e|es|ed|ion|ions|ing)\b|\balter\s+(?:table|column)\b|\bschema\s+change/i, category: 'schema-change', level: 'MEDIUM' },
  { re: /\brename(?:s|d)?\b/i, category: 'schema-change', level: 'MEDIUM' },
  { re: /\b(?:rebase|rebasing|rewrite\s+history|amend|squash|cherry-pick)\b/i, category: 'history-rewrite', level: 'MEDIUM' },
  { re: /\bpush(?:es|ing)?\b/i, category: 'state-change', level: 'MEDIUM' },
  { re: /\b(?:infrastructure|cloud|resources?|provision(?:ing)?|cluster|instance)\b/i, category: 'infrastructure', level: 'MEDIUM' },
  { re: /\bapply\b/i, category: 'infrastructure', level: 'MEDIUM' },
  { re: /\b(?:telemetry|analytics|anonymous\s+(?:usage|data)|usage\s+data|crash\s+reports?|tracking|newsletter|marketing|share\s+(?:your\s+)?data)\b/i, category: 'privacy', level: 'MEDIUM' },
  { re: /\b(?:warning|danger|dangerous|caution|careful|are\s+you\s+sure|unsafe|risky)\b|⚠|☠|‼/i, category: 'warning', level: 'MEDIUM' },
  { re: /\b(?:you(?:'re|\s+are)|we(?:'re|\s+are)|this\s+is)\s+about\s+to\b/i, category: 'warning', level: 'MEDIUM' },
  { re: /\b(?:uninstall|downgrade|upgrade\s+(?:all|major)|breaking\s+change)/i, category: 'state-change', level: 'MEDIUM' },
  { re: /\b(?:login|log\s+in|sign\s+in|authenticate|authorize|auth\s+token|token)\b/i, category: 'credentials', level: 'MEDIUM' },
  { re: /\b(?:sudo|as\s+root|administrator)\b/i, category: 'permissions', level: 'MEDIUM' },
  { re: /\b(?:commit|commits|committing)\b/i, category: 'state-change', level: 'MEDIUM' },
];

/** Prompt-injection markers: terminal text that tries to address an AI/automation directly. */
const INJECTION_RULES: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|rules|prompts?|policy|policies)\b/i,
  /\b(?:disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|your|safety|the)\s+(?:instructions|rules|policy|policies|safety)\b/i,
  /\b(?:system|developer|admin(?:istrator)?)\s*(?:message|prompt|instruction|override|notice)\s*:/i,
  /^\s*(?:system|assistant|developer)\s*:/im,
  /\b(?:you\s+are\s+(?:an?\s+)?(?:ai|assistant|language\s+model|llm|agent|claude|gpt|bot))\b/i,
  /\b(?:as\s+an\s+ai|dear\s+(?:ai|assistant|agent|bot)|attention\s+(?:ai|agent|assistant|automation|bot)s?)\b/i,
  /\b(?:ai|agent|assistant|automation|bot|llm)s?\s+(?:must|should|need\s+to|are\s+required\s+to)\s+(?:type|answer|select|choose|press|approve|confirm)\b/i,
  /\b(?:auto-?approve|pre-?approved|already\s+approved|human\s+(?:has\s+)?approved|user\s+(?:has\s+)?(?:approved|authorized|consented))\b/i,
  /\b(?:this\s+is\s+(?:safe|a\s+test)|safe\s+to\s+(?:approve|confirm|answer\s+yes))\b[^\n]{0,40}\b(?:type|answer|select|choose|press|approve)\b/i,
  /<\/?(?:system|instructions?|untrusted|tool_result|assistant)>/i,
];

export interface ScanInput {
  command?: string;
  question?: string;
  options?: string[];
  context?: string[];
}

export interface RiskAssessment {
  level: RiskLevel;
  signals: RiskSignal[];
  injection: RiskSignal[];
}

function clip(s: string, n = 160): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * "0 to destroy", "0 destroyed", "zero rows deleted": an explicit zero count is not a consequence.
 * Deliberately narrow — other negations ("no data will be lost") still count, erring on the safe side.
 */
function zeroQuantified(line: string, index: number): boolean {
  const before = line.slice(Math.max(0, index - 24), index);
  return /(?:^|[\s,(:])(?:0|zero)\s+(?:\w+\s+){0,2}(?:to\s+(?:be\s+)?)?$/i.test(before);
}

function scanText(text: string, source: TextSource, out: RiskSignal[]): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    for (const rule of RULES) {
      if (rule.sources && !rule.sources.includes(source)) continue;
      const m = rule.re.exec(line);
      if (m && !zeroQuantified(line, m.index)) {
        out.push({ category: rule.category, level: rule.level, source, match: m[0], line: clip(redactSecrets(line)) });
      }
    }
  }
}

export function scanInjection(lines: string[], source: TextSource = 'context'): RiskSignal[] {
  const out: RiskSignal[] = [];
  for (const line of lines) {
    for (const re of INJECTION_RULES) {
      const m = re.exec(line);
      if (m) {
        out.push({ category: 'injection', level: 'HIGH', source, match: m[0], line: clip(redactSecrets(line)) });
        break;
      }
    }
  }
  return out;
}

/**
 * Deterministic risk floor. Conservative by design: any match counts, negations are ignored
 * ("no data will be lost" still asks a human — a false positive costs one keypress).
 */
export function assessRisk(input: ScanInput): RiskAssessment {
  const signals: RiskSignal[] = [];
  if (input.command) scanText(input.command, 'command', signals);
  if (input.question) scanText(input.question, 'question', signals);
  for (const o of input.options ?? []) scanText(o, 'option', signals);
  for (const c of input.context ?? []) scanText(c, 'context', signals);

  const injection = scanInjection([
    ...(input.context ?? []),
    ...(input.question ? [input.question] : []),
    ...(input.options ?? []),
  ]);

  // Deduplicate: keep the highest level per (category, line).
  const seen = new Map<string, RiskSignal>();
  for (const s of signals) {
    const key = `${s.category}|${s.source}|${s.line}`;
    const prev = seen.get(key);
    if (!prev || riskRank(s.level) > riskRank(prev.level)) seen.set(key, s);
  }
  const deduped = [...seen.values()];
  let level: RiskLevel = 'LOW';
  for (const s of [...deduped, ...injection]) if (riskRank(s.level) > riskRank(level)) level = s.level;
  return { level, signals: deduped, injection };
}

// ---------------------------------------------------------------------------
// Intent comparison (deterministic part). The LLM can do better; this only flags obvious mismatches.
// ---------------------------------------------------------------------------

const DESTRUCTIVE_CATEGORIES: RiskCategory[] = ['data-loss', 'deletion', 'irreversible', 'overwrite', 'history-rewrite'];

export function isDestructive(signals: RiskSignal[]): boolean {
  return signals.some((s) => DESTRUCTIVE_CATEGORIES.includes(s.category) && riskRank(s.level) >= riskRank('HIGH'));
}

/**
 * True when the screen shows a destructive consequence that the stated intent does not ask for.
 */
export function intentMismatch(intent: string | undefined, signals: RiskSignal[]): boolean {
  if (!intent || !isDestructive(signals)) return false;
  const intentSignals: RiskSignal[] = [];
  scanText(intent, 'intent', intentSignals);
  return !isDestructive(intentSignals);
}

// ---------------------------------------------------------------------------
// Per-choice risk. A question like "Do you want to truncate the table?" is CRITICAL as a whole, but
// its answers are not equally dangerous: "No, add the constraint without truncating the table" is the
// way to *avoid* the consequence. These helpers judge each choice on its own words.
// ---------------------------------------------------------------------------

/** Roots of destructive verbs, used to tie a declining choice to the action it declines. */
const DESTRUCTIVE_ROOTS = ['truncat', 'drop', 'delet', 'remov', 'wip', 'purg', 'eras', 'destr', 'overwrit', 'reset', 'discard', 'nuke'] as const;
const DESTRUCTIVE_WORD = `(?:${DESTRUCTIVE_ROOTS.join('|')})\\w*`;
/**
 * A negation directly governing a destructive verb: "without truncating", "do not drop or truncate",
 * "don't delete", "will not be removed". Deliberately tight: only "X or/and" may sit in between, and
 * punctuation breaks the phrase ("Don't wait, delete it" is NOT a negation of delete).
 */
const NEGATED_DESTRUCTIVE = new RegExp(
  `\\b(?:without|not|never|no|don'?t|dont|avoid(?:ing)?|skip(?:ping)?)\\s+(?:be\\s+)?((?:${DESTRUCTIVE_WORD})(?:\\s+(?:or|and|nor)\\s+${DESTRUCTIVE_WORD})*)\\b`,
  'gi',
);

export function destructiveRoot(word: string): string | null {
  const w = word.toLowerCase();
  return DESTRUCTIVE_ROOTS.find((r) => w.startsWith(r)) ?? null;
}

function rootsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.match(/[a-z']+/gi) ?? []) {
    const r = destructiveRoot(w);
    if (r) out.add(r);
  }
  return out;
}

/** The destructive roots a text explicitly negates, and the text with those phrases removed. */
export function negatedDestructive(text: string): { roots: Set<string>; remainder: string } {
  const roots = new Set<string>();
  const remainder = text.replace(NEGATED_DESTRUCTIVE, (_m, verbs: string) => {
    for (const r of rootsIn(verbs)) roots.add(r);
    return ' ';
  });
  return { roots, remainder };
}

export interface ChoiceAssessment {
  index: number;
  /** Risk of the choice's own words once explicitly negated consequences are removed. */
  level: RiskLevel;
  /** The choice itself performs a destructive action (un-negated). */
  destructive: boolean;
  /** Destructive roots the choice performs. */
  performs: string[];
  /** Destructive roots the choice explicitly declines ("without truncating" ⇒ truncat). */
  declines: string[];
  signals: RiskSignal[];
}

export function assessChoices(labels: string[]): ChoiceAssessment[] {
  return labels.map((label, index) => {
    const { roots, remainder } = negatedDestructive(label);
    const signals: RiskSignal[] = [];
    scanText(remainder, 'option', signals);
    let level: RiskLevel = 'LOW';
    for (const s of signals) if (riskRank(s.level) > riskRank(level)) level = s.level;
    const destructive = isDestructive(signals);
    const performs = destructive ? [...rootsIn(remainder)] : [];
    return { index, level, destructive, performs, declines: [...roots], signals };
  });
}

/** The intent explicitly forbids one of these destructive actions ("do not drop or truncate data"). */
export function intentForbids(intent: string | undefined, roots: Iterable<string>): boolean {
  if (!intent) return false;
  const neg = negatedDestructive(intent).roots;
  for (const r of roots) if (neg.has(r)) return true;
  return false;
}

/**
 * A destructive word naming a prompt rather than asking for the action: "truncate prompts must be
 * answered No", "the drop warning". It describes what the program will ask, not what to do.
 */
const DESTRUCTIVE_MENTION = new RegExp(
  `\\b${DESTRUCTIVE_WORD}(?:\\s+(?:table|column|data))?\\s+(?:prompts?|questions?|confirmations?|warnings?|dialogs?)\\b`,
  'gi',
);

/** The intent asks (un-negated) for one of these destructive actions ("truncate the table"). */
export function intentRequests(intent: string | undefined, roots: Iterable<string>): boolean {
  if (!intent) return false;
  const asked = rootsIn(negatedDestructive(intent).remainder.replace(DESTRUCTIVE_MENTION, ' '));
  for (const r of roots) if (asked.has(r)) return true;
  return false;
}

/** Destructive roots mentioned by a signal's match ("will be truncated" ⇒ truncat). */
export function signalRoots(s: RiskSignal): string[] {
  return [...rootsIn(s.match)];
}

export { DESTRUCTIVE_CATEGORIES };

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(?:sk|pk|rk)-(?:ant-|live-|test-|proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redact all strings of a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(?:password|secret|token|apiKey|api_key)$/i.test(k) ? '[REDACTED]' : redactDeep(v);
    }
    return out as T;
  }
  return value;
}

/** Environment variables safe to show to an LLM / audit log (names only for the rest). */
export function describeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const safe = ['NODE_ENV', 'CI', 'TERM', 'SHELL', 'LANG'];
  const out: Record<string, string> = {};
  for (const k of safe) if (env[k]) out[k] = String(env[k]);
  return out;
}

// ---------------------------------------------------------------------------
// Policy constants (trusted). Documented in docs/ARCHITECTURE.md §3.
// ---------------------------------------------------------------------------

export const POLICY = {
  /** Minimum detection confidence for any automatic answer. */
  autoMinDetectionConfidence: 0.85,
  /** Minimum LLM confidence for it to *agree* with an automatic answer. */
  autoMinLlmConfidence: 0.8,
  /** A human keystroke within this window suppresses automation. */
  humanActivityWindowMs: 2000,
  /** Risk at or above which only a human may answer. */
  humanOnlyRisk: 'HIGH' as RiskLevel,
} as const;

// ---------------------------------------------------------------------------
// Approval modes (trusted, operator-chosen): who may answer prompts the policy marks ASK_HUMAN.
// Set ONLY by the person running TtySage (server start-up config). Nothing the agent sends and
// nothing a program prints can change it.
// ---------------------------------------------------------------------------

export const APPROVAL_MODES = ['human', 'ask-user', 'agent-high', 'bypass'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  human: 'Risky prompts wait for a human (default).',
  'ask-user': 'Risky prompts go to a human: a client dialog when the client shows one, otherwise the agent must ask the user in its own UI and relay their exact choice.',
  'agent-high': 'The agent may answer HIGH-risk prompts. CRITICAL prompts and prompt-injection attempts still wait for a human.',
  bypass: 'The agent may answer every prompt except password/secret prompts. No human approval.',
};

/** Parse an operator setting. Unknown values fail closed to "human". */
export function parseApprovalMode(value: string | undefined): { mode: ApprovalMode; warning?: string } {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return { mode: 'human' };
  if ((APPROVAL_MODES as readonly string[]).includes(v)) return { mode: v as ApprovalMode };
  return { mode: 'human', warning: `Unknown approval mode "${value}"; using "human". Valid: ${APPROVAL_MODES.join(', ')}.` };
}

/**
 * May the agent answer a prompt that would otherwise need a human? Secrets are never agent-answerable,
 * in any mode: an agent has no legitimate source for your password, and typing one would put it in the
 * agent's context and logs.
 */
export function agentMayApprove(
  mode: ApprovalMode,
  decision: { risk: RiskOrUnknown; injection: boolean },
  promptType: string,
): boolean {
  if (promptType === 'password') return false;
  switch (mode) {
    case 'human': return false;
    // The agent may only relay the user's answer, after the client dialog was not shown (see the MCP server).
    case 'ask-user': return false;
    case 'agent-high': return !decision.injection && riskRank(decision.risk) < riskRank('CRITICAL');
    case 'bypass': return true;
  }
}
