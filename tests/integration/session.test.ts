import { describe, it, expect } from 'vitest';
import { runScripted } from '../helpers/scripted';
import type { Resolution } from '@ttysage/core';

const fail = (): Resolution => { throw new Error('unexpected human request'); };
const resultOf = (out: string) => JSON.parse(/RESULT (\{.*\})/.exec(out)![1]!);

describe('Session (real PTY, real prompt libraries)', () => {
  it('inquirer: auto-accepts safe defaults, asks for a preference choice, verifies navigation', async () => {
    const { result, channel } = await runScripted('node inquirer-wizard.mjs', (req) => {
      expect(req.prompt.question).toBe('Select a database:');
      return { type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 1 }, by: 'human' };
    });
    expect(result.exitCode).toBe(0);
    expect(resultOf(result.output)).toEqual({ name: 'demo-app', db: 'MySQL', go: true });
    expect(channel.requests).toHaveLength(1);
    expect(result.interactions.map((i) => i.resolvedBy)).toEqual(['auto', 'human', 'auto']);
  });

  it('intent picks a preference option without asking', async () => {
    const { result, channel } = await runScripted('node inquirer-wizard.mjs', fail, { intent: 'create a project backed by SQLite' });
    expect(resultOf(result.output).db).toBe('SQLite');
    expect(channel.requests).toHaveLength(0);
  });

  it('destructive prompt: never auto-approved; human approval reaches the SAME process', async () => {
    const { result, channel } = await runScripted('node schema-sync.mjs', (req) => {
      expect(req.decision.decision).toBe('ASK_HUMAN');
      expect(req.decision.kind).toBe('approval');
      expect(req.decision.risk).toBe('CRITICAL');
      expect(req.prompt.options.map((o) => o.label)).toEqual(['No, abort', 'Yes, apply changes']);
      return { type: 'action', action: { type: 'CONFIRM', value: 'yes' }, by: 'human' };
    });
    expect(channel.requests).toHaveLength(1);
    expect(result.output).toContain('APPLIED');
    expect(result.exitCode).toBe(0);
  });

  it('destructive prompt + human cancel ⇒ Ctrl+C, original exit code propagated', async () => {
    const { result } = await runScripted('node schema-sync.mjs', () => ({ type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 0 }, by: 'human' }));
    expect(result.output).toContain('ABORTED');
    expect(result.exitCode).toBe(3);
  });

  it('no human available ⇒ DENY (Ctrl+C) instead of guessing', async () => {
    const { result } = await runScripted('node schema-sync.mjs', fail, { humanAvailable: false });
    expect(result.interactions[0]!.resolvedBy).toBe('deny');
    expect(result.output).not.toContain('APPLIED');
    expect(result.exitCode).not.toBe(0);
  });

  it('prompts library: toggle, select, text', async () => {
    const { result } = await runScripted('node prompts-lib.mjs', () => ({ type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 2 }, by: 'human' }));
    expect(resultOf(result.output)).toEqual({ ts: true, color: 'blue', title: 'untitled' });
  });

  it('clack: radio select + confirm', async () => {
    const { result } = await runScripted('node clack.mjs', () => ({ type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 2 }, by: 'human' }));
    expect(resultOf(result.output)).toEqual({ fw: 'react', install: true });
  });

  it('enquirer select', async () => {
    const { result } = await runScripted('node enquirer-lib.mjs', () => ({ type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 1 }, by: 'human' }));
    expect(resultOf(result.output)).toEqual({ pm: 'pnpm' });
  });

  it('never-seen hand-rolled CLI (inverse-video menu + bracket default)', async () => {
    const { result, channel } = await runScripted('node never-seen.mjs', (req) =>
      req.prompt.type === 'selection'
        ? { type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 1 }, by: 'human' }
        : { type: 'action', action: { type: 'TEXT', text: 'prod-like', submit: true }, by: 'agent' });
    expect(channel.requests.map((r) => r.prompt.style)).toEqual(['highlight-list', 'text-line']);
    expect(resultOf(result.output)).toEqual({ target: 'beta cluster', label: 'prod-like' });
  });

  it('prompt injection in output requires a human', async () => {
    const { result, channel } = await runScripted('node injection.mjs', (req) => {
      expect(req.decision.injection).toBe(true);
      return { type: 'action', action: { type: 'CONFIRM', value: 'no' }, by: 'human' };
    });
    expect(channel.requests).toHaveLength(1);
    expect(result.output).toContain('STOPPED');
  });

  it('bash select numbered menu', async () => {
    const { result } = await runScripted('./bash-select.sh', () => ({ type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 1 }, by: 'human' }));
    expect(result.output).toContain('RESULT info');
  });

  it('[Y/n] default auto-accepted', async () => {
    const { result, channel } = await runScripted('./yn.sh', fail);
    expect(channel.requests).toHaveLength(0);
    expect(result.output).toContain('RESULT default');
  });

  it('takeover leaves the prompt to the human and does not re-ask', async () => {
    let n = 0;
    const { result } = await runScripted('printf "Your name: "; read n; echo "RESULT $n"', () => { n++; return { type: 'takeover' }; }, { timeoutMs: 2500 });
    expect(n).toBe(1);
    expect(result.exitCode).not.toBe(0); // killed by the timeout: nobody typed
  });

  it('invalid actions are rejected by the executor, not sent', async () => {
    const { result } = await runScripted('node schema-sync.mjs', (_req, i) =>
      i === 0 ? { type: 'action', action: { type: 'SELECT_OPTION', optionIndex: 9 }, by: 'human' } : { type: 'cancel', by: 'human' }, { timeoutMs: 8000 });
    expect(result.interactions[0]!.executed!.ok).toBe(false);
    expect(result.output).not.toContain('APPLIED');
  });

  it('keypress-submitting confirm: no stray Enter leaks into the next prompt', async () => {
    const { result, channel } = await runScripted('node keypress-confirm.mjs', (req) =>
      req.prompt.type === 'text'
        ? { type: 'action', action: { type: 'TEXT', text: 'from-agent', submit: true }, by: 'agent' }
        : { type: 'action', action: { type: 'CONFIRM', value: 'yes' }, by: 'human' });
    expect(channel.requests.map((r) => r.prompt.type)).toEqual(['confirmation', 'text']);
    expect(resultOf(result.output)).toEqual({ ok: true, name: 'from-agent' });
  });
});
