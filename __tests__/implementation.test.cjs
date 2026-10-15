/**
 * Unit tests for the implementation node + flat jobs model (schema v7).
 *
 * Covers:
 *   - defaultState has an `implementation` composite stage with empty jobs
 *   - initJobsFromManifest stores flat jobs + rejects cyclic depends_on
 *   - detectJobCycle reports cycles
 *   - recomputeImplementationStatus aggregates job coding statuses
 *   - zero-compat: a v5-style top-level `waves` field is ignored (no migration)
 *
 * Run: node --test __tests__/implementation.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));

const { STAGE_STATUS } = stateLib;

function makeState() {
  const state = stateLib.defaultState();
  state.ts = '20990101-000000';
  return state;
}

function addJob(state, jobId, dependsOn) {
  const job = stateLib.defaultJob({ id: jobId, depends_on: dependsOn || [] });
  state.stages.implementation.jobs.push(job);
  return job;
}

test('defaultState: has implementation stage with empty jobs', () => {
  const state = stateLib.defaultState();
  assert.ok(state.stages.implementation, 'implementation stage exists');
  assert.strictEqual(state.stages.implementation.status, STAGE_STATUS.PENDING);
  assert.ok(Array.isArray(state.stages.implementation.jobs), 'implementation.jobs is an array');
  assert.strictEqual(state.stages.implementation.jobs.length, 0);
  assert.strictEqual(state.waves, undefined, 'no top-level waves field (zero-compat break)');
});

test('initJobsFromManifest: stores flat jobs under implementation', () => {
  const state = makeState();
  const result = stateLib.initJobsFromManifest(state, {
    jobs: [
      { id: 'J1' },
      { id: 'J2', depends_on: ['J1'] }
    ]
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.count, 2);
  assert.strictEqual(state.stages.implementation.jobs.length, 2);
  assert.strictEqual(Object.keys(stateLib.getJobs(state)).length, 2);
});

test('initJobsFromManifest: rejects cyclic depends_on', () => {
  const state = makeState();
  const result = stateLib.initJobsFromManifest(state, {
    jobs: [
      { id: 'J1', depends_on: ['J2'] },
      { id: 'J2', depends_on: ['J1'] }
    ]
  });
  assert.strictEqual(result.ok, false);
  assert.ok(Array.isArray(result.cycle), 'cycle reported');
  assert.strictEqual(state.stages.implementation.jobs.length, 0, 'no jobs committed on cycle');
});

test('detectJobCycle: null for acyclic, array for cycle/self-loop', () => {
  assert.strictEqual(stateLib.detectJobCycle({ J1: { depends_on: [] }, J2: { depends_on: ['J1'] } }), null);
  assert.ok(Array.isArray(stateLib.detectJobCycle({ J1: { depends_on: ['J2'] }, J2: { depends_on: ['J1'] } })));
  assert.strictEqual(stateLib.detectJobCycle({ J1: { depends_on: ['J1'] } }).length, 2); // self-loop
});

test('recomputeImplementationStatus: aggregates job coding statuses', () => {
  const state = makeState();
  addJob(state, 'J1');
  addJob(state, 'J2');

  assert.strictEqual(stateLib.recomputeImplementationStatus(state), STAGE_STATUS.PENDING);

  stateLib.getJobs(state)['J1'].coding.status = STAGE_STATUS.PASSED;
  assert.strictEqual(stateLib.recomputeImplementationStatus(state), STAGE_STATUS.PENDING);

  stateLib.getJobs(state)['J2'].coding.status = STAGE_STATUS.PASSED;
  assert.strictEqual(stateLib.recomputeImplementationStatus(state), STAGE_STATUS.PASSED);
  assert.ok(state.stages.implementation.completed_at, 'implementation completed_at stamped');
});

test('recomputeImplementationStatus: stamps started_at on first IN_PROGRESS', () => {
  const state = makeState();
  addJob(state, 'J1');
  stateLib.getJobs(state)['J1'].coding.status = STAGE_STATUS.IN_PROGRESS;
  assert.strictEqual(stateLib.recomputeImplementationStatus(state), STAGE_STATUS.IN_PROGRESS);
  assert.ok(state.stages.implementation.started_at, 'implementation started_at stamped on IN_PROGRESS');

  const first = state.stages.implementation.started_at;
  stateLib.recomputeImplementationStatus(state);
  assert.strictEqual(state.stages.implementation.started_at, first, 'started_at stable across recomputes');
});

test('zero-compat: load() of a v5 file yields empty jobs (no migration)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-compat-'));
  const ts = '20990101-000000';
  const tsDir = path.join(root, 'specs', ts);
  fs.mkdirSync(tsDir, { recursive: true });

  const v5State = {
    schema_version: 5,
    ts: ts,
    stages: {},
    waves: [{ index: 0, label: 'legacy', jobs: [] }]
  };
  fs.writeFileSync(path.join(tsDir, 'state.json'), JSON.stringify(v5State), 'utf8');

  const loaded = stateLib.load(ts, root);
  // No migration: getJobs reads implementation.jobs (missing → []).
  assert.strictEqual(Object.keys(stateLib.getJobs(loaded)).length, 0);
});
