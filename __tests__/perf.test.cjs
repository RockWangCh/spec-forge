/**
 * Unit tests for the performance comparison library (perf.cjs) and the
 * before/after perf-regression WARN flow through the pipeline.
 *
 * Covers:
 *   - extractMetrics (Total preference, fallback, invalid input)
 *   - comparePerf (throughput / p99 / errorPct thresholds, relative vs absolute)
 *   - loadThresholds (defaults + overrides)
 *   - readStatisticsFile (valid + invalid)
 *   - Regression sub-stage WARN → regression node WARN → evidence-verify
 *
 * Run: node --test __tests__/perf.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const perfLib = require(path.join(__dirname, '..', 'scripts', 'perf.cjs'));
const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));
const scheduler = require(path.join(__dirname, '..', 'scripts', 'scheduler.cjs'));

const { STAGE_STATUS, GLOBAL_STAGES } = stateLib;

// ---- extractMetrics ----

test('extractMetrics prefers the Total aggregate', () => {
  const stats = {
    'GET /v2/map': { transaction: 'GET /v2/map', throughput: 10, pct3ResTime: 1, errorPct: 0 },
    Total: { transaction: 'Total', throughput: 100, pct3ResTime: 2, errorPct: 0 }
  };
  const m = perfLib.extractMetrics(stats);
  assert.strictEqual(m.throughput, 100);
  assert.strictEqual(m.pct3ResTime, 2);
  assert.strictEqual(m.transaction, 'Total');
});

test('extractMetrics falls back to first transaction when Total is absent', () => {
  const stats = {
    'GET /v2/map': { transaction: 'GET /v2/map', throughput: 42, pct3ResTime: 3, errorPct: 0 }
  };
  const m = perfLib.extractMetrics(stats);
  assert.strictEqual(m.throughput, 42);
  assert.strictEqual(m.transaction, 'GET /v2/map');
});

test('extractMetrics returns null for invalid/empty input', () => {
  assert.strictEqual(perfLib.extractMetrics(null), null);
  assert.strictEqual(perfLib.extractMetrics({}), null);
  assert.strictEqual(perfLib.extractMetrics({ a: 1 }), null);
});

// ---- loadThresholds ----

test('loadThresholds returns defaults when no overrides', () => {
  const t = perfLib.loadThresholds();
  assert.strictEqual(t.throughputPct, -10);
  assert.strictEqual(t.pct3ResTimePct, 20);
  assert.strictEqual(t.errorPctPoints, 0);
});

test('loadThresholds applies overrides and ignores non-numbers', () => {
  const t = perfLib.loadThresholds({ throughputPct: -5, pct3ResTimePct: 'x', errorPctPoints: 1 });
  assert.strictEqual(t.throughputPct, -5);
  assert.strictEqual(t.pct3ResTimePct, 20); // unchanged (non-number ignored)
  assert.strictEqual(t.errorPctPoints, 1);
});

// ---- comparePerf ----

function metrics(overrides) {
  return Object.assign({
    transaction: 'Total',
    throughput: 1000,
    pct3ResTime: 5,
    errorPct: 0
  }, overrides || {});
}

test('throughput drop beyond threshold breaches (WARN)', () => {
  const r = perfLib.comparePerf(metrics({ throughput: 1000 }), metrics({ throughput: 850 }));
  assert.strictEqual(r.verdict, 'WARN');
  const tp = r.metrics.find((m) => m.name === 'throughput');
  assert.strictEqual(tp.breached, true);
  assert.strictEqual(tp.deltaPct, -15);
});

test('throughput drop within threshold does not breach (PASS)', () => {
  const r = perfLib.comparePerf(metrics({ throughput: 1000 }), metrics({ throughput: 950 }));
  assert.strictEqual(r.verdict, 'PASS');
  const tp = r.metrics.find((m) => m.name === 'throughput');
  assert.strictEqual(tp.breached, false);
  assert.strictEqual(tp.deltaPct, -5);
});

test('p99 latency rise beyond threshold breaches (WARN)', () => {
  const r = perfLib.comparePerf(metrics({ pct3ResTime: 5 }), metrics({ pct3ResTime: 7 }));
  assert.strictEqual(r.verdict, 'WARN');
  const p99 = r.metrics.find((m) => m.name === 'pct3ResTime');
  assert.strictEqual(p99.breached, true);
  assert.strictEqual(p99.deltaPct, 40);
});

test('errorPct absolute increase breaches (WARN)', () => {
  const r = perfLib.comparePerf(metrics({ errorPct: 0 }), metrics({ errorPct: 0.5 }));
  assert.strictEqual(r.verdict, 'WARN');
  const ep = r.metrics.find((m) => m.name === 'errorPct');
  assert.strictEqual(ep.breached, true);
  assert.strictEqual(ep.deltaPoints, 0.5);
});

test('errorPct unchanged does not breach (PASS)', () => {
  const r = perfLib.comparePerf(metrics({ errorPct: 0.5 }), metrics({ errorPct: 0.5 }));
  assert.strictEqual(r.verdict, 'PASS');
  const ep = r.metrics.find((m) => m.name === 'errorPct');
  assert.strictEqual(ep.breached, false);
  assert.strictEqual(ep.deltaPoints, 0);
});

test('all metrics within thresholds → PASS', () => {
  const r = perfLib.comparePerf(
    metrics({ throughput: 1000, pct3ResTime: 5, errorPct: 0 }),
    metrics({ throughput: 990, pct3ResTime: 5.5, errorPct: 0 })
  );
  assert.strictEqual(r.verdict, 'PASS');
  assert.ok(r.metrics.every((m) => !m.breached));
});

test('zero baseline throughput is not applicable (no breach)', () => {
  const r = perfLib.comparePerf(metrics({ throughput: 0 }), metrics({ throughput: 100 }));
  const tp = r.metrics.find((m) => m.name === 'throughput');
  assert.strictEqual(tp.notApplicable, true);
  assert.strictEqual(tp.breached, false);
  assert.strictEqual(r.verdict, 'PASS');
});

test('missing baseline metrics are not applicable (no breach)', () => {
  const r = perfLib.comparePerf(null, metrics());
  assert.ok(r.metrics.every((m) => m.notApplicable));
  assert.strictEqual(r.verdict, 'PASS');
});

// ---- readStatisticsFile ----

test('readStatisticsFile parses a statistics.json snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
  const file = path.join(dir, 'statistics.json');
  fs.writeFileSync(file, JSON.stringify({
    Total: { transaction: 'Total', throughput: 1234, pct3ResTime: 4, errorPct: 0 }
  }), 'utf8');
  const m = perfLib.readStatisticsFile(file);
  assert.strictEqual(m.throughput, 1234);
});

test('readStatisticsFile returns null for missing/invalid file', () => {
  assert.strictEqual(perfLib.readStatisticsFile('/nonexistent/statistics.json'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, 'not json {', 'utf8');
  assert.strictEqual(perfLib.readStatisticsFile(file), null);
});

// ---- Regression sub-stage WARN → node WARN → evidence-verify ----

function makeConfig() {
  return { retry_policy: { global_max_retries: 2 } };
}

function markGlobalPassed(state, stageName) {
  const stage = state.stages[stageName];
  stage.status = STAGE_STATUS.PASSED;
  stage.markers = stage.markers || {};
  stage.markers.marker_outcome = 'PASSED';
  stage.completed_at = new Date().toISOString();
}

function makeImplementationDoneState() {
  const state = stateLib.defaultState();
  state.ts = '20990101-000000';
  markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
  markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
  markGlobalPassed(state, GLOBAL_STAGES.BASELINE_REGRESSION);
  const job = stateLib.defaultJob({ id: 'J1' });
  state.stages[GLOBAL_STAGES.IMPLEMENTATION].jobs.push(job);
  job.coding.status = STAGE_STATUS.PASSED;
  job.coding.markers = job.coding.markers || {};
  job.coding.markers.marker_outcome = 'PASSED';
  return state;
}

test('regression sub-stage WARN → node WARN → evidence-verify (soft pass)', () => {
  const state = makeImplementationDoneState();
  const ver = state.stages[GLOBAL_STAGES.VERIFICATION];
  const cur = stateLib.getCurrentRound(ver);
  cur.testing.status = STAGE_STATUS.PASSED;
  cur.review.status = STAGE_STATUS.PASSED;
  cur.regression.status = STAGE_STATUS.WARN;
  cur.regression.markers = cur.regression.markers || {};
  cur.regression.markers.marker_outcome = 'WARN';

  const result = scheduler.decideNext(state, makeConfig());

  assert.strictEqual(ver.status, STAGE_STATUS.WARN);
  assert.strictEqual(result.action, 'dispatch');
  assert.strictEqual(result.scope, 'global');
  assert.strictEqual(result.stage, GLOBAL_STAGES.EVIDENCE_VERIFY);
});
