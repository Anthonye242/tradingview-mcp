/**
 * Unit tests for chart readiness waiting (src/wait.js).
 * Pure unit (mocked CDP eval) — no TradingView Desktop required.
 *
 * Regression cover for the nightly-backtest failures:
 *   - "Symbol change failed twice"  — exchange-qualified symbols never matched
 *   - "table did not settle after 60s" — readiness returned true while bars
 *     were still streaming, so the backtest was read mid-recompute.
 *
 * Run: node --test tests/wait.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForChartReady, normalizeSymbol, normalizeResolution, symbolMatches } from '../src/wait.js';

// Feeds a scripted sequence of chart probe results, one per poll. The last
// entry repeats forever so a test can assert on timeout behaviour.
function mockEvaluate(states) {
  let i = 0;
  const fn = async () => {
    const s = states[Math.min(i, states.length - 1)];
    i++;
    return s;
  };
  fn.polls = () => i;
  return fn;
}

const bars = (barCount, lastBarTime, extra = {}) => ({
  ok: true, symbol: 'FXPRO:XAUUSD', resolution: '240', barCount, lastBarTime, ...extra,
});

describe('normalizeSymbol()', () => {
  it('strips the exchange prefix and uppercases', () => {
    assert.equal(normalizeSymbol('FXPRO:XAUUSD'), 'XAUUSD');
    assert.equal(normalizeSymbol('nymex:cl1!'), 'CL1!');
    assert.equal(normalizeSymbol(' xauusd '), 'XAUUSD');
  });

  it('returns empty string for nullish input', () => {
    assert.equal(normalizeSymbol(null), '');
    assert.equal(normalizeSymbol(undefined), '');
  });
});

describe('normalizeResolution()', () => {
  it('folds the redundant 1-prefix on day/week/month', () => {
    assert.equal(normalizeResolution('1D'), 'D');
    assert.equal(normalizeResolution('D'), 'D');
    assert.equal(normalizeResolution('1W'), 'W');
  });

  it('normalizes minute counts without collapsing 1-minute', () => {
    assert.equal(normalizeResolution('060'), '60');
    assert.equal(normalizeResolution('240'), '240');
    assert.equal(normalizeResolution('1'), '1'); // 1 minute, NOT a day
  });
});

describe('symbolMatches()', () => {
  it('matches an exchange-qualified request against a bare resolved symbol', () => {
    // The old DOM check did legend.includes(expected), which is false here —
    // this is exactly what made every FXPRO symbol change report failure.
    assert.equal(symbolMatches('XAUUSD', 'FXPRO:XAUUSD'), true);
    assert.equal(symbolMatches('FXPRO:XAUUSD', 'XAUUSD'), true);
    assert.equal(symbolMatches('FXPRO:XAUUSD', 'FXPRO:XAUUSD'), true);
  });

  it('does not match unrelated symbols', () => {
    assert.equal(symbolMatches('FXPRO:XAGUSD', 'FXPRO:XAUUSD'), false);
    assert.equal(symbolMatches('', 'XAUUSD'), false);
  });
});

describe('waitForChartReady()', () => {
  it('resolves true for an exchange-qualified symbol once bars are stable', async () => {
    const evaluate = mockEvaluate([bars(300, 1000)]);
    const ready = await waitForChartReady('FXPRO:XAUUSD', '240', 5000, { evaluate });
    assert.equal(ready, true);
  });

  it('accepts a bare request against an exchange-prefixed resolved symbol', async () => {
    const evaluate = mockEvaluate([bars(300, 1000)]);
    assert.equal(await waitForChartReady('XAUUSD', null, 5000, { evaluate }), true);
  });

  it('does NOT report ready while bars are still streaming in', async () => {
    // Bar count climbs on every poll and never settles — the old DOM bar-count
    // proxy was constant, so this case wrongly returned true after ~600ms.
    let n = 100;
    const evaluate = async () => bars((n += 50), 1000 + n);
    assert.equal(await waitForChartReady('XAUUSD', null, 1500, { evaluate }), false);
  });

  it('waits for streaming to stop, then reports ready', async () => {
    const evaluate = mockEvaluate([
      bars(100, 900), bars(150, 950), bars(200, 1000),
      bars(200, 1000), bars(200, 1000), bars(200, 1000),
    ]);
    assert.equal(await waitForChartReady('XAUUSD', null, 5000, { evaluate }), true);
  });

  it('honours expectedTf — previously accepted and ignored', async () => {
    // Chart is on 240 but 60 was requested: must not report ready.
    const evaluate = mockEvaluate([bars(300, 1000)]);
    assert.equal(await waitForChartReady(null, '60', 1200, { evaluate }), false);
  });

  it('treats 1D and D as the same timeframe', async () => {
    const evaluate = mockEvaluate([{ ...bars(300, 1000), resolution: '1D' }]);
    assert.equal(await waitForChartReady(null, 'D', 5000, { evaluate }), true);
  });

  it('does not report ready on the wrong symbol', async () => {
    const evaluate = mockEvaluate([{ ...bars(300, 1000), symbol: 'FXPRO:XAGUSD' }]);
    assert.equal(await waitForChartReady('XAUUSD', null, 1200, { evaluate }), false);
  });

  it('keeps polling while the chart API is unreachable', async () => {
    const evaluate = mockEvaluate([
      { ok: false }, { ok: false }, null,
      bars(200, 1000), bars(200, 1000), bars(200, 1000), bars(200, 1000),
    ]);
    assert.equal(await waitForChartReady('XAUUSD', null, 5000, { evaluate }), true);
  });

  it('does not report ready with zero bars loaded', async () => {
    const evaluate = mockEvaluate([{ ok: true, symbol: 'FXPRO:XAUUSD', resolution: '240', barCount: 0 }]);
    assert.equal(await waitForChartReady('XAUUSD', null, 1200, { evaluate }), false);
  });

  it('respects an explicit series loading flag', async () => {
    const evaluate = mockEvaluate([bars(300, 1000, { seriesLoading: true })]);
    assert.equal(await waitForChartReady('XAUUSD', null, 1200, { evaluate }), false);
  });

  it('ignores live price ticks — only bar count and bar time gate settling', async () => {
    // Same bars, different price on each poll: must still settle.
    let px = 2400;
    const evaluate = async () => bars(300, 1000, { price: px++ });
    assert.equal(await waitForChartReady('XAUUSD', null, 5000, { evaluate }), true);
  });
});
