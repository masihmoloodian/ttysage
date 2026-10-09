import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, type HumanChannel, type InteractionRequest, type Resolution, type SessionResult } from '@ttysage/core';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

export class ScriptedChannel implements HumanChannel {
  readonly requests: InteractionRequest[] = [];
  constructor(
    private readonly answer: (req: InteractionRequest, n: number) => Resolution | Promise<Resolution>,
    readonly humanAvailable = true,
    readonly inputProviderAvailable = true,
  ) {}
  async request(req: InteractionRequest): Promise<Resolution> {
    this.requests.push(req);
    return this.answer(req, this.requests.length - 1);
  }
}

export async function runScripted(
  command: string,
  answer: (req: InteractionRequest, n: number) => Resolution | Promise<Resolution>,
  opts: { intent?: string; cwd?: string; timeoutMs?: number; humanAvailable?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ result: SessionResult; channel: ScriptedChannel }> {
  const channel = new ScriptedChannel(answer, opts.humanAvailable ?? true);
  const s = new Session({ command, cwd: opts.cwd ?? FIXTURES, channel, intent: opts.intent, cols: 100, rows: 30, audit: null, env: opts.env });
  s.start();
  const timer = setTimeout(() => void s.kill(), opts.timeoutMs ?? 20_000);
  const result = await s.wait();
  clearTimeout(timer);
  return { result, channel };
}
