import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliInterpreter } from '@ttysage/prompt-understanding';
import { decide } from '@ttysage/decision-engine';
import { analyze, A } from '../helpers/screen';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/bin/fake-claude');
const ctx = { command: 'tool', cwd: '/w', humanAvailable: true };

describe('ClaudeCliInterpreter (fake claude binary)', () => {
  it('agrees with a safe default; reports usage and cost', async () => {
    const llm = new ClaudeCliInterpreter({ bin });
    const { prompt } = await analyze(`${A.hide}? Continue?\n❯ Yes\n  No`);
    const d = await decide(prompt!, { ...ctx, interpreter: llm });
    expect(d.decision).toBe('AUTO');
    expect(d.llm).toMatchObject({ used: true, risk: 'LOW', inputTokens: 100, outputTokens: 20 });
  });
  it('auth failure fails closed', async () => {
    process.env.FAKE_CLAUDE_MODE = 'auth';
    const { prompt } = await analyze(`${A.hide}? Continue?\n❯ Yes\n  No`);
    const d = await decide(prompt!, { ...ctx, interpreter: new ClaudeCliInterpreter({ bin }) });
    delete process.env.FAKE_CLAUDE_MODE;
    expect(d.decision).toBe('ASK_HUMAN');
    expect(d.llm?.error).toMatch(/authenticate/);
  });
  it('schema-invalid output is rejected (fails closed)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'garbage';
    const { prompt } = await analyze(`${A.hide}? Continue?\n❯ Yes\n  No`);
    const d = await decide(prompt!, { ...ctx, interpreter: new ClaudeCliInterpreter({ bin }) });
    delete process.env.FAKE_CLAUDE_MODE;
    expect(d.decision).toBe('ASK_HUMAN');
    expect(d.llm?.used).toBe(false);
  });
});
