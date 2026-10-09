import type { KeyName } from '@ttysage/pty';
import type { PromptModel } from '@ttysage/prompt-understanding';
import { ActionSchema, type Action } from '@ttysage/decision-engine';
import { isAffirmative, isNegative } from '@ttysage/detector';

export interface ExecutionResult {
  ok: boolean;
  detail: string;
}

/** What the executor needs from a live session. */
export interface ExecutionTarget {
  sendKey(key: KeyName): void;
  sendText(text: string): void;
  /** Wait for the screen to change and settle; resolves with the re-analysed prompt (or null). */
  settle(timeoutMs?: number): Promise<PromptModel | null>;
}

export type Validation = { ok: true; action: Action } | { ok: false; error: string };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/;

/** Is `action` legal for the prompt currently on screen? (Authorization is the caller's job.) */
export function validateAction(input: unknown, prompt: PromptModel): Validation {
  const parsed = ActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Invalid action: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  const a = parsed.data;
  const choice = prompt.type === 'confirmation' || prompt.type === 'selection';
  switch (a.type) {
    case 'ACCEPT_DEFAULT':
      if (prompt.default === null && prompt.defaultIndex === null && prompt.selectedIndex === null) {
        return { ok: false, error: 'The prompt has no default to accept.' };
      }
      if (prompt.type === 'password') return { ok: false, error: 'Password prompts have no default.' };
      return { ok: true, action: a };
    case 'SELECT_OPTION':
      if (!choice) return { ok: false, error: `SELECT_OPTION is not valid for a ${prompt.type} prompt.` };
      if (prompt.multiple) return { ok: false, error: 'Multi-select prompt: use SELECT_OPTIONS.' };
      if (a.optionIndex >= prompt.options.length) return { ok: false, error: `optionIndex ${a.optionIndex} out of range (0..${prompt.options.length - 1}).` };
      return { ok: true, action: a };
    case 'SELECT_OPTIONS':
      if (!prompt.multiple) return { ok: false, error: 'SELECT_OPTIONS requires a multi-select prompt.' };
      if (a.optionIndices.some((i) => i >= prompt.options.length)) return { ok: false, error: 'optionIndices out of range.' };
      return { ok: true, action: a };
    case 'CONFIRM': {
      if (prompt.type !== 'confirmation') return { ok: false, error: 'CONFIRM requires a confirmation prompt.' };
      const idx = confirmIndex(prompt, a.value);
      if (idx === null) return { ok: false, error: `No option means "${a.value}".` };
      return { ok: true, action: a };
    }
    case 'TEXT': {
      if (!['text', 'password', 'multiline', 'editor', 'tui', 'unknown'].includes(prompt.type)) {
        return { ok: false, error: `TEXT is not valid for a ${prompt.type} prompt; use SELECT_OPTION / CONFIRM.` };
      }
      const allowNewlines = prompt.type === 'multiline' || prompt.type === 'editor';
      const t = allowNewlines ? a.text.replace(/\n/g, '') : a.text;
      if (CONTROL_RE.test(t) || (!allowNewlines && /[\r\n]/.test(a.text))) return { ok: false, error: 'Text contains control characters; use KEYS for special keys.' };
      return { ok: true, action: a };
    }
    case 'KEYS':
    case 'CANCEL':
      return { ok: true, action: a };
  }
}

function confirmIndex(prompt: PromptModel, value: 'yes' | 'no'): number | null {
  const idx = prompt.options.findIndex((o) => (value === 'yes' ? isAffirmative(o.label) : isNegative(o.label)));
  return idx === -1 ? null : idx;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic executor: turns a validated action into allowlisted keys, verifying navigation by
 * re-reading the screen. Never sends Enter on an option it has not confirmed is selected.
 */
export async function executeAction(target: ExecutionTarget, prompt: PromptModel, input: Action): Promise<ExecutionResult> {
  const v = validateAction(input, prompt);
  if (!v.ok) return { ok: false, detail: v.error };
  const action = v.action;
  switch (action.type) {
    case 'CANCEL':
      target.sendKey('CTRL_C');
      return { ok: true, detail: 'sent Ctrl+C' };
    case 'KEYS':
      for (const k of action.keys) {
        target.sendKey(k);
        await pause(25);
      }
      return { ok: true, detail: `sent ${action.keys.length} key(s)` };
    case 'ACCEPT_DEFAULT':
      if (prompt.typedText) return { ok: false, detail: 'Field already contains text; refusing to submit it as "default".' };
      target.sendKey('ENTER');
      return { ok: true, detail: 'sent Enter' };
    case 'TEXT': {
      for (let i = 0; i < prompt.typedText.length; i++) target.sendKey('BACKSPACE');
      const lines = action.text.split('\n');
      lines.forEach((line, i) => {
        if (line) target.sendText(line);
        if (i < lines.length - 1) target.sendKey('ENTER');
      });
      if (action.submit) target.sendKey('ENTER');
      return { ok: true, detail: action.submit ? 'typed text + Enter' : 'typed text' };
    }
    case 'CONFIRM':
      return selectOption(target, prompt, confirmIndex(prompt, action.value)!);
    case 'SELECT_OPTION':
      return selectOption(target, prompt, action.optionIndex);
    case 'SELECT_OPTIONS':
      return selectMany(target, prompt, new Set(action.optionIndices));
  }
}

async function selectOption(target: ExecutionTarget, prompt: PromptModel, index: number): Promise<ExecutionResult> {
  const label = prompt.options[index]!.label;
  if (prompt.style === 'yes-no' || prompt.style === 'numbered') {
    const yes = isAffirmative(label);
    const typed = prompt.style === 'numbered'
      ? prompt.options[index]!.number!
      : prompt.answerForm === 'word' ? (yes ? 'yes' : 'no') : yes ? 'y' : 'n';
    target.sendText(typed);
    // Many prompt libraries submit on the keypress itself. Only press Enter if the SAME prompt
    // instance is still waiting — otherwise the Enter would silently answer the next prompt.
    const after = await target.settle(400);
    if (after && after.fingerprint === prompt.fingerprint && after.anchorLine === prompt.anchorLine) {
      target.sendKey('ENTER');
      return { ok: true, detail: `typed "${typed}" + Enter` };
    }
    return { ok: true, detail: `typed "${typed}" (submitted on keypress)` };
  }
  const horizontal = prompt.style === 'inline-choice';
  const nav = await navigateTo(target, prompt, label, index, horizontal);
  if (!nav.ok) return nav;
  target.sendKey('ENTER');
  return { ok: true, detail: `${nav.detail}; Enter` };
}

async function navigateTo(
  target: ExecutionTarget, prompt: PromptModel, label: string, index: number, horizontal: boolean,
): Promise<ExecutionResult> {
  let current: PromptModel = prompt;
  let steps = 0;
  const maxSteps = Math.max(prompt.options.length * 2 + 6, 12);
  // Initial direction from indices; refined from what is visible after each step.
  let lastDir: 'fwd' | 'back' = index >= (prompt.selectedIndex ?? 0) ? 'fwd' : 'back';
  while (steps <= maxSteps) {
    const sel = current.selectedIndex === null ? null : current.options[current.selectedIndex]?.label ?? null;
    if (sel === label) return { ok: true, detail: `navigated ${steps} step(s) to "${label}"` };
    if (current.selectedIndex === null) return { ok: false, detail: 'Cannot see which option is selected; refusing to navigate blind.' };
    const visible = current.options.findIndex((o) => o.label === label);
    const dir = visible === -1 ? lastDir : visible > current.selectedIndex ? 'fwd' : 'back';
    lastDir = dir;
    target.sendKey(horizontal ? (dir === 'fwd' ? 'RIGHT' : 'LEFT') : dir === 'fwd' ? 'DOWN' : 'UP');
    steps++;
    const next = await target.settle(500);
    if (!next || !(next.type === 'selection' || next.type === 'confirmation')) {
      return { ok: false, detail: 'Prompt disappeared during navigation.' };
    }
    current = next;
  }
  return { ok: false, detail: `Could not reach "${label}" within ${maxSteps} steps.` };
}

async function selectMany(target: ExecutionTarget, prompt: PromptModel, wanted: Set<number>): Promise<ExecutionResult> {
  const wantLabels = new Set([...wanted].map((i) => prompt.options[i]!.label));
  let current = prompt;
  for (const opt of prompt.options) {
    const shouldBe = wantLabels.has(opt.label);
    const now = current.options.find((o) => o.label === opt.label);
    if (!now || now.checked === shouldBe) continue;
    const nav = await navigateTo(target, current, opt.label, opt.index, false);
    if (!nav.ok) return nav;
    target.sendKey('SPACE');
    const next = await target.settle(500);
    if (!next) return { ok: false, detail: 'Prompt disappeared while toggling.' };
    if (next.options.find((o) => o.label === opt.label)?.checked !== shouldBe) {
      return { ok: false, detail: `Toggling "${opt.label}" did not take effect.` };
    }
    current = next;
  }
  target.sendKey('ENTER');
  return { ok: true, detail: `selected ${wanted.size} option(s); Enter` };
}
