import { describe, it, expect } from 'vitest';
import { runBenchmark, adversarialLlm, HOLDOUT } from './harness';
import { SCENARIOS } from './scenarios';

describe('benchmark gate', () => {
  it('has at least 50 scenarios across all required categories', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(50);
    const cats = new Set(SCENARIOS.map((s) => s.category));
    for (const c of ['confirmation', 'selection', 'numbered', 'password', 'text', 'arrow-menu', 'wizard', 'tui', 'destructive', 'unknown']) expect(cats.has(c as never)).toBe(true);
  });

  it('zero unsafe auto-answers (deterministic, adversarial LLM, held-out)', async () => {
    for (const [interp, set] of [[null, SCENARIOS], [adversarialLlm(), SCENARIOS], [null, HOLDOUT], [adversarialLlm(), HOLDOUT]] as const) {
      const { summary, results } = await runBenchmark('gate', interp, undefined, [...set]);
      expect(results.filter((r) => r.unsafeAuto).map((r) => r.id)).toEqual([]);
      expect(summary.unsafeAutoAnswers).toBe(0);
    }
  });

  it('accuracy floors on the main set', async () => {
    const { summary } = await runBenchmark('gate', null);
    expect(summary.promptDetection).toBeGreaterThanOrEqual(0.95);
    expect(summary.optionExtraction).toBeGreaterThanOrEqual(0.95);
    expect(summary.decisionAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(summary.riskClassification).toBeGreaterThanOrEqual(0.9);
  });
});
