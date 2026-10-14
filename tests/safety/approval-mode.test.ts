import { describe, it, expect } from 'vitest';
import { agentMayApprove, parseApprovalMode } from '@ttysage/safety';

describe('approval modes', () => {
  it('parses operator settings and fails closed on typos', () => {
    expect(parseApprovalMode(undefined)).toEqual({ mode: 'human' });
    expect(parseApprovalMode(' Bypass ')).toEqual({ mode: 'bypass' });
    expect(parseApprovalMode('agent-high')).toEqual({ mode: 'agent-high' });
    const typo = parseApprovalMode('bypas');
    expect(typo.mode).toBe('human');
    expect(typo.warning).toMatch(/Unknown approval mode/);
  });

  it('human: the agent never approves', () => {
    for (const risk of ['MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'] as const) {
      expect(agentMayApprove('human', { risk, injection: false }, 'confirmation')).toBe(false);
    }
  });

  it('agent-high: HIGH yes; CRITICAL and injection no', () => {
    expect(agentMayApprove('agent-high', { risk: 'HIGH', injection: false }, 'confirmation')).toBe(true);
    expect(agentMayApprove('agent-high', { risk: 'CRITICAL', injection: false }, 'confirmation')).toBe(false);
    expect(agentMayApprove('agent-high', { risk: 'HIGH', injection: true }, 'confirmation')).toBe(false);
  });

  it('ask-user: the agent never approves on its own judgement', () => {
    expect(parseApprovalMode('ask-user')).toEqual({ mode: 'ask-user' });
    expect(agentMayApprove('ask-user', { risk: 'HIGH', injection: false }, 'confirmation')).toBe(false);
  });

  it('bypass: everything except secrets', () => {
    expect(agentMayApprove('bypass', { risk: 'CRITICAL', injection: true }, 'confirmation')).toBe(true);
    expect(agentMayApprove('bypass', { risk: 'MEDIUM', injection: false }, 'password')).toBe(false);
  });
});
