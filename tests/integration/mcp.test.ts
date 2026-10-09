import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalQueue } from '@ttysage/approval';
import { FIXTURES } from '../helpers/scripted';

const ROOT = path.resolve(FIXTURES, '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttysage-mcp-'));
let client: Client;

type View = { sessionId: string; status: string; exitCode?: number; output: string; pending?: { who: string; prompt: { question: string; options: { index: number; label: string }[] }; decision: { risk: string; kind: string }; approvalId?: string }; error?: string; interactiveEvents: { resolvedBy: string }[] };
async function call(name: string, args: Record<string, unknown>): Promise<View> {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent as View;
}

beforeAll(async () => {
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: path.join(ROOT, 'node_modules/.bin/tsx'),
    args: [path.join(ROOT, 'apps/mcp/src/main.ts')],
    env: { ...process.env, TTYSAGE_HOME: home } as Record<string, string>,
    cwd: FIXTURES,
  }));
}, 30_000);
afterAll(async () => { await client.close(); });

describe('MCP adapter', () => {
  it('lists the interactive tools', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['interactive_shell', 'interactive_respond', 'interactive_status', 'interactive_screen', 'interactive_cancel']));
  });

  it('completes a command with safe prompts automatically', async () => {
    const v = await call('interactive_shell', { command: 'node inquirer-wizard.mjs', cwd: FIXTURES, intent: 'create a project using MySQL' });
    expect(v.status).toBe('completed');
    expect(v.exitCode).toBe(0);
    expect(v.output).toContain('"db":"MySQL"');
    expect(v.interactiveEvents.every((e) => e.resolvedBy === 'auto')).toBe(true);
  }, 30_000);

  it('needs_input → agent answers with a validated action', async () => {
    let v = await call('interactive_shell', { command: 'node inquirer-wizard.mjs', cwd: FIXTURES });
    expect(v.status).toBe('needs_input');
    expect(v.pending!.prompt.question).toBe('Select a database:');
    const bad = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'TEXT', text: 'SQLite' } });
    expect(bad.error).toMatch(/not valid for a selection/);
    v = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'SELECT_OPTION', optionIndex: 2 } });
    expect(v.status).toBe('completed');
    expect(v.output).toContain('"db":"SQLite"');
  }, 30_000);

  it('destructive prompt: agent cannot approve; human approves via the queue; same process continues', async () => {
    let v = await call('interactive_shell', { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('awaiting_human');
    expect(v.pending!.decision).toMatchObject({ risk: 'CRITICAL', kind: 'approval' });
    const denied = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'SELECT_OPTION', optionIndex: 1 } });
    expect(denied.error).toMatch(/requires a human/);
    // The human, in another terminal (`ttysage approvals`), picks "Yes, apply changes".
    const queue = new ApprovalQueue(path.join(home, 'approvals'));
    let pending = queue.list();
    for (let i = 0; i < 50 && !pending.length; i++) { await new Promise((r) => setTimeout(r, 100)); pending = queue.list(); }
    expect(pending).toHaveLength(1);
    const yes = pending[0]!.choices.findIndex((c) => c.label === 'Yes, apply changes');
    queue.respond(pending[0]!.id, { choice: yes });
    v = await call('interactive_status', { sessionId: v.sessionId, waitMs: 10_000 });
    expect(v.status).toBe('completed');
    expect(v.output).toContain('APPLIED');
    expect(v.interactiveEvents[0]!.resolvedBy).toBe('human');
  }, 40_000);

  it('agent may cancel a session waiting for a human', async () => {
    let v = await call('interactive_shell', { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('awaiting_human');
    v = await call('interactive_cancel', { sessionId: v.sessionId });
    expect(v.status).toBe('completed');
    expect(v.output).not.toContain('APPLIED');
  }, 40_000);

  it('elicitation: dismissed ⇒ falls back to the queue; declined ⇒ cancel; accepted ⇒ answer', async () => {
    const mk = async (respond: (labels: string[]) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> }) => {
      const c = new Client({ name: 'elicit-agent', version: '1.0.0' }, { capabilities: { elicitation: {} } });
      c.setRequestHandler(ElicitRequestSchema, async (req) => {
        const labels = ((req.params as unknown as { requestedSchema: { properties: { choice: { enum: string[] } } } }).requestedSchema.properties.choice.enum);
        return respond(labels);
      });
      await c.connect(new StdioClientTransport({ command: path.join(ROOT, 'node_modules/.bin/tsx'), args: [path.join(ROOT, 'apps/mcp/src/main.ts')], env: { ...process.env, TTYSAGE_HOME: home } as Record<string, string>, cwd: FIXTURES }));
      const r = await c.callTool({ name: 'interactive_shell', arguments: { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 } });
      let v = r.structuredContent as View;
      if (v.status === 'awaiting_human') v = (await c.callTool({ name: 'interactive_status', arguments: { sessionId: v.sessionId, waitMs: 4000 } })).structuredContent as View;
      return { c, v };
    };
    const accepted = await mk((labels) => ({ action: 'accept', content: { choice: labels.find((l) => l.includes('Yes, apply changes'))! } }));
    expect(accepted.v.status).toBe('completed');
    expect(accepted.v.output).toContain('APPLIED');
    await accepted.c.close();
    const declined = await mk(() => ({ action: 'decline' }));
    expect(declined.v.status).toBe('completed');
    expect(declined.v.output).not.toContain('APPLIED');
    await declined.c.close();
    const dismissed = await mk(() => ({ action: 'cancel' }));
    expect(dismissed.v.status).toBe('awaiting_human'); // not a decision: still waiting, now in the queue
    expect(new ApprovalQueue(path.join(home, 'approvals')).list().length).toBe(1);
    await call('interactive_cancel', { sessionId: dismissed.v.sessionId }).catch(() => undefined);
    await dismissed.c.close();
  }, 60_000);
});
