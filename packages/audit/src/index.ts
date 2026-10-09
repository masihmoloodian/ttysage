import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactDeep } from '@ttysage/safety';

export function ttysageHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TTYSAGE_HOME ?? path.join(os.homedir(), '.ttysage');
}

export type AuditEvent =
  | ({ type: 'session_start' } & AuditBase & { cwd: string; intent?: string; pid?: number; mode: string })
  | ({ type: 'interaction' } & AuditBase & InteractionAudit)
  | ({ type: 'session_end' } & AuditBase & { exitCode: number; signal: number | null; durationMs: number; interactions: number; autoAnswered: number; humanAnswered: number; denied: number });

interface AuditBase {
  timestamp: string;
  sessionId: string;
  command: string;
}

export interface InteractionAudit {
  interactionId: string;
  intent?: string;
  prompt: string;
  promptType: string;
  options: string[];
  default: string | null;
  detectionConfidence: number;
  decision: string;
  kind: string;
  risk: string;
  confidence: number;
  reason: string;
  signals: string[];
  injection: boolean;
  intentMismatch: boolean;
  llmUsed: boolean;
  /** Who resolved it: auto | human | agent | takeover | cancel | deny */
  resolvedBy: string;
  humanDecision?: string;
  /** Description of what was sent (secrets never included). */
  answerSent: string | null;
  executed: boolean;
  executionDetail?: string;
  latencyMs: number;
}

/** Append-only JSONL audit log, one file per day, 0600, deep-redacted. */
export class AuditLogger {
  readonly dir: string;
  private readonly enabled: boolean;

  constructor(opts: { dir?: string; enabled?: boolean } = {}) {
    this.dir = opts.dir ?? path.join(ttysageHome(), 'audit');
    this.enabled = opts.enabled ?? process.env.TTYSAGE_AUDIT !== 'off';
  }

  get file(): string {
    return path.join(this.dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  log(event: AuditEvent): void {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, `${JSON.stringify(redactDeep(event))}\n`, { mode: 0o600 });
    } catch {
      // Auditing must never break the user's command.
    }
  }

  /** Most recent events across files, newest last. */
  readRecent(limit = 50): AuditEvent[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).sort().reverse();
    const out: AuditEvent[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        try { out.push(JSON.parse(l) as AuditEvent); } catch { /* skip corrupt line */ }
        if (out.length >= limit) return out.reverse();
      }
    }
    return out.reverse();
  }
}
