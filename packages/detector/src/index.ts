import type { ScreenSnapshot, ScreenRow } from '@ttysage/terminal';
import { isEmphasised, styleSignature } from '@ttysage/terminal';

/**
 * Interactive-state detection. Pure function of a screen snapshot + timing.
 * Works on structure (glyph columns, alignment, cursor, styles, bottom anchoring) — never CLI names.
 */

export type InputMode = 'confirmation' | 'selection' | 'text' | 'password' | 'multiline' | 'editor' | 'tui' | 'unknown';
export type PromptStyle =
  | 'arrow-list' | 'checkbox-list' | 'radio-list' | 'highlight-list' | 'inline-choice'
  | 'numbered' | 'yes-no' | 'text-line' | 'shell' | 'editor' | 'tui' | 'none';

export interface OptionCandidate {
  label: string;
  row: number;
  selected: boolean;
  checked?: boolean;
  /** For numbered menus: what to type. */
  number?: string;
}

export interface PromptCandidate {
  mode: InputMode;
  style: PromptStyle;
  question: string;
  questionRow: number | null;
  options: OptionCandidate[];
  /** Index (into options) of the currently highlighted / cursor option. */
  selectedIndex: number | null;
  /** Index of the option that Enter would choose without navigation (numbered default, y/N default). */
  defaultIndex: number | null;
  /** Default value for text prompts (shown in parentheses / dim), or y/n default as 'yes'|'no'. */
  defaultValue: string | null;
  multiple: boolean;
  /** yes-no prompts: whether the program expects whole words ("yes") or letters ("y"). */
  answerForm?: 'word' | 'letter';
  /** Text already present in a text field before the cursor. */
  typedText: string;
  /** Input label when different from the question (e.g. "Enter a value"). */
  inputLabel?: string;
  hints: string[];
  blockStart: number;
  blockEnd: number;
  truncated?: boolean;
}

export interface Detection {
  interactive: true | false | 'uncertain';
  confidence: number;
  inputMode: InputMode;
  candidate: PromptCandidate | null;
  signals: string[];
  /** When not (yet) interactive: re-run detection after this much more idle time. */
  recheckAfterMs?: number;
}

export interface DetectTiming {
  /** Milliseconds since the last PTY output. */
  idleMs: number;
  processAlive: boolean;
}

export const MIN_IDLE_MS: Record<InputMode, number> = {
  confirmation: 250,
  selection: 250,
  text: 600,
  password: 400,
  multiline: 600,
  editor: 500,
  tui: 800,
  unknown: 2500,
};

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

const POINTER_CHARS = '❯›▸▶►→➜➤»>*';
const ON_BOXES = ['◉', '●', '⦿', '◼', '■', '☑', '☒', '[x]', '[X]', '[✓]', '[✔]', '[*]', '(*)', '(x)', '(●)'];
const OFF_BOXES = ['◯', '○', '◻', '□', '☐', '[ ]', '( )'];
const SQUARE_BOXES = ['◼', '■', '☑', '☒', '◻', '□', '☐', '[x]', '[X]', '[✓]', '[✔]', '[*]', '[ ]'];
const BOX_RE = /^(◉|●|⦿|◯|○|◼|■|◻|□|☐|☑|☒|\[[ xX✓✔*]\]|\([ *xX●]\))\s+/;
const MARKER_RE = new RegExp(`^(\\s*)(?:([${POINTER_CHARS.replace(/[\]\\^-]/g, '\\$&')}])(\\s*))?(.*)$`);

const YES_RE = /^(?:y|yes|yeah|yep|ok|okay|sure|continue|proceed|confirm|true|accept|agree|allow)\b/i;
const NO_RE = /^(?:n|no|nope|cancel|abort|stop|false|decline|deny|exit|quit|skip)\b/i;
const PASSWORD_RE = /\b(?:pass(?:word|phrase|code)?|passwd|pin|secret|token|api[\s-]?key|otp|2fa|mfa|one[\s-]?time\s+(?:code|password)|verification\s+code|security\s+code|private\s+key)\b/i;
const HINT_RE = /(?:\barrow|↑|↓|←|→|\bspace\b|<space>|\benter\b|<enter>|\breturn\b|\bnavigate\b|\btoggle\b|\bselect\b|\bsubmit\b|\bconfirm\b|\besc\b|\btab\b|type to (?:filter|search)|\bpress\b|reveal more|\bfilter\b|ctrl\+|\bto (?:move|go back)\b)/i;
const MULTILINE_RE = /\bctrl[\s+-]*d\b|\^d\b|empty\s+line\s+to\s+(?:finish|end)|esc(?:ape)?\s+then\s+enter|enter\s+twice|end\s+with\s+(?:a\s+)?(?:single\s+)?(?:\.|EOF)/i;
const GENERIC_LABEL_RE = /^(?:enter\s+(?:a\s+|the\s+)?(?:value|choice|selection|answer|response)|value|input|answer|response|choice|selection|your\s+(?:choice|answer))$/i;
const SEPARATOR_RE = /^[\s─━—–\-=_·.]+$/;
const QUESTION_PREFIX_RE = /^[\s?◆◇◈●○✔✖✗×!>•*‣▲·│┃|❯›]+/;

function stripGutter(line: string): string {
  // Box-drawing gutters (│  ● Vanilla) → spaces, preserving columns.
  return line.replace(/^(\s*)[│┃┆┊](?=\s|$)/, '$1 ').replace(/\s+[│┃]\s*$/, '');
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function isBoxOnly(s: string): boolean {
  return /^[\s└╰┘┌╭┐─━│┃◇◆]*$/.test(s);
}

export function isHintLine(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (isBoxOnly(t)) return true;
  return t.length < 140 && HINT_RE.test(t) && !BOX_RE.test(t.replace(/^[❯›>]\s*/, ''));
}

function stripHints(q: string): { text: string; hints: string[] } {
  const hints: string[] = [];
  let text = q.replace(/\(([^()]*)\)/g, (m, inner: string) => {
    if (HINT_RE.test(inner)) { hints.push(inner.trim()); return ''; }
    return m;
  });
  // "Pick a colour › - Use arrow-keys. Return to submit."
  const arrow = text.search(/\s[›»]\s/);
  if (arrow !== -1) {
    const rest = text.slice(arrow + 3);
    if (rest.trim() === '' || HINT_RE.test(rest) || /^\s*-\s/.test(rest)) {
      if (rest.trim()) hints.push(rest.replace(/^\s*-\s*/, '').trim());
      text = text.slice(0, arrow);
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), hints };
}

export function cleanQuestion(raw: string): { text: string; hints: string[] } {
  const { text, hints } = stripHints(stripGutter(raw).replace(QUESTION_PREFIX_RE, ''));
  return { text: text.replace(/\s*[›»]\s*$/, '').trim(), hints };
}

export function isAffirmative(label: string): boolean {
  return YES_RE.test(label.replace(/^[^\p{L}\p{N}]+/u, ''));
}
export function isNegative(label: string): boolean {
  return NO_RE.test(label.replace(/^[^\p{L}\p{N}]+/u, ''));
}

interface ParsedRow {
  raw: string;
  text: string; // gutter-stripped
  indent: number;
  pointer: string | null;
  box: string | null;
  boxOn: boolean | null;
  labelCol: number;
  label: string;
}

function parseRow(raw: string): ParsedRow {
  const text = stripGutter(raw);
  const m = MARKER_RE.exec(text)!;
  const indent = m[1]!.length;
  let pointer: string | null = m[2] ?? null;
  let rest = m[4] ?? '';
  let col = indent + (pointer ? 1 + (m[3]?.length ?? 0) : 0);
  // '>' and '*' only count as pointers when followed by whitespace (avoid "->", "**bold**").
  if (pointer && (pointer === '>' || pointer === '*') && (m[3]?.length ?? 0) === 0) {
    pointer = null;
    rest = text.slice(indent);
    col = indent;
  }
  let box: string | null = null;
  const bm = BOX_RE.exec(rest);
  if (bm) {
    box = bm[1]!;
    col += bm[0].length;
    rest = rest.slice(bm[0].length);
  }
  // A pointer with nothing after it is not an option.
  if (pointer && !rest.trim() && !box) pointer = null;
  return {
    raw,
    text,
    indent,
    pointer,
    box,
    boxOn: box ? ON_BOXES.includes(box) : null,
    labelCol: col,
    label: rest.trim(),
  };
}

function cleanLabel(label: string): string {
  return label.replace(/\s+/g, ' ').replace(/\s*\((?:disabled|current|default)\)\s*$/i, '').trim();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detect(snap: ScreenSnapshot, timing: DetectTiming): Detection {
  const signals: string[] = [];
  if (!timing.processAlive) {
    return { interactive: false, confidence: 1, inputMode: 'unknown', candidate: null, signals: ['process-exited'] };
  }
  const lines = snap.lines;
  let lastRow = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (!isBlank(lines[i]!)) { lastRow = i; break; }
  if (lastRow === -1) {
    return notYet('unknown', timing, ['blank-screen']);
  }

  const result = snap.altScreen ? detectFullScreen(snap, lastRow, signals) : detectInline(snap, lastRow, signals);
  if (!result) {
    return fallback(snap, lastRow, timing, signals);
  }
  const need = MIN_IDLE_MS[result.candidate.mode];
  if (timing.idleMs < need) {
    return { ...notYet(result.candidate.mode, timing, signals), recheckAfterMs: need - timing.idleMs };
  }
  return {
    interactive: true,
    confidence: Math.min(0.99, Math.round(result.confidence * 100) / 100),
    inputMode: result.candidate.mode,
    candidate: result.candidate,
    signals,
  };
}

interface Found { candidate: PromptCandidate; confidence: number }

function notYet(mode: InputMode, timing: DetectTiming, signals: string[]): Detection {
  return {
    interactive: false,
    confidence: 0.5,
    inputMode: mode,
    candidate: null,
    signals: [...signals, 'awaiting-stability'],
    recheckAfterMs: Math.max(50, MIN_IDLE_MS.unknown - timing.idleMs),
  };
}

function fallback(snap: ScreenSnapshot, lastRow: number, timing: DetectTiming, signals: string[]): Detection {
  if (timing.idleMs < MIN_IDLE_MS.unknown) return notYet('unknown', timing, signals);
  // Long silence while alive. Maybe waiting, maybe computing. Never auto-answer this.
  const cursorAtLineEnd =
    snap.cursor.row === lastRow && snap.cursor.col >= (snap.lines[lastRow] ?? '').trimEnd().length && snap.cursor.col > 0;
  const lines = snap.lines.slice(Math.max(0, lastRow - 5), lastRow + 1).filter((l) => !isBlank(l));
  return {
    interactive: 'uncertain',
    confidence: cursorAtLineEnd ? 0.5 : 0.3,
    inputMode: 'unknown',
    candidate: {
      mode: 'unknown',
      style: 'none',
      question: cleanQuestion(lines[lines.length - 1] ?? '').text,
      questionRow: lastRow,
      options: [],
      selectedIndex: null,
      defaultIndex: null,
      defaultValue: null,
      multiple: false,
      typedText: '',
      hints: [],
      blockStart: Math.max(0, lastRow - 5),
      blockEnd: lastRow,
    },
    signals: [...signals, 'idle-no-structure', ...(cursorAtLineEnd ? ['cursor-at-line-end'] : [])],
  };
}

function detectFullScreen(snap: ScreenSnapshot, lastRow: number, signals: string[]): Found | null {
  signals.push('alt-screen');
  const lines = snap.lines;
  const tildes = lines.filter((l) => /^~\s*$/.test(l)).length;
  const statusModes = lines.some((l) => /^-- (?:INSERT|VISUAL|REPLACE)(?: LINE| BLOCK)? --/.test(l));
  const nano = lines.some((l) => /GNU nano|\^G\s+(?:Get\s+)?Help|\^X\s+Exit/.test(l));
  const emacs = lines.some((l) => /^-[UuDd-]{1,3}:[-*%]{2}/.test(l));
  // vi-family file-info line: "path/to/file" 34L, 1553B   (or [New], [readonly] …)
  const viInfo = lines.some((l) => /^"[^"]+"\s+(?:\[[^\]]+\]\s+)*(?:\d+L,\s*\d+[BC]|--No lines in buffer--)/.test(l.replace(/^</, '"')) || /^<.*"\s+\d+L,\s*\d+[BC]/.test(l));
  if (tildes >= 2 || statusModes || nano || emacs || viInfo) {
    signals.push(tildes >= 2 ? 'editor:tilde-lines' : statusModes ? 'editor:mode-line' : nano ? 'editor:shortcut-bar' : viInfo ? 'editor:file-info' : 'editor:mode-line');
    const status = [...lines].reverse().find((l) => !isBlank(l) && !/^~\s*$/.test(l)) ?? '';
    return {
      confidence: 0.92,
      candidate: {
        ...emptyCandidate('editor', 'editor', 0, lastRow),
        question: `Edit text in a terminal editor${status ? ` (${status.trim().slice(0, 100)})` : ''}`,
      },
    };
  }
  const list = detectInline(snap, lastRow, signals, true);
  if (list && (list.candidate.mode === 'selection' || list.candidate.mode === 'confirmation')) {
    signals.push('tui-list');
    return { ...list, confidence: list.confidence * 0.92 };
  }
  signals.push('tui');
  return { confidence: 0.72, candidate: { ...emptyCandidate('tui', 'tui', 0, lastRow), question: 'Full-screen terminal application' } };
}

function emptyCandidate(mode: InputMode, style: PromptStyle, start: number, end: number): PromptCandidate {
  return {
    mode, style, question: '', questionRow: null, options: [], selectedIndex: null, defaultIndex: null,
    defaultValue: null, multiple: false, typedText: '', hints: [], blockStart: start, blockEnd: end,
  };
}

function detectInline(snap: ScreenSnapshot, lastRow: number, signals: string[], fullScreen = false): Found | null {
  const regionStart = Math.max(0, lastRow - 40);
  const parsed: ParsedRow[] = snap.lines.map(parseRow);
  const multiline = snap.lines.slice(Math.max(0, lastRow - 6), lastRow + 1).some((l) => MULTILINE_RE.test(l));

  return (
    detectList(snap, parsed, regionStart, lastRow, signals, fullScreen) ??
    detectHighlightList(snap, parsed, regionStart, lastRow, signals) ??
    detectYesNo(snap, lastRow, signals) ??
    detectInlineChoice(snap, parsed, lastRow, signals) ??
    detectNumbered(snap, parsed, regionStart, lastRow, signals) ??
    detectText(snap, lastRow, signals, multiline)
  );
}

/** Rows after the block that are not hints/boxes. Prompts are anchored at the bottom of output. */
function trailingContentRows(lines: string[], blockEnd: number, lastRow: number): number {
  let n = 0;
  for (let i = blockEnd + 1; i <= lastRow; i++) {
    const l = lines[i]!;
    if (isBlank(l) || isHintLine(l)) continue;
    n++;
  }
  return n;
}

/** A visible cursor on a non-hint line below `end` means input happens there, not in the block. */
function inputBelow(snap: ScreenSnapshot, end: number, lastRow: number): boolean {
  const cr = snap.cursor.row;
  return snap.cursorVisible && cr > end && cr <= lastRow && !isBlank(snap.lines[cr]!) && !isHintLine(snap.lines[cr]!);
}

function instructionAbove(lines: string[], start: number): { row: number; text: string; hints: string[] } | null {
  for (let i = start - 1; i >= Math.max(0, start - 3); i--) {
    const t = stripGutter(lines[i]!).trim();
    if (t && !isBoxOnly(t)) return { row: i, text: t, hints: [] };
  }
  return null;
}

function findQuestionAbove(lines: string[], start: number, maxUp = 4): { row: number; text: string; hints: string[] } | null {
  for (let i = start - 1, seen = 0; i >= 0 && seen < maxUp; i--) {
    const l = lines[i]!;
    if (isBlank(l) || isBoxOnly(l)) continue;
    seen++;
    const q = cleanQuestion(l);
    if (!q.text) {
      if (q.hints.length) continue;
      continue;
    }
    // Pure hint rows ("↑↓ navigate") are skipped; a question carrying an inline hint is kept.
    if (isHintLine(l) && q.hints.length === 0 && !/[?:]\s*$/.test(q.text)) continue;
    if (q.hints.length > 0 && HINT_RE.test(q.text) && !/[?:]\s*$/.test(q.text)) continue;
    return { row: i, text: q.text, hints: q.hints };
  }
  return null;
}

function detectList(
  snap: ScreenSnapshot, parsed: ParsedRow[], regionStart: number, lastRow: number, signals: string[], fullScreen: boolean,
): Found | null {
  // Bottom-most anchor: a row with a pointer glyph or a check/radio box.
  for (let anchor = lastRow; anchor >= regionStart; anchor--) {
    const a = parsed[anchor]!;
    if (!(a.pointer || a.box) || !a.label) continue;
    const col = a.labelCol;
    const member = (r: ParsedRow): boolean => {
      if (!r.label) return false;
      if (r.labelCol === col && (r.pointer || r.box || r.indent === col)) return true;
      return false;
    };
    let start = anchor;
    let end = anchor;
    for (let i = anchor - 1; i >= regionStart; i--) {
      const r = parsed[i]!;
      if (member(r)) { start = i; continue; }
      if (SEPARATOR_RE.test(r.text) && !isBlank(r.text)) continue;
      break;
    }
    for (let i = anchor + 1; i <= lastRow; i++) {
      const r = parsed[i]!;
      if (member(r)) { end = i; continue; }
      if (SEPARATOR_RE.test(r.text) && !isBlank(r.text)) continue;
      break;
    }
    const rows: number[] = [];
    for (let i = start; i <= end; i++) if (member(parsed[i]!)) rows.push(i);
    if (rows.length < 2) continue;
    if (!fullScreen && trailingContentRows(snap.lines, end, lastRow) > 2) return null; // not the active prompt
    if (inputBelow(snap, end, lastRow)) return null;
    const pointers = rows.filter((i) => parsed[i]!.pointer);
    const boxes = rows.filter((i) => parsed[i]!.box);
    // Lists need consistent markers: either a single cursor pointer, or boxes on (almost) every row.
    if (pointers.length > 1 && boxes.length === 0) return null;
    if (pointers.length === 0 && boxes.length < rows.length) return null;

    const hasSquare = boxes.some((i) => SQUARE_BOXES.includes(parsed[i]!.box!));
    const onCount = boxes.filter((i) => parsed[i]!.boxOn).length;
    let style: PromptStyle;
    let multiple = false;
    if (boxes.length >= rows.length - 1 && boxes.length > 0) {
      if (hasSquare || pointers.length === 1 || onCount !== 1) { style = 'checkbox-list'; multiple = true; }
      else style = 'radio-list';
    } else {
      style = 'arrow-list';
    }
    let selectedRow: number | null = pointers[0] ?? null;
    if (selectedRow === null && style === 'radio-list') selectedRow = boxes.find((i) => parsed[i]!.boxOn) ?? null;
    if (selectedRow === null) {
      // checkbox list without pointer: the emphasised row is the cursor.
      selectedRow = rows.find((i) => isEmphasised(snap.styled[i]!, parsed[i]!.labelCol, parsed[i]!.labelCol + parsed[i]!.label.length)) ?? null;
    }
    const options: OptionCandidate[] = rows.map((i) => ({
      label: cleanLabel(parsed[i]!.label),
      row: i,
      selected: i === selectedRow,
      ...(multiple ? { checked: parsed[i]!.boxOn === true } : {}),
    }));
    const selectedIndex = options.findIndex((o) => o.selected);
    const q = findQuestionAbove(snap.lines, start);
    const hints = [...(q?.hints ?? [])];
    for (let i = end + 1; i <= lastRow; i++) if (isHintLine(snap.lines[i]!) && !isBoxOnly(snap.lines[i]!)) hints.push(snap.lines[i]!.trim());
    const hintText = hints.join(' ');
    let conf = 0.62;
    if (q) conf += 0.12;
    if (q && /[?:]\s*$/.test(q.text)) conf += 0.04;
    if (/arrow|↑|↓|navigate|space|select/i.test(hintText)) { conf += 0.08; signals.push('list-hint'); }
    if (!snap.cursorVisible) { conf += 0.08; signals.push('cursor-hidden'); }
    if (trailingContentRows(snap.lines, end, lastRow) === 0) conf += 0.05;
    if (selectedIndex !== -1) conf += 0.05;
    else conf -= 0.15;
    signals.push(`list:${style}`, `options:${options.length}`);
    const confirmation =
      !multiple && options.length === 2 &&
      options.some((o) => isAffirmative(o.label)) && options.some((o) => isNegative(o.label));
    return {
      confidence: conf,
      candidate: {
        mode: confirmation ? 'confirmation' : 'selection',
        style,
        question: q?.text ?? '',
        questionRow: q?.row ?? null,
        options,
        selectedIndex: selectedIndex === -1 ? null : selectedIndex,
        defaultIndex: selectedIndex === -1 ? null : selectedIndex,
        defaultValue: null,
        multiple,
        typedText: '',
        hints,
        blockStart: q?.row ?? start,
        blockEnd: end,
        truncated: /reveal more|more choices|\(\d+\/\d+\)|↓\s*\d+\s+more/i.test(hintText + snap.lines.slice(end, lastRow + 1).join(' ')),
      },
    };
  }
  return null;
}

function detectHighlightList(
  snap: ScreenSnapshot, parsed: ParsedRow[], regionStart: number, lastRow: number, signals: string[],
): Found | null {
  // Lists rendered only with inverse/background colour on the current row (no glyphs).
  for (let end = lastRow; end >= Math.max(regionStart, lastRow - 6); end--) {
    const rows: number[] = [];
    const indent = parsed[end]!.indent;
    if (!parsed[end]!.label && isBlank(parsed[end]!.text)) continue;
    for (let i = end; i >= regionStart; i--) {
      const r = parsed[i]!;
      if (isBlank(r.text) || r.indent !== indent) break;
      rows.unshift(i);
    }
    if (rows.length < 2 || rows.length > 30) continue;
    const emph = rows.filter((i) => {
      const t = snap.lines[i]!;
      return isEmphasised(snap.styled[i]!, indent, t.trimEnd().length);
    });
    if (emph.length !== 1) continue;
    // The question is the first row if it is not emphasised and ends like a question.
    let optionRows = rows;
    let q: { row: number; text: string; hints: string[] } | null = null;
    const first = rows[0]!;
    const firstClean = cleanQuestion(snap.lines[first]!);
    if (first !== emph[0] && /[?:]\s*$/.test(firstClean.text)) {
      q = { row: first, text: firstClean.text, hints: firstClean.hints };
      optionRows = rows.slice(1);
    } else {
      q = findQuestionAbove(snap.lines, first);
    }
    if (optionRows.length < 2) continue;
    if (trailingContentRows(snap.lines, end, lastRow) > 2 || inputBelow(snap, end, lastRow)) return null;
    const options = optionRows.map((i) => ({ label: cleanLabel(snap.lines[i]!.trim()), row: i, selected: i === emph[0] }));
    const selectedIndex = options.findIndex((o) => o.selected);
    signals.push('list:highlight', `options:${options.length}`);
    const confirmation = options.length === 2 && options.some((o) => isAffirmative(o.label)) && options.some((o) => isNegative(o.label));
    return {
      confidence: 0.6 + (q ? 0.15 : 0) + (!snap.cursorVisible ? 0.1 : 0) + (q && /[?:]\s*$/.test(q.text) ? 0.05 : 0),
      candidate: {
        ...emptyCandidate(confirmation ? 'confirmation' : 'selection', 'highlight-list', q?.row ?? optionRows[0]!, end),
        question: q?.text ?? '',
        questionRow: q?.row ?? null,
        options,
        selectedIndex,
        defaultIndex: selectedIndex,
        hints: q?.hints ?? [],
      },
    };
  }
  return null;
}

/** Text before the cursor on the cursor row (or the whole last row if the cursor is elsewhere). */
function inputRow(snap: ScreenSnapshot, lastRow: number): { row: number; before: string; after: string } {
  const { row, col } = snap.cursor;
  if (row <= lastRow && row >= 0 && !isBlank(snap.lines[row] ?? '')) {
    const line = snap.lines[row]!;
    return { row, before: line.slice(0, col), after: line.slice(col) };
  }
  return { row: lastRow, before: snap.lines[lastRow]!, after: '' };
}

const YN_PAIR_RE = /[(\[]\s*(y(?:es)?|n(?:o)?)\s*\/\s*(y(?:es)?|n(?:o)?)((?:\s*\/\s*[^)\]\n]{1,20})*)\s*[)\]]/i;
const YN_SINGLE_RE = /[(\[]\s*(y|yes|n|no)\s*[)\]]\s*[:?]?\s*$/i;

function detectYesNo(snap: ScreenSnapshot, lastRow: number, signals: string[]): Found | null {
  const { row, before } = inputRow(snap, lastRow);
  const text = stripGutter(before).trimEnd();
  let m = YN_PAIR_RE.exec(text);
  let defaultValue: 'yes' | 'no' | null = null;
  let answerForm: 'word' | 'letter' = 'letter';
  let matchStart: number;
  let matchEnd: number;
  if (m) {
    matchStart = m.index;
    matchEnd = m.index + m[0].length;
    const a = m[1]!;
    const b = m[2]!;
    const upper = [a, b].filter((s) => s[0] === s[0]!.toUpperCase() && s[0] !== s[0]!.toLowerCase());
    if (upper.length === 1) defaultValue = /^y/i.test(upper[0]!) ? 'yes' : 'no';
    if (a.length > 1 || b.length > 1) answerForm = 'word';
  } else {
    const s = YN_SINGLE_RE.exec(text);
    if (!s) return null;
    m = s;
    matchStart = s.index;
    matchEnd = s.index + s[0].length;
    defaultValue = /^y/i.test(s[1]!) ? 'yes' : 'no';
    if (s[1]!.length > 1) answerForm = 'word';
  }
  // The y/n hint must be at the end of the input line (allowing ":" / "?" / one typed char).
  const tail = text.slice(matchEnd).replace(/^[\s:?›»>]*/, '');
  if (tail.length > 3) return null;
  let question = cleanQuestion(text.slice(0, matchStart)).text;
  let questionRow = row;
  if (!question) {
    const q = findQuestionAbove(snap.lines, row);
    question = q?.text ?? '';
    questionRow = q?.row ?? row;
  }
  signals.push('yes-no-hint');
  const options: OptionCandidate[] = [
    { label: 'Yes', row, selected: defaultValue === 'yes' },
    { label: 'No', row, selected: defaultValue === 'no' },
  ];
  const cursorRight = snap.cursor.row === row;
  return {
    confidence: 0.8 + (cursorRight ? 0.1 : 0) + (question ? 0.05 : 0) + (snap.cursorVisible ? 0.03 : 0),
    candidate: {
      ...emptyCandidate('confirmation', 'yes-no', questionRow, row),
      question,
      questionRow,
      options,
      selectedIndex: null,
      defaultIndex: defaultValue === 'yes' ? 0 : defaultValue === 'no' ? 1 : null,
      defaultValue,
      answerForm,
      typedText: tail,
    },
  };
}

function detectInlineChoice(snap: ScreenSnapshot, parsed: ParsedRow[], lastRow: number, signals: string[]): Found | null {
  // "● Yes / ○ No"  or  "? Continue? › no / yes"  (selected shown by glyph or by style).
  for (let row = lastRow; row >= Math.max(0, lastRow - 2); row--) {
    const line = stripGutter(snap.lines[row]!);
    if (!line.includes(' / ')) continue;
    let segStartCol: number;
    let prefix = '';
    const arrow = line.search(/[›»]\s/);
    if (arrow !== -1 && line.slice(arrow + 2).includes(' / ')) {
      prefix = line.slice(0, arrow);
      segStartCol = arrow + 2;
    } else {
      segStartCol = line.length - line.trimStart().length;
    }
    const segText = line.slice(segStartCol);
    const parts = segText.split(' / ');
    if (parts.length < 2 || parts.length > 6 || parts.some((p) => !p.trim() || p.trim().length > 40)) continue;
    // Compute columns of each segment.
    const segs: { label: string; start: number; end: number; on: boolean | null }[] = [];
    let col = segStartCol;
    for (const p of parts) {
      const lead = p.length - p.trimStart().length;
      let label = p.trim();
      let on: boolean | null = null;
      const bm = /^(●|◉|⦿|○|◯)\s*/.exec(label);
      if (bm) {
        on = bm[1] === '●' || bm[1] === '◉' || bm[1] === '⦿';
        label = label.slice(bm[0].length);
      }
      segs.push({ label, start: col + lead, end: col + lead + p.trim().length, on });
      col += p.length + 3;
    }
    let selected = segs.findIndex((s) => s.on === true);
    if (selected === -1) {
      const sigs = segs.map((s) => styleSignature(snap.styled[row]!, s.start, s.end));
      const unique = sigs.filter((s, i) => sigs.indexOf(s) === i);
      if (unique.length === 2 && segs.length >= 2) {
        const odd = sigs.findIndex((s) => sigs.filter((t) => t === s).length === 1);
        // With exactly two segments both are "unique": prefer the emphasised / non-dim one.
        if (segs.length === 2) {
          const dim = sigs.map((s) => /D|f8b|f90/.test(s) || s.includes('f8'));
          selected = dim[0] && !dim[1] ? 1 : dim[1] && !dim[0] ? 0 : sigs.findIndex((s) => /U|I/.test(s));
        } else selected = odd;
      }
    }
    const glyphs = segs.some((s) => s.on !== null);
    const allShort = segs.every((s) => s.label.split(/\s+/).length <= 4);
    if (!glyphs && !prefix && !allShort) continue;
    if (!glyphs && selected === -1 && !prefix) continue;
    let question = prefix ? cleanQuestion(prefix).text : '';
    let questionRow: number | null = prefix ? row : null;
    if (!question) {
      const q = findQuestionAbove(snap.lines, row);
      question = q?.text ?? '';
      questionRow = q?.row ?? null;
    }
    if (trailingContentRows(snap.lines, row, lastRow) > 1 || inputBelow(snap, row, lastRow)) continue;
    const options = segs.map((s, i) => ({ label: s.label, row, selected: i === selected }));
    const confirmation = options.some((o) => isAffirmative(o.label)) && options.some((o) => isNegative(o.label)) && options.length === 2;
    signals.push('inline-choice');
    void parsed;
    return {
      confidence: 0.68 + (selected !== -1 ? 0.12 : 0) + (question ? 0.1 : 0) + (!snap.cursorVisible ? 0.05 : 0) + (glyphs ? 0.04 : 0),
      candidate: {
        ...emptyCandidate(confirmation ? 'confirmation' : 'selection', 'inline-choice', questionRow ?? row, row),
        question,
        questionRow,
        options,
        selectedIndex: selected === -1 ? null : selected,
        defaultIndex: selected === -1 ? null : selected,
      },
    };
  }
  return null;
}

const NUM_RE = /^\s*(?:\[(\d{1,2})\]|\(?(\d{1,2})[).:])\s+(\S.*)$/;

function detectNumbered(snap: ScreenSnapshot, parsed: ParsedRow[], regionStart: number, lastRow: number, signals: string[]): Found | null {
  void parsed;
  const { row: inRow, before } = inputRow(snap, lastRow);
  const inputText = stripGutter(before).trimEnd();
  // The input line must look like a prompt waiting at the cursor.
  if (!/[:?>#)\]»›]\s*\S{0,3}$/.test(inputText) && !/^\s*#\?\s*$/.test(inputText)) return null;
  const listEnd = NUM_RE.test(snap.lines[inRow]!) && inRow === lastRow ? inRow - 1 : inRow - 1;
  const rows: { row: number; num: string; label: string }[] = [];
  for (let i = listEnd; i >= regionStart; i--) {
    const l = stripGutter(snap.lines[i]!);
    if (isBlank(l)) { if (rows.length === 0) continue; break; }
    const m = NUM_RE.exec(l);
    if (!m) { if (rows.length === 0 && (inRow - i) <= 2) continue; break; }
    rows.unshift({ row: i, num: (m[1] ?? m[2])!, label: m[3]!.trim() });
  }
  if (rows.length < 2) return null;
  const nums = rows.map((r) => Number(r.num));
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1]! + 1) return null;
  if (nums[0]! > 1) return null;
  const defM = /\[(\d{1,2})\]|\(default:?\s*(\d{1,2})\)|\((\d{1,2})\)/i.exec(inputText);
  const defNum = defM ? (defM[1] ?? defM[2] ?? defM[3])! : null;
  const options: OptionCandidate[] = rows.map((r) => ({ label: cleanLabel(r.label), row: r.row, selected: r.num === defNum, number: r.num }));
  const defaultIndex = defNum ? options.findIndex((o) => o.number === defNum) : -1;
  const label = cleanQuestion(inputText.replace(/\[(\d{1,2})\]|\(default:?\s*\d+\)|\(\d+\)/i, '')).text.replace(/[:?>#]+$/, '').trim();
  const above = findQuestionAbove(snap.lines, rows[0]!.row, 2);
  const question = above && (/[?:]\s*$/.test(above.text) || !label || GENERIC_LABEL_RE.test(label) || /^(?:enter|choose|select|pick)\b/i.test(label))
    ? above.text
    : label || above?.text || '';
  signals.push('numbered-menu', `options:${options.length}`);
  const confirmation = options.length === 2 && options.some((o) => isAffirmative(o.label)) && options.some((o) => isNegative(o.label));
  return {
    confidence: 0.78 + (snap.cursor.row === inRow ? 0.08 : 0) + (question ? 0.06 : 0),
    candidate: {
      ...emptyCandidate(confirmation ? 'confirmation' : 'selection', 'numbered', above?.row ?? rows[0]!.row, inRow),
      question,
      questionRow: above?.row ?? null,
      options,
      selectedIndex: defaultIndex === -1 ? null : defaultIndex,
      defaultIndex: defaultIndex === -1 ? null : defaultIndex,
      inputLabel: label || undefined,
    },
  };
}

function isDimRange(row: ScreenRow | undefined, start: number, end: number): boolean {
  if (!row || end <= start) return false;
  let dim = 0;
  for (const r of row.runs) {
    const s = Math.max(r.start, start);
    const e = Math.min(r.end, end);
    // dim attribute, or "bright black" grey (palette 8 / 90) commonly used for placeholders.
    if (e > s && (r.dim || r.fg === 8 || r.fg === 240 || r.fg === 242 || r.fg === 244)) dim += e - s;
  }
  return dim / (end - start) > 0.6;
}

function detectText(snap: ScreenSnapshot, lastRow: number, signals: string[], multiline: boolean): Found | null {
  const { row: curRow, col } = snap.cursor;
  let row = curRow;
  let before: string;
  let after = '';
  let cursorOnContent = true;
  if (row > lastRow || isBlank(snap.lines[row] ?? '')) {
    // Cursor on an empty line under the label ("Name:\n_").
    cursorOnContent = false;
    row = lastRow;
    before = snap.lines[lastRow]!;
    if (curRow !== lastRow + 1) return null;
  } else {
    if (row < lastRow - 2) return null; // cursor far above the bottom: not a simple prompt
    const line = snap.lines[row]!;
    before = line.slice(0, col);
    after = line.slice(col);
  }
  const raw = stripGutter(before);
  const t = raw.trimEnd();
  let label = '';
  let typed = '';
  let defaultValue: string | null = null;
  let terminatorFound = false;

  // Shell prompt (nested shell, REPL): "user@host:~$ " / "> " / ">>> "
  if (/(?:^|\s|[\w~)\]])(?:\$|#|%|>>>|❯)\s*$/.test(raw) && !/[?:]\s*\S*\s*[$#%]\s*$/.test(t)) {
    signals.push('shell-prompt');
    return {
      confidence: 0.7,
      candidate: {
        ...emptyCandidate('text', 'shell', row, row),
        question: 'Interactive shell / REPL prompt',
        questionRow: row,
        typedText: '',
      },
    };
  }

  let work = t;
  const paren = /\(([^()]{0,80})\)\s*$/.exec(work) ?? /\[([^\[\]]{1,80})\]\s*:?\s*$/.exec(work);
  if (paren) {
    defaultValue = paren[1]!.trim();
    work = work.slice(0, paren.index).trimEnd();
  }
  const term = /[:?›»>]\s*$/.exec(work);
  if (term) {
    terminatorFound = true;
    label = work.slice(0, term.index);
  } else if (!paren) {
    const idx = Math.max(work.lastIndexOf(': '), work.lastIndexOf('? '), work.lastIndexOf('› '), work.lastIndexOf('» '));
    if (idx > 0) {
      terminatorFound = true;
      label = work.slice(0, idx);
      typed = work.slice(idx + 2).trim();
      // Dim pre-filled value before the cursor is a default, not user input.
      const startCol = before.indexOf(typed, idx);
      if (typed && isDimRange(snap.styled[row], startCol, startCol + typed.length)) {
        defaultValue = typed;
        typed = '';
      }
    } else if (paren) {
      label = work;
      terminatorFound = true;
    }
  } else {
    label = work;
    terminatorFound = true;
  }
  // A ':' inside the label ("? Enter a name for the new migration: ›") — strip trailing terminators.
  let { text: question, hints } = cleanQuestion(label.replace(/[:?›»>\s]+$/, '') + (label.trim().endsWith('?') ? '?' : ''));
  if (!terminatorFound && cursorOnContent) return null;
  if (!question) {
    // Bare input marker ("> "): the instruction line above is the question, even if it reads like a hint.
    const q = findQuestionAbove(snap.lines, row) ?? instructionAbove(snap.lines, row);
    if (!q) return null;
    question = q.text;
  }
  let inputLabel: string | undefined;
  if (GENERIC_LABEL_RE.test(question.replace(/[?:]$/, ''))) {
    inputLabel = question;
    for (let i = row - 1; i >= Math.max(0, row - 14); i--) {
      const c = cleanQuestion(snap.lines[i]!).text;
      if (/\?\s*$/.test(c)) { question = c; break; }
    }
  }
  const placeholder = after.trim() && isDimRange(snap.styled[row], col, col + after.trimEnd().length) ? after.trim() : '';
  if (placeholder) hints = [...hints, `placeholder: ${placeholder}`];
  const pwContext = [question, inputLabel ?? '', cursorOnContent ? '' : snap.lines[lastRow]!].join(' ');
  const mode: InputMode = PASSWORD_RE.test(pwContext) ? 'password' : multiline ? 'multiline' : 'text';
  signals.push(`text:${mode}`);
  if (defaultValue !== null && /^(?:y|yes|n|no)$/i.test(defaultValue)) signals.push('yes-like-default');
  let conf = 0.6;
  if (terminatorFound && typed === '') conf += 0.15;
  else if (terminatorFound) conf += 0.08;
  if (snap.cursorVisible) conf += 0.1;
  if (question.length >= 3) conf += 0.05;
  if (!cursorOnContent) conf -= 0.1;
  if (mode === 'password' && /password|passphrase/i.test(pwContext)) conf += 0.05;
  return {
    confidence: conf,
    candidate: {
      ...emptyCandidate(mode, 'text-line', row, row),
      question,
      questionRow: row,
      defaultValue: defaultValue === '' ? null : defaultValue,
      typedText: typed,
      inputLabel,
      hints,
    },
  };
}
