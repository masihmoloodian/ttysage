import { HeadlessTerminal, type ScreenSnapshot } from '@ttysage/terminal';
import { detect, type Detection } from '@ttysage/detector';
import { understand, type PromptModel } from '@ttysage/prompt-understanding';

export async function render(ansi: string, cols = 100, rows = 24): Promise<{ snap: ScreenSnapshot; term: HeadlessTerminal }> {
  const term = new HeadlessTerminal({ cols, rows });
  await term.write(ansi.replace(/\r?\n/g, '\r\n'));
  return { snap: term.snapshot(), term };
}

export async function analyze(ansi: string, opts: { cols?: number; rows?: number; idleMs?: number } = {}): Promise<{ detection: Detection; prompt: PromptModel | null; snap: ScreenSnapshot }> {
  const { snap, term } = await render(ansi, opts.cols, opts.rows);
  const detection = detect(snap, { idleMs: opts.idleMs ?? 5000, processAlive: true });
  const prompt = understand(detection, snap, { contextLines: term.textSince(0) });
  term.dispose();
  return { detection, prompt, snap };
}

/** ANSI helpers for building fixtures. */
export const A = {
  clear: '\x1b[2J\x1b[H',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
  up: (n: number) => `\x1b[${n}A`,
  col: (n: number) => `\x1b[${n}G`,
  alt: '\x1b[?1049h',
};
