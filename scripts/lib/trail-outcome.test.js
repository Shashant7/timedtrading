import { describe, it, expect } from 'vitest';
import outcome from './trail-outcome.cjs';
const { measureOutcome } = outcome;
const trail = prices => prices.map((price, i) => ({ price, ts: 1000 + i * 300000 }));

describe('scoring report first passage', () => {
  it('does not relabel an early stop as a winner after a rally and a deeper drop', () => {
    const r = measureOutcome(trail([100, 98, 102, 97]), 0, 'LONG', 3);
    expect(r).toMatchObject({ isWin: false, isLoss: true, firstBarrier: 'stop', mfe: .02, mae: -.03 });
    expect(r.slFirstTs).toBeLessThan(r.tp1FirstTs);
  });
  it('does not relabel a target-first win when later extrema reverse order', () => {
    const r = measureOutcome(trail([100, 101, 97, 102]), 0, 'LONG', 3);
    expect(r).toMatchObject({ isWin: true, isLoss: false, firstBarrier: 'target' });
    expect(r.tp1FirstTs).toBeLessThan(r.slFirstTs);
  });
  it('uses the same chronological rule for shorts', () => {
    expect(measureOutcome(trail([100, 102, 98, 103]), 0, 'SHORT', 3))
      .toMatchObject({ isWin: false, isLoss: true, firstBarrier: 'stop' });
    expect(measureOutcome(trail([100, 99, 103, 98]), 0, 'SHORT', 3))
      .toMatchObject({ isWin: true, isLoss: false, firstBarrier: 'target' });
  });
  it('does not infer a barrier from missing or invalid price observations', () => {
    expect(measureOutcome(trail([100, null, NaN, 0, 100.1]), 0, 'LONG', 4))
      .toMatchObject({ isWin: false, isLoss: false, firstBarrier: null, tp1FirstTs: null, slFirstTs: null });
  });
  it('reports an incomplete window explicitly and respects the requested horizon', () => {
    expect(measureOutcome(trail([100, 100.1, 98]), 0, 'LONG', 1))
      .toMatchObject({ firstBarrier: null, completeWindow: true });
    expect(measureOutcome(trail([100, 100.1]), 0, 'LONG', 3))
      .toMatchObject({ firstBarrier: null, completeWindow: false });
  });
});
