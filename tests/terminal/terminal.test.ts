import { describe, it, expect } from 'vitest';
import { HeadlessTerminal } from '@ttysage/terminal';
import { render, A } from '../helpers/screen';

describe('HeadlessTerminal', () => {
  it('turns ANSI output into a screen state (spec example)', async () => {
    const { snap } = await render(`${A.clear}? Select database:\n${A.green('❯ PostgreSQL')}\n  MySQL\n  SQLite\x1b[2;3H`);
    expect(snap.lines.slice(0, 4)).toEqual(['? Select database:', '❯ PostgreSQL', '  MySQL', '  SQLite']);
    expect(snap.cursor).toEqual({ row: 1, col: 2 });
  });

  it('applies cursor movement and line erasure (redraws)', async () => {
    const { snap } = await render(`loading 10%\r\x1b[Kloading 100%\nline2\x1b[1A\x1b[2K\rreplaced`);
    expect(snap.lines[0]).toBe('replaced');
    expect(snap.lines[1]).toBe('line2');
  });

  it('tracks alternate screen and restores the main screen', async () => {
    const t = new HeadlessTerminal({ cols: 40, rows: 10 });
    await t.write('main text\r\n');
    await t.write('\x1b[?1049h\x1b[Hfull screen app');
    expect(t.snapshot().altScreen).toBe(true);
    expect(t.snapshot().lines[0]).toBe('full screen app');
    await t.write('\x1b[?1049l');
    expect(t.snapshot().altScreen).toBe(false);
    expect(t.snapshot().lines[0]).toBe('main text');
  });

  it('tracks cursor visibility (DECTCEM) and application cursor mode', async () => {
    const t = new HeadlessTerminal();
    await t.write(A.hide);
    expect(t.snapshot().cursorVisible).toBe(false);
    await t.write(`${A.show}\x1b[?1h`);
    expect(t.snapshot().cursorVisible).toBe(true);
    expect(t.snapshot().applicationCursorKeys).toBe(true);
  });

  it('exposes style runs (inverse / colour)', async () => {
    const { snap } = await render(`  one\n${A.inverse('  two')}\n`);
    expect(snap.styled[1]!.runs.some((r) => r.inverse)).toBe(true);
    expect(snap.styled[0]!.runs.some((r) => r.inverse)).toBe(false);
  });

  it('keeps scrollback and joins soft-wrapped lines', async () => {
    const t = new HeadlessTerminal({ cols: 10, rows: 3 });
    await t.write('a\r\nb\r\nc\r\nd\r\n0123456789abc');
    expect(t.textSince(0)).toEqual(['a', 'b', 'c', 'd', '0123456789abc']);
  });

  it('resizes', async () => {
    const t = new HeadlessTerminal({ cols: 10, rows: 3 });
    t.resize(50, 7);
    expect(t.snapshot().cols).toBe(50);
    expect(t.snapshot().rows).toBe(7);
  });
});
