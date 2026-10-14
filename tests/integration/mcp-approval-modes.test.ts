import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FIXTURES } from '../helpers/scripted';

const ROOT = path.resolve(FIXTURES, '../..');
type View = { sessionId: string; status: string; approvalMode: string; output: string; error?: string; pending?: { who: string; delegatedApproval?: boolean; askUser?: boolean; decision: { risk: string } }; interactiveEvents: { resolvedBy: string }[] };
const clients: Client[] = [];

/** `autoDecline`: a client that advertises elicitation but declines at once without a dialog (Claude Code in bypass mode). */
async function server(mode: string | undefined, autoDecline = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ttysage-mode-'));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TTYSAGE_HOME: home };
  if (mode === undefined) delete env.TTYSAGE_APPROVAL_MODE; else env.TTYSAGE_APPROVAL_MODE = mode;
  const c = new Client({ name: 'mode-agent', version: '1.0.0' }, autoDecline ? { capabilities: { elicitation: {} } } : {});
  if (autoDecline) c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
  await c.connect(new StdioClientTransport({ command: path.join(ROOT, 'node_modules/.bin/tsx'), args: [path.join(ROOT, 'apps/mcp/src/main.ts')], env, cwd: FIXTURES, stderr: 'ignore' }));
  clients.push(c);
  const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })).structuredContent as View;
  return { c, call, home };
}
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); });

const auditOf = (home: string) => fs.readdirSync(path.join(home, 'audit')).flatMap((f) => fs.readFileSync(path.join(home, 'audit', f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));

describe('MCP approval modes (operator-chosen)', () => {
  it('default human: HIGH prompt waits for a human; the agent cannot enable bypass via tool input', async () => {
    const { call } = await server(undefined);
    const v = await call('interactive_shell', { command: 'node deploy-confirm.mjs', cwd: FIXTURES, waitMs: 10_000, approvalMode: 'bypass' });
    expect(v.approvalMode).toBe('human');
    expect(v.status).toBe('awaiting_human');
    const r = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'CONFIRM', value: 'yes' } });
    expect(r.error).toMatch(/requires a human/);
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);

  it('agent-high: agent approves a HIGH prompt; it is audited with the mode', async () => {
    const { call, home } = await server('agent-high');
    let v = await call('interactive_shell', { command: 'node deploy-confirm.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.approvalMode).toBe('agent-high');
    expect(v.status).toBe('needs_input');
    expect(v.pending).toMatchObject({ who: 'agent', delegatedApproval: true, decision: { risk: 'HIGH' } });
    v = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'CONFIRM', value: 'yes' } });
    expect(v.status).toBe('completed');
    expect(v.output).toContain('DEPLOYED');
    const ev = auditOf(home).find((e) => e.type === 'interaction');
    expect(ev).toMatchObject({ resolvedBy: 'agent', approvalMode: 'agent-high', risk: 'HIGH' });
  }, 40_000);

  it('agent-high: CRITICAL data loss still waits for a human', async () => {
    const { call } = await server('agent-high');
    const v = await call('interactive_shell', { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('awaiting_human');
    expect(v.pending!.decision.risk).toBe('CRITICAL');
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);

  it('agent-high: prompt-injection attempts still wait for a human', async () => {
    const { call } = await server('agent-high');
    const v = await call('interactive_shell', { command: 'node injection.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('awaiting_human');
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);

  it('bypass: agent approves CRITICAL data loss without a human', async () => {
    const { call, home } = await server('bypass');
    let v = await call('interactive_shell', { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('needs_input');
    expect(v.pending).toMatchObject({ delegatedApproval: true, decision: { risk: 'CRITICAL' } });
    v = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'CONFIRM', value: 'yes' } });
    expect(v.output).toContain('APPLIED');
    expect(auditOf(home).find((e) => e.type === 'interaction')).toMatchObject({ resolvedBy: 'agent', approvalMode: 'bypass', risk: 'CRITICAL' });
  }, 40_000);

  it('bypass: passwords are still never agent-answerable', async () => {
    const { call } = await server('bypass');
    const v = await call('interactive_shell', { command: 'printf "Password: "; stty -echo; read p; stty echo; echo done', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('blocked');
    const r = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'TEXT', text: 'hunter2' } });
    expect(r.error).toMatch(/human|secret/i);
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);

  it('a typo in the setting fails closed to human', async () => {
    const { call } = await server('bypas');
    const v = await call('interactive_shell', { command: 'node deploy-confirm.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.approvalMode).toBe('human');
    expect(v.status).toBe('awaiting_human');
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);

  it('an instant client decline is not a human "no": human mode falls back to the approval queue', async () => {
    const { call } = await server(undefined, true);
    const v = await call('interactive_shell', { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('awaiting_human');
    expect(v.interactiveEvents.some((e) => e.resolvedBy === 'cancel')).toBe(false);
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);

  it('ask-user: with no client dialog, the agent relays the user\'s choice for a CRITICAL prompt', async () => {
    const { call, home } = await server('ask-user', true);
    let v = await call('interactive_shell', { command: 'node schema-sync.mjs', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.approvalMode).toBe('ask-user');
    expect(v.status).toBe('needs_input');
    expect(v.pending).toMatchObject({ who: 'agent', askUser: true, delegatedApproval: true, decision: { risk: 'CRITICAL' } });
    v = await call('interactive_respond', { sessionId: v.sessionId, action: { type: 'CONFIRM', value: 'yes' } });
    expect(v.output).toContain('APPLIED');
    expect(auditOf(home).find((e) => e.type === 'interaction')).toMatchObject({ resolvedBy: 'agent', approvalMode: 'ask-user', risk: 'CRITICAL' });
  }, 40_000);

  it('ask-user: passwords are still never agent-answerable', async () => {
    const { call } = await server('ask-user', true);
    const v = await call('interactive_shell', { command: 'printf "Password: "; stty -echo; read p; stty echo; echo done', cwd: FIXTURES, waitMs: 10_000 });
    expect(v.status).toBe('blocked');
    await call('interactive_cancel', { sessionId: v.sessionId });
  }, 40_000);
});
