import { createRequire } from 'node:module';
import type { Terminal as XTerminal, IBufferCell } from '@xterm/headless';

const require = createRequire(import.meta.url);
// @xterm/headless ships CommonJS.
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/** A run of cells sharing the same visual style. Columns are [start, end). */
export interface StyleRun {
  start: number;
  end: number;
  inverse: boolean;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  italic: boolean;
  /** -1 = default colour; otherwise palette index or 0xRRGGBB (with rgb=true). */
  fg: number;
  bg: number;
}

export interface ScreenRow {
  text: string;
  runs: StyleRun[];
  /** True when this physical row continues the previous one (soft wrap). */
  wrapped: boolean;
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  /** Visible rows, right-trimmed. */
  lines: string[];
  styled: ScreenRow[];
  cursor: { row: number; col: number };
  cursorVisible: boolean;
  altScreen: boolean;
  applicationCursorKeys: boolean;
  /** Absolute buffer index of the top visible row (scrollback length in the normal buffer). */
  baseY: number;
}

export interface HeadlessTerminalOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

/**
 * Headless VT emulator. Feeds raw PTY output through xterm.js so we reason about the screen
 * a human would see — not the byte stream.
 */
export class HeadlessTerminal {
  private readonly term: XTerminal;
  private cursorHidden = false;
  private tail = '';
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: HeadlessTerminalOptions = {}) {
    this.term = new Terminal({
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
      scrollback: opts.scrollback ?? 5000,
      allowProposedApi: true,
    });
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  /** Write PTY output. Resolves when xterm has parsed it. */
  write(data: string): Promise<void> {
    this.trackCursorVisibility(data);
    const p = new Promise<void>((resolve) => this.term.write(data, resolve));
    this.pending = p;
    return p;
  }

  /** Wait until all writes so far are parsed. */
  flush(): Promise<void> {
    return this.pending;
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows);
  }

  // DECTCEM (ESC[?25l / ESC[?25h) is not exposed by the public API, so track it from the stream.
  private trackCursorVisibility(data: string): void {
    const s = this.tail + data;
    const hide = s.lastIndexOf('\x1b[?25l');
    const show = s.lastIndexOf('\x1b[?25h');
    if (hide !== -1 || show !== -1) this.cursorHidden = hide > show;
    // A full reset (RIS) restores the cursor.
    if (s.lastIndexOf('\x1bc') > Math.max(hide, show)) this.cursorHidden = false;
    this.tail = s.slice(-8);
  }

  snapshot(): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const styled: ScreenRow[] = [];
    const cell = buf.getNullCell();
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) {
        lines.push('');
        styled.push({ text: '', runs: [], wrapped: false });
        continue;
      }
      const text = line.translateToString(true);
      lines.push(text);
      styled.push({ text, runs: extractRuns(line, this.term.cols, cell), wrapped: line.isWrapped });
    }
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      lines,
      styled,
      cursor: { row: buf.cursorY, col: buf.cursorX },
      cursorVisible: !this.cursorHidden,
      altScreen: buf.type === 'alternate',
      applicationCursorKeys: this.term.modes.applicationCursorKeysMode,
      baseY: buf.baseY,
    };
  }

  /** Absolute index (scrollback + viewport) of the line the cursor is on. */
  absoluteCursorLine(): number {
    const buf = this.term.buffer.active;
    return buf.baseY + buf.cursorY;
  }

  /** Total lines in the active buffer. */
  get length(): number {
    return this.term.buffer.active.length;
  }

  /**
   * Logical text from absolute line `from` to the end of the active buffer. Soft-wrapped rows are joined.
   */
  textSince(from = 0): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = Math.max(0, from); i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    return out;
  }

  /**
   * Logical lines for physical rows [from, to) of the NORMAL buffer (scrollback + screen).
   * Used to stream rendered output to non-TTY consumers.
   */
  normalRows(from: number, to?: number): { lines: string[]; next: number } {
    const buf = this.term.buffer.normal;
    let end = Math.min(to ?? buf.length, buf.length);
    if (to === undefined) {
      while (end > from && (buf.getLine(end - 1)?.translateToString(true).trim() ?? '') === '') end--;
    }
    // Never split a soft-wrapped logical line.
    while (end < buf.length && buf.getLine(end)?.isWrapped) end++;
    const lines: string[] = [];
    for (let i = Math.max(0, from); i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0 && i > from) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return { lines, next: Math.max(from, end) };
  }

  /** Rows of the normal buffer that have scrolled into scrollback. */
  normalScrollback(): number {
    return this.term.buffer.normal.baseY;
  }

  /** Absolute row of the cursor in the normal buffer (alt-screen content is excluded). */
  normalCursorLine(): number {
    const b = this.term.buffer.normal;
    return b.baseY + b.cursorY;
  }

  /** Everything the program printed (normal buffer: scrollback + screen), as plain text. */
  fullText(): string {
    return this.textSince(0).join('\n');
  }

  dispose(): void {
    this.term.dispose();
  }
}

function extractRuns(
  line: NonNullable<ReturnType<XTerminal['buffer']['active']['getLine']>>,
  cols: number,
  cell: IBufferCell,
): StyleRun[] {
  const runs: StyleRun[] = [];
  let current: StyleRun | null = null;
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    if (c.getWidth() === 0) continue; // trailing half of a wide char
    const style = {
      inverse: c.isInverse() !== 0,
      bold: c.isBold() !== 0,
      dim: c.isDim() !== 0,
      underline: c.isUnderline() !== 0,
      italic: c.isItalic() !== 0,
      fg: c.isFgDefault() ? -1 : c.getFgColor(),
      bg: c.isBgDefault() ? -1 : c.getBgColor(),
    };
    if (
      current &&
      current.inverse === style.inverse && current.bold === style.bold && current.dim === style.dim &&
      current.underline === style.underline && current.italic === style.italic &&
      current.fg === style.fg && current.bg === style.bg
    ) {
      current.end = x + c.getWidth();
    } else {
      current = { start: x, end: x + c.getWidth(), ...style };
      runs.push(current);
    }
  }
  return runs;
}

/** True when the cells covering [start, end) are visually emphasised (inverse / bg colour). */
export function isEmphasised(row: ScreenRow, start: number, end: number): boolean {
  let covered = 0;
  for (const r of row.runs) {
    const s = Math.max(r.start, start);
    const e = Math.min(r.end, end);
    if (e > s && (r.inverse || r.bg !== -1)) covered += e - s;
  }
  return end > start && covered / (end - start) > 0.6;
}

/** The dominant style signature of [start, end) — used to spot the one option styled differently. */
export function styleSignature(row: ScreenRow, start: number, end: number): string {
  let best: StyleRun | null = null;
  let bestLen = 0;
  for (const r of row.runs) {
    const len = Math.min(r.end, end) - Math.max(r.start, start);
    if (len > bestLen) { best = r; bestLen = len; }
  }
  if (!best) return '';
  return [best.inverse ? 'I' : '', best.bold ? 'B' : '', best.dim ? 'D' : '', best.underline ? 'U' : '', `f${best.fg}`, `b${best.bg}`].join('');
}
