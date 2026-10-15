#!/usr/bin/env node
/**
 * Unit tests for the StageEntry 状态机 (stage-entry.cjs).
 *
 * Covers the deep-module interface directly (interface = test surface):
 *   - transition: timestamp + attempt lifecycle + PASSED no-downgrade + PENDING reset
 *   - computeStatus / recompute: stale window + marker precedence + allPassed
 *   - isStaleRun: missing started_at / window boundary
 *   - Q4/Q5 semantics: recompute is derived (does NOT fake attempt lifecycle);
 *     transition uniformly clears markers+artifacts on retry
 *
 * Run: node --test __tests__/stage-entry.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stageEntry = require(path.join(__dirname, '..', 'scripts', 'stage-entry.cjs'));
const { STAGE_STATUS } = require(path.join(__dirname, '..', 'scripts', 'config.cjs'));

function isoAgo(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeEntry(overrides) {
  return Object.assign({
    status: STAGE_STATUS.PENDING,
    started_at: null,
    completed_at: null,
    attempt_count: 0,
    markers: {},
    artifacts: [],
    runs: []
  }, overrides || {});
}

function run(outcome, startedAt) {
  return {
    agent_type: 'test',
    agent_id: 'a',
    outcome: outcome,
    started_at: startedAt,
    stopped_at: outcome === 'IN_PROGRESS' ? null : startedAt,
    exit_status: outcome === 'IN_PROGRESS' ? null : 'completed'
  };
}

// =====================================================================
// transition — 命令式转移
// =====================================================================

test('transition: first IN_PROGRESS stamps started_at, attempt_count=1, keeps artifacts', () => {
  const entry = makeEntry({ artifacts: ['x.md'], markers: { k: 'v' } });
  stageEntry.transition(entry, STAGE_STATUS.IN_PROGRESS);
  assert.ok(entry.started_at, 'started_at set on first entry');
  assert.strictEqual(entry.attempt_count, 1, 'attempt_count bumped to 1');
  // first attempt (attempt_count was 0) does NOT clear markers/artifacts
  assert.deepStrictEqual(entry.artifacts, ['x.md'], 'artifacts kept on first attempt');
  assert.deepStrictEqual(entry.markers, { k: 'v' }, 'markers kept on first attempt');
});

test('transition: retry IN_PROGRESS clears markers AND artifacts, bumps attempt_count (Q5)', () => {
  const entry = makeEntry({ attempt_count: 1, status: STAGE_STATUS.FAILED, markers: { marker_outcome: 'FAILED' }, artifacts: ['old.md'] });
  stageEntry.transition(entry, STAGE_STATUS.IN_PROGRESS);
  assert.strictEqual(entry.attempt_count, 2, 'attempt_count bumped on retry');
  assert.deepStrictEqual(entry.markers, {}, 'markers cleared on retry');
  assert.deepStrictEqual(entry.artifacts, [], 'artifacts cleared on retry (Q5: 统一清 artifacts)');
});

test('transition: terminal statuses (incl. SKIPPED) stamp completed_at', () => {
  for (const status of [STAGE_STATUS.PASSED, STAGE_STATUS.FAILED, STAGE_STATUS.BLOCKED, STAGE_STATUS.SKIPPED]) {
    const entry = makeEntry();
    stageEntry.transition(entry, status);
    assert.strictEqual(entry.status, status);
    assert.ok(entry.completed_at, status + ' stamps completed_at');
  }
});

test('transition: PASSED is terminal (no downgrade)', () => {
  const entry = makeEntry({ status: STAGE_STATUS.PASSED, completed_at: 'keep' });
  stageEntry.transition(entry, STAGE_STATUS.IN_PROGRESS);
  assert.strictEqual(entry.status, STAGE_STATUS.PASSED, 'PASSED not downgraded');
  assert.strictEqual(entry.completed_at, 'keep', 'completed_at untouched');
});

test('transition: PENDING resets started_at/completed_at', () => {
  const entry = makeEntry({ status: STAGE_STATUS.FAILED, started_at: 's', completed_at: 'c' });
  stageEntry.transition(entry, STAGE_STATUS.PENDING);
  assert.strictEqual(entry.status, STAGE_STATUS.PENDING);
  assert.strictEqual(entry.started_at, null, 'started_at reset');
  assert.strictEqual(entry.completed_at, null, 'completed_at reset');
});

// =====================================================================
// recompute / computeStatus — 派生式重算
// =====================================================================

test('recompute: marker PASSED overrides a FAILED run', () => {
  const entry = makeEntry({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: isoAgo(5 * 60000),
    attempt_count: 1,
    markers: { marker_outcome: 'PASSED' },
    runs: [run('FAILED', isoAgo(5 * 60000))]
  });
  assert.strictEqual(stageEntry.recompute(entry), STAGE_STATUS.PASSED);
  assert.strictEqual(entry.status, STAGE_STATUS.PASSED);
});

test('recompute: stale IN_PROGRESS run is marked FAILED', () => {
  const entry = makeEntry({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: isoAgo(35 * 60000), // attempt 已开始 35 分钟
    attempt_count: 1,
    runs: [run('IN_PROGRESS', isoAgo(35 * 60000))] // 超 30 分钟 stale 窗口
  });
  assert.strictEqual(stageEntry.recompute(entry), STAGE_STATUS.FAILED);
  assert.strictEqual(entry.runs[0].outcome, 'FAILED', 'stale run re-marked FAILED');
  assert.strictEqual(entry.runs[0].exit_status, 'stale');
});

test('recompute: all PASSED runs -> PASSED', () => {
  const entry = makeEntry({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: isoAgo(5 * 60000),
    attempt_count: 1,
    runs: [run('PASSED', isoAgo(5 * 60000))]
  });
  assert.strictEqual(stageEntry.recompute(entry), STAGE_STATUS.PASSED);
});

test('recompute: in-window IN_PROGRESS run -> IN_PROGRESS (not premature PASSED)', () => {
  const entry = makeEntry({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: isoAgo(5 * 60000),
    attempt_count: 1,
    runs: [run('IN_PROGRESS', isoAgo(5 * 60000))]
  });
  assert.strictEqual(stageEntry.recompute(entry), STAGE_STATUS.IN_PROGRESS);
});

test('recompute: derived write-back does NOT fake attempt lifecycle (Q4)', () => {
  // A stage still PENDING but with an in-flight run must be derived to
  // IN_PROGRESS WITHOUT stamping started_at or bumping attempt_count — those
  // are dispatch-side concerns, not recompute-side.
  const entry = makeEntry({ runs: [run('IN_PROGRESS', isoAgo(5 * 60000))] });
  assert.strictEqual(entry.started_at, null);
  assert.strictEqual(entry.attempt_count, 0);
  assert.strictEqual(stageEntry.recompute(entry), STAGE_STATUS.IN_PROGRESS);
  assert.strictEqual(entry.started_at, null, 'recompute must not stamp started_at');
  assert.strictEqual(entry.attempt_count, 0, 'recompute must not bump attempt_count');
});

// =====================================================================
// isStaleRun
// =====================================================================

test('isStaleRun: missing started_at is stale', () => {
  assert.strictEqual(stageEntry.isStaleRun({ started_at: null }, 30 * 60000, Date.now()), true);
});

test('isStaleRun: over window is stale', () => {
  const now = Date.now();
  assert.strictEqual(stageEntry.isStaleRun({ started_at: isoAgo(60 * 60000) }, 30 * 60000, now), true);
});

test('isStaleRun: within window is fresh', () => {
  const now = Date.now();
  assert.strictEqual(stageEntry.isStaleRun({ started_at: isoAgo(5 * 60000) }, 30 * 60000, now), false);
});
