import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { ApprovalQueue, requesterAlive, type QueuedApproval } from '@ttysage/approval';

const entry = (id: string, pid: number, createdAt = new Date().toISOString()): QueuedApproval => ({
  id, createdAt, pid, sessionId: 's', command: 'x', cwd: '/', question: 'q?', promptType: 'selection', risk: 'CRITICAL',
  kind: 'approval', reason: 'r', evidence: [], screen: [], choices: [{ label: 'No' }], allowText: false,
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

describe('approval queue: stale entries', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ttysage-queue-'));

  it('entries of a dead requester are ignored and removed (with their response file)', async () => {
    const q = new ApprovalQueue(dir());
    const pid = await deadPid();
    q.enqueue(entry('dead-1', pid));
    q.respond('dead-1', { choice: 0 });
    q.enqueue(entry('live-1', process.pid));
    expect(q.list().map((e) => e.id)).toEqual(['live-1']);
    expect(fs.existsSync(path.join(q.dir, 'dead-1.json'))).toBe(false);
    expect(fs.existsSync(path.join(q.dir, 'dead-1.response.json'))).toBe(false);
    expect(q.get('dead-1')).toBeNull();
  });

  it('a recycled pid (process started after the entry was queued) does not keep it alive', () => {
    // The test runner's parent started before now; pretend the entry was queued long before it.
    expect(requesterAlive({ pid: process.ppid, createdAt: '2000-01-01T00:00:00.000Z' })).toBe(false);
    expect(requesterAlive({ pid: process.ppid, createdAt: new Date().toISOString() })).toBe(true);
    expect(requesterAlive({ pid: 0, createdAt: new Date().toISOString() })).toBe(false);
  });

  it('old orphan responses and temp files are swept; fresh ones are left alone', () => {
    const q = new ApprovalQueue(dir());
    q.enqueue(entry('live-2', process.pid));
    const orphan = path.join(q.dir, 'gone-1.response.json');
    const tmp = path.join(q.dir, 'gone-2.json.tmp');
    const fresh = path.join(q.dir, 'gone-3.response.json');
    for (const f of [orphan, tmp, fresh]) fs.writeFileSync(f, '{}');
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(orphan, old, old);
    fs.utimesSync(tmp, old, old);
    expect(q.list().map((e) => e.id)).toEqual(['live-2']);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
