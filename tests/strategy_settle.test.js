/**
 * Unit tests for Strategy Tester settle detection (src/core/data.js).
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Regression cover for "The table did not settle after 60s": the old wait
 * broke out as soon as reportData exposed a `performance` object, which is
 * true immediately after a symbol switch because the PREVIOUS symbol's report
 * is still attached. Callers got stale numbers that kept changing underneath
 * them, so an external poller never saw the table settle.
 *
 * Run: node --test tests/strategy_settle.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureStrategyTesterReady } from '../src/core/data.js';

// First evaluate() call is the unhide/open-panel step; every later call is a
// settle probe drawn from `probes` (the last entry repeats forever).
function mockEvaluate(probes, { unhidden = [] } = {}) {
  let first = true;
  let i = 0;
  const fn = async () => {
    if (first) { first = false; return unhidden; }
    const p = probes[Math.min(i, probes.length - 1)];
    i++;
    return p;
  };
  fn.probeCount = () => i;
  return fn;
}

const computed = (signature, extra = {}) => ({
  state: 'computed', signature, symbol: 'FXPRO:XAUUSD', resolution: '240', ...extra,
});

describe('ensureStrategyTesterReady() — settle detection', () => {
  it('reports ready once the report holds steady', async () => {
    const evaluate = mockEvaluate([computed('100|200|-100|5|3|-50|8')]);
    const r = await ensureStrategyTesterReady(5000, { evaluate });
    assert.equal(r.status, 'ready');
  });

  it('does NOT settle while the report is still being recomputed', async () => {
    // Numbers change on every poll — the old presence-only check returned
    // "ready" on the very first one of these.
    let n = 0;
    const changing = async () => (n === 0 ? (n++, []) : computed(`${n++}|0|0|0|0|0|0`));
    const r = await ensureStrategyTesterReady(1500, { evaluate: changing });
    assert.equal(r.status, 'timeout');
    assert.ok(n > 2, 'should have polled repeatedly rather than returning at once');
  });

  it('waits out a recompute, then reports ready on the final figures', async () => {
    const evaluate = mockEvaluate([
      computed('1|0|0|0|0|0|0'),
      computed('50|0|0|0|0|0|0'),
      computed('final'), computed('final'), computed('final'), computed('final'),
    ]);
    const r = await ensureStrategyTesterReady(8000, { evaluate });
    assert.equal(r.status, 'ready');
  });

  it('discards accumulated stability if the report drops back to pending', async () => {
    const evaluate = mockEvaluate([
      computed('stale'), computed('stale'),      // previous symbol's report
      { state: 'pending', symbol: 'FXPRO:XAGUSD', resolution: '240' }, // recompute starts
      computed('fresh'), computed('fresh'),
    ]);
    // Only two stable 'fresh' polls before the deadline — not enough.
    const r = await ensureStrategyTesterReady(1600, { evaluate });
    assert.equal(r.status, 'timeout');
  });

  it('returns immediately when there is no strategy on the chart', async () => {
    const evaluate = mockEvaluate([{ state: 'no-strategy' }]);
    const r = await ensureStrategyTesterReady(5000, { evaluate });
    assert.equal(r.status, 'no-strategy');
  });

  it('reports the symbol/resolution the report was read under', async () => {
    const evaluate = mockEvaluate([computed('x', { symbol: 'FXPRO:GBPJPY', resolution: '60' })]);
    const r = await ensureStrategyTesterReady(5000, { evaluate });
    assert.equal(r.symbol, 'FXPRO:GBPJPY');
    assert.equal(r.resolution, '60');
  });

  it('passes through strategies it had to unhide', async () => {
    const evaluate = mockEvaluate([computed('x')], { unhidden: ['ICC Strategy'] });
    const r = await ensureStrategyTesterReady(5000, { evaluate });
    assert.deepEqual(r.unhidden, ['ICC Strategy']);
  });
});
