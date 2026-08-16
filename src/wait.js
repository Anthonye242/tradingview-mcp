import { evaluate as _evaluate, KNOWN_PATHS } from './connection.js';

const DEFAULT_TIMEOUT = 20000;
const POLL_INTERVAL = 250;
// Bars stream in over several frames after a symbol switch. Require the bar
// count + last bar time to hold across this many consecutive polls before
// calling the chart ready.
const STABLE_POLLS = 3;

const CHART_API = KNOWN_PATHS.chartApi;

/**
 * Normalize a symbol for comparison: uppercase, exchange prefix stripped.
 * `chart.symbol()` echoes back whatever TradingView resolved the request to,
 * which routinely carries an exchange prefix the caller never supplied
 * ("XAUUSD" -> "FXPRO:XAUUSD") — and equally often the caller supplies one the
 * legend doesn't show. Comparing the bare tickers makes both directions agree.
 */
export function normalizeSymbol(sym) {
  if (sym == null) return '';
  const s = String(sym).trim().toUpperCase();
  const colon = s.lastIndexOf(':');
  return colon === -1 ? s : s.slice(colon + 1);
}

/**
 * Normalize a resolution for comparison. TradingView accepts "1D" and "D",
 * "1W" and "W" interchangeably and returns whichever form it feels like, so
 * fold the redundant "1" prefix and strip leading zeros off minute counts.
 */
export function normalizeResolution(res) {
  if (res == null) return '';
  const r = String(res).trim().toUpperCase();
  const unit = /^1([DWM])$/.exec(r);
  if (unit) return unit[1];
  const minutes = /^0*(\d+)$/.exec(r);
  if (minutes) return String(Number(minutes[1]));
  return r;
}

export function symbolMatches(actual, expected) {
  const a = normalizeSymbol(actual);
  const e = normalizeSymbol(expected);
  if (!a || !e) return false;
  // Exact after normalization is the common case; the includes() fallback
  // tolerates suffixed contract names (e.g. expected "CL1!" vs actual "CL1!").
  return a === e || a.includes(e) || e.includes(a);
}

/**
 * Wait until the chart has actually finished switching symbol/timeframe.
 *
 * Readiness is read from the chart API rather than the DOM. The previous
 * implementation counted `[class*="bar"]` elements as a proxy for chart bars —
 * but bars are painted on a canvas, so that selector only ever matched
 * toolbars/scrollbars/sidebars: a constant, nonzero count that was "stable" on
 * the first three polls and made this function return true ~600ms after a
 * symbol change, while history was still streaming. It also compared the
 * expected symbol against the DOM legend with `legend.includes(expected)`,
 * which can never match an exchange-qualified request ("FXPRO:XAUUSD" against a
 * legend reading "XAUUSD") and so span the whole timeout and report failure.
 *
 * Returns true once the chart reports the expected symbol/resolution and its
 * bar data has stopped changing; false on timeout.
 */
export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT, { evaluate = _evaluate } = {}) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var out = { ok: false, barCount: 0 };
        try {
          var chart = ${CHART_API};
          out.symbol = chart.symbol();
          out.resolution = String(chart.resolution());
          try {
            var series = chart._chartWidget.model().mainSeries();
            var bars = series.bars();
            var first = bars.firstIndex(), last = bars.lastIndex();
            if (typeof first === 'number' && typeof last === 'number' && last >= first) {
              out.barCount = last - first + 1;
              var v = bars.valueAt(last);
              out.lastBarTime = v && v[0];
            }
            // Not every build exposes this; only trust an actual boolean.
            try { var l = series.isLoading && series.isLoading(); if (typeof l === 'boolean') out.seriesLoading = l; } catch (e) {}
          } catch (e) {}
          out.ok = true;
        } catch (e) {}
        return out;
      })()
    `);

    // Chart API not reachable yet (mid-navigation) — keep polling.
    if (!state || !state.ok || state.seriesLoading === true || !state.barCount) {
      stableCount = 0;
      lastSignature = null;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (expectedSymbol && !symbolMatches(state.symbol, expectedSymbol)) {
      stableCount = 0;
      lastSignature = null;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (expectedTf && normalizeResolution(state.resolution) !== normalizeResolution(expectedTf)) {
      stableCount = 0;
      lastSignature = null;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Price is deliberately excluded from the signature: on a live symbol
    // ticks land continuously, and waiting for those to stop would never
    // settle. Bar count and last bar time only move when data is still
    // loading (or a new bar opens, which is rare enough not to matter).
    const signature = [normalizeSymbol(state.symbol), normalizeResolution(state.resolution), state.barCount, state.lastBarTime].join('|');
    if (signature === lastSignature) stableCount++;
    else { stableCount = 0; lastSignature = signature; }

    if (stableCount >= STABLE_POLLS) return true;

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}

/**
 * Wait for the chart to finish (re)rendering — used before screenshots so a
 * capture right after chart_set_symbol / chart_set_timeframe doesn't grab a
 * stale frame (issue #144). Waits for any loading spinner to clear, then for
 * the symbol/resolution/canvas signature to hold stable across 3 polls.
 */
export async function waitForChartRender(timeout = 5000, { evaluate = _evaluate } = {}) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var canvas = document.querySelector('[data-name="pane-canvas"] canvas')
          || document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('canvas');
        var rect = canvas ? canvas.getBoundingClientRect() : null;
        var symbol = '', resolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          symbol = chart.symbol();
          resolution = chart.resolution();
        } catch(e) {}
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        return {
          symbol: symbol,
          resolution: resolution,
          isLoading: !!(spinner && spinner.offsetParent !== null),
          canvasWidth: rect ? Math.round(rect.width) : 0,
          canvasHeight: rect ? Math.round(rect.height) : 0
        };
      })()
    `);

    if (!state || state.isLoading || !state.canvasWidth || !state.canvasHeight) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const signature = [state.symbol, state.resolution, state.canvasWidth, state.canvasHeight].join('|');
    if (signature === lastSignature) stableCount++;
    else { stableCount = 0; lastSignature = signature; }

    if (stableCount >= 3) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return false;
}
