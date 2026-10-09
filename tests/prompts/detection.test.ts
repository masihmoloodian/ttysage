import { describe, it, expect } from 'vitest';
import { analyze, A } from '../helpers/screen';

describe('prompt detection & extraction', () => {
  it('inquirer-style arrow selection', async () => {
    const { detection, prompt } = await analyze(`${A.hide}? Select your database: ${A.dim('(Use arrow keys)')}\n${A.cyan('❯ PostgreSQL')}\n  MySQL\n  SQLite`);
    expect(detection.interactive).toBe(true);
    expect(detection.inputMode).toBe('selection');
    expect(detection.confidence).toBeGreaterThan(0.9);
    expect(prompt!.question).toBe('Select your database:');
    expect(prompt!.options.map((o) => o.label)).toEqual(['PostgreSQL', 'MySQL', 'SQLite']);
    expect(prompt!.default).toBe('PostgreSQL');
  });

  it('destructive confirmation list with warning context', async () => {
    const { prompt } = await analyze(`${A.hide}⚠ Warning:\nThis operation will delete existing data.\n\n? Continue?\n❯ No\n  Yes`);
    expect(prompt!.type).toBe('confirmation');
    expect(prompt!.question).toBe('Continue?');
    expect(prompt!.options.map((o) => o.label)).toEqual(['No', 'Yes']);
    expect(prompt!.default).toBe('No');
    expect(prompt!.context.join('\n')).toContain('delete existing data');
  });

  it('clack-style radio list with gutter', async () => {
    const { prompt } = await analyze(`${A.hide}┌  create-app\n│\n◆  Select a framework:\n│  ● Vanilla\n│  ○ Vue\n│  ○ React\n└`);
    expect(prompt!.type).toBe('selection');
    expect(prompt!.style).toBe('radio-list');
    expect(prompt!.question).toBe('Select a framework:');
    expect(prompt!.options.map((o) => o.label)).toEqual(['Vanilla', 'Vue', 'React']);
    expect(prompt!.selectedIndex).toBe(0);
  });

  it('checkbox list', async () => {
    const { prompt } = await analyze(`${A.hide}? Which features? (Press <space> to select, <a> to toggle all)\n❯◉ TypeScript\n ◯ ESLint\n ◉ Prettier`);
    expect(prompt!.type).toBe('selection');
    expect(prompt!.multiple).toBe(true);
    expect(prompt!.options.map((o) => [o.label, o.checked])).toEqual([['TypeScript', true], ['ESLint', false], ['Prettier', true]]);
    expect(prompt!.question).toBe('Which features?');
  });

  it('(y/N) confirmation', async () => {
    const { prompt } = await analyze(`? Overwrite config? (y/N) `);
    expect(prompt!.type).toBe('confirmation');
    expect(prompt!.style).toBe('yes-no');
    expect(prompt!.default).toBe('No');
    expect(prompt!.answerForm).toBe('letter');
    expect(prompt!.question).toBe('Overwrite config?');
  });

  it('[Y/n] and (yes/no) word forms', async () => {
    const a = await analyze(`Do you want to continue? [Y/n] `);
    expect(a.prompt!.default).toBe('Yes');
    const b = await analyze(`Are you sure you want to continue connecting (yes/no/[fingerprint])? `);
    expect(b.prompt!.type).toBe('confirmation');
    expect(b.prompt!.answerForm).toBe('word');
    expect(b.prompt!.default).toBe(null);
  });

  it('text prompt with default in parentheses', async () => {
    const { prompt } = await analyze(`This utility will walk you through.\n\npackage name: (my-app) `);
    expect(prompt!.type).toBe('text');
    expect(prompt!.question).toBe('package name');
    expect(prompt!.default).toBe('my-app');
  });

  it('text prompt without default, generic label resolves to the real question', async () => {
    const { prompt } = await analyze(`Plan: 1 to add, 0 to change, 0 to destroy.\n\nDo you want to perform these actions?\n  Only 'yes' will be accepted to approve.\n\n  Enter a value: `);
    expect(prompt!.type).toBe('text');
    expect(prompt!.question).toBe('Do you want to perform these actions?');
    expect(prompt!.inputLabel).toBe('Enter a value');
    expect(prompt!.default).toBe(null);
  });

  it('password prompt', async () => {
    const { prompt } = await analyze(`[sudo] password for dev: `);
    expect(prompt!.type).toBe('password');
  });

  it('numbered menu', async () => {
    const { prompt } = await analyze(`Select a region:\n  1) us-east-1\n  2) eu-west-1\n  3) ap-south-1\nEnter choice [1]: `);
    expect(prompt!.type).toBe('selection');
    expect(prompt!.style).toBe('numbered');
    expect(prompt!.options.map((o) => o.number)).toEqual(['1', '2', '3']);
    expect(prompt!.default).toBe('us-east-1');
    expect(prompt!.question).toBe('Select a region:');
  });

  it('inline toggle (prompts-style) selected by style', async () => {
    const { prompt } = await analyze(`${A.hide}? Use TypeScript? › ${A.cyan(A.underline('No'))} / Yes`);
    expect(prompt!.style).toBe('inline-choice');
    expect(prompt!.type).toBe('confirmation');
    expect(prompt!.options.map((o) => o.label)).toEqual(['No', 'Yes']);
    expect(prompt!.selectedIndex).toBe(0);
  });

  it('inline radio (clack confirm)', async () => {
    const { prompt } = await analyze(`${A.hide}◆  Install dependencies?\n│  ● Yes / ○ No\n└`);
    expect(prompt!.type).toBe('confirmation');
    expect(prompt!.options[prompt!.selectedIndex!]!.label).toBe('Yes');
  });

  it('highlight-only list (inverse video, no glyphs)', async () => {
    const { prompt } = await analyze(`${A.hide}Choose environment:\n  staging\n${A.inverse('  development')}\n  preview`);
    expect(prompt!.style).toBe('highlight-list');
    expect(prompt!.options[prompt!.selectedIndex!]!.label).toBe('development');
  });

  it('editor in alternate screen', async () => {
    const { detection } = await analyze(`${A.alt}\x1b[Hpick abc123 one\npick def456 two\n~\n~\n~\n"git-rebase-todo" 20L`);
    expect(detection.inputMode).toBe('editor');
    expect(detection.interactive).toBe(true);
  });

  it('full-screen TUI without editor markers', async () => {
    const { detection } = await analyze(`${A.alt}\x1b[H CPU 12%  MEM 40%\n PID  NAME\n 1    init`);
    expect(detection.inputMode).toBe('tui');
  });

  it('a spinner / short idle is not interactive yet', async () => {
    const { detection } = await analyze(`? Continue? (y/N) `, { idleMs: 50 });
    expect(detection.interactive).toBe(false);
    expect(detection.recheckAfterMs).toBeGreaterThan(0);
  });

  it('plain output with long silence is uncertain, not interactive', async () => {
    const { detection } = await analyze(`Building project...\nCompiling 120 files`);
    expect(detection.interactive).toBe('uncertain');
    expect(detection.confidence).toBeLessThan(0.85);
  });

  it('bulleted output above the bottom is not mistaken for a menu', async () => {
    const { detection } = await analyze(`Changes:\n* added foo\n* added bar\nRunning tests...\nAll good, still working`);
    expect(detection.inputMode).not.toBe('selection');
  });

  it('answered prompts above the active one are ignored', async () => {
    const { prompt } = await analyze(`${A.hide}✔ Project name: demo\n✔ Language: TypeScript\n? Package manager: (Use arrow keys)\n❯ npm\n  pnpm\n  yarn`);
    expect(prompt!.question).toBe('Package manager:');
    expect(prompt!.options).toHaveLength(3);
  });

  it('scrolling list marks truncated', async () => {
    const { prompt } = await analyze(`${A.hide}? Pick a timezone:\n  UTC\n❯ Europe/Berlin\n  Asia/Tokyo\n(Move up and down to reveal more choices)`);
    expect(prompt!.options).toHaveLength(3);
    expect(prompt!.selectedIndex).toBe(1);
  });
});
