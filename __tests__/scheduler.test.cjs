#!/usr/bin/env node
/**
 * Unit tests for the job-dag scheduler (scheduler.cjs).
 *
 * Covers decideNext() and key exported helpers across:
 *   - Pre-job global stages (spec-check, task-decompose, baseline-regression)
 *   - Flat job-DAG coding dispatch (depends_on ordering, parallel batch, cap)
 *   - Dependency ordering + fail-fast on a failed dependency
 *   - Cycle detection fail-fast
 *   - Stale run detection
 *   - Streaming dispatch (no re-dispatch while a Task is in flight)
 *   - Agent maps + dispatch description format
 *   - Terminal states (done, fail)
 *
 * The verification loop (testing → review → regression → fix) is covered in
 * verification.test.cjs.
 *
 * Run: node --test __tests__/scheduler.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));
const scheduler = require(path.join(__dirname, '..', 'scripts', 'scheduler.cjs'));
const configLib = require(path.join(__dirname, '..', 'scripts', 'config.cjs'));

const {
  STAGE_STATUS,
  JOB_STATUS,
  GLOBAL_STAGES,
  VERIFICATION_STAGES
} = stateLib;

// ---- Fixture helpers ----

function isoAgo(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeConfig(overrides) {
  return Object.assign({
    retry_policy: { global_max_retries: 2 }
  }, overrides || {});
}

function makeState() {
  const state = stateLib.defaultState();
  state.ts = '20260724-100000-test';
  return state;
}

function markGlobalPassed(state, stageName) {
  const stage = state.stages[stageName];
  stage.status = STAGE_STATUS.PASSED;
  stage.markers = stage.markers || {};
  stage.markers.marker_outcome = 'PASSED';
  stage.completed_at = new Date().toISOString();
}

function markCodingPassed(state, jobId) {
  const job = stateLib.getJobs(state)[jobId];
  if (!job) throw new Error('unknown job: ' + jobId);
  job.coding.status = STAGE_STATUS.PASSED;
  job.coding.markers = job.coding.markers || {};
  job.coding.markers.marker_outcome = 'PASSED';
  job.coding.completed_at = new Date().toISOString();
  stateLib.recomputeJobStatus(state, jobId);
}

function markJobFailed(state, jobId) {
  const job = stateLib.getJobs(state)[jobId];
  job.coding.status = STAGE_STATUS.FAILED;
  job.max_retries = 0;
  job.attempt_count = 1;
  stateLib.recomputeJobStatus(state, jobId);
}

// Add a flat job to implementation.jobs[].
function addJob(state, jobId, opts) {
  opts = opts || {};
  const job = stateLib.defaultJob({
    id: jobId,
    layer: opts.layer || null,
    description: opts.description || ('Job ' + jobId),
    files: opts.files || [],
    produces: opts.produces || [],
    depends_on: opts.depends_on || [],
    agent_type: 'implementer'
  });
  state.stages.implementation.jobs.push(job);
  return job;
}

// Mark spec/task/baseline PASSED so decideNext reaches the implementation node.
function markPreStagesPassed(state) {
  markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
  markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
  markGlobalPassed(state, GLOBAL_STAGES.BASELINE_REGRESSION);
}

function markVerificationPassed(state) {
  const ver = stateLib.getVerificationStage(state);
  const cur = stateLib.getCurrentRound(ver);
  cur.testing.status = STAGE_STATUS.PASSED;
  cur.review.status = STAGE_STATUS.PASSED;
  cur.regression.status = STAGE_STATUS.PASSED;
  stateLib.recomputeVerificationStatus(state);
}

// =====================================================================
// Group 1: Pre-job global stages
// =====================================================================

describe('Group 1: Pre-job global stages', () => {
  test('fresh state -> dispatch spec-check (spec-checker)', () => {
    const state = makeState();
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'global');
    assert.strictEqual(result.stage, GLOBAL_STAGES.SPEC_CHECK);
    assert.strictEqual(result.agent, 'spec-checker');
  });

  test('global stage retry is 1-based and bounded to max_retries (3 total attempts)', () => {
    const state = makeState();
    const stage = state.stages[GLOBAL_STAGES.SPEC_CHECK];
    // First dispatch marks attempt_count = 1 (1-based).
    let r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.action, 'dispatch');
    assert.strictEqual(stage.attempt_count, 1);

    stage.status = STAGE_STATUS.FAILED;
    r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.action, 'retry');
    assert.strictEqual(stage.attempt_count, 2);

    stage.status = STAGE_STATUS.FAILED;
    r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.action, 'retry');
    assert.strictEqual(stage.attempt_count, 3);

    // Exhausted (attempt_count > max_retries) -> terminal fail, not a 4th retry.
    stage.status = STAGE_STATUS.FAILED;
    r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.action, 'fail');
  });

  test('global stage retry clears stale markers/artifacts (via transition)', () => {
    const state = makeState();
    const stage = state.stages[GLOBAL_STAGES.SPEC_CHECK];
    scheduler.decideNext(state, makeConfig()); // first dispatch -> attempt_count 1
    stage.status = STAGE_STATUS.FAILED;
    stage.markers = { marker_outcome: 'FAILED', stale: true };
    stage.artifacts = [{ path: '/stale-artifact' }];
    const r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.action, 'retry');
    assert.deepStrictEqual(stage.markers, {});
    assert.deepStrictEqual(stage.artifacts, []);
  });

  test('spec-check PASSED -> dispatch task-decompose (task-decomposer)', () => {
    const state = makeState();
    markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.stage, GLOBAL_STAGES.TASK_DECOMPOSE);
    assert.strictEqual(result.agent, 'task-decomposer');
  });

  test('task-decompose PASSED -> dispatch baseline-regression (regression-runner)', () => {
    const state = makeState();
    markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
    markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.stage, GLOBAL_STAGES.BASELINE_REGRESSION);
    assert.strictEqual(result.agent, 'regression-runner');
  });

  test('baseline-regression PASSED with 0 jobs -> fail (empty manifest)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.ok(/0 jobs/.test(result.reason), 'reason mentions empty manifest');
  });
});

// =====================================================================
// Group 2: Flat job-DAG coding dispatch
// =====================================================================

describe('Group 2: Flat job-DAG coding dispatch', () => {
  test('one PENDING job -> dispatch coding (implementer)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'job');
    assert.strictEqual(result.job_id, 'J1');
    assert.strictEqual(result.stage, 'coding');
    assert.strictEqual(result.agent, 'implementer');
  });

  test('job dispatch description has no WAVE= token', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.description, 'TS=20260724-100000-test JOB=J1 STAGE=coding');
    assert.ok(!/WAVE=/.test(result.description), 'description must not contain WAVE=');
  });

  test('job dispatch carries job_details (files/produces/depends_on)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1', { files: ['a.ts'], produces: ['p.json'], depends_on: [] });
    const result = scheduler.decideNext(state, makeConfig());
    assert.deepStrictEqual(result.job_details.files, ['a.ts']);
    assert.deepStrictEqual(result.job_details.produces, ['p.json']);
  });
});

// =====================================================================
// Group 3: Parallel batch dispatch
// =====================================================================

describe('Group 3: Parallel batch dispatch', () => {
  test('two independent jobs -> dispatch_batch (scope job, count 2)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    addJob(state, 'J2');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch_batch');
    assert.strictEqual(result.scope, 'job');
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(result.dispatches.map((d) => d.job_id), ['J1', 'J2']);
  });

  test('cap: default (5) bounds in-flight — 6 ready jobs dispatch only 5', () => {
    const state = makeState();
    markPreStagesPassed(state);
    for (let i = 0; i < 6; i++) addJob(state, 'J' + i);
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch_batch');
    assert.strictEqual(result.count, 5);
    assert.strictEqual(result.dispatches.length, 5);
    // The 6th job is held back (still PENDING) until a slot frees up.
    assert.strictEqual(stateLib.getJobs(state)['J5'].coding.status, STAGE_STATUS.PENDING);
  });

  test('cap: explicit override (2) dispatches at most 2', () => {
    const state = makeState();
    markPreStagesPassed(state);
    for (let i = 0; i < 4; i++) addJob(state, 'J' + i);
    const config = makeConfig({ parallelism: { max_concurrent_coding_jobs: 2 } });
    const result = scheduler.decideNext(state, config);
    assert.strictEqual(result.action, 'dispatch_batch');
    assert.strictEqual(result.count, 2);
    assert.strictEqual(stateLib.getJobs(state)['J2'].coding.status, STAGE_STATUS.PENDING);
  });

  test('cap: 0 = unlimited — all 6 jobs dispatched', () => {
    const state = makeState();
    markPreStagesPassed(state);
    for (let i = 0; i < 6; i++) addJob(state, 'J' + i);
    const config = makeConfig({ parallelism: { max_concurrent_coding_jobs: 0 } });
    const result = scheduler.decideNext(state, config);
    assert.strictEqual(result.action, 'dispatch_batch');
    assert.strictEqual(result.count, 6);
  });

  test('cap: full (5 in flight) -> wait, no new dispatch', () => {
    const state = makeState();
    markPreStagesPassed(state);
    for (let i = 0; i < 6; i++) addJob(state, 'J' + i);
    scheduler.decideNext(state, makeConfig()); // dispatch J0..J4 (cap 5)
    const result = scheduler.decideNext(state, makeConfig()); // 5 in flight, 1 ready
    assert.strictEqual(result.action, 'wait');
    assert.strictEqual(stateLib.getJobs(state)['J5'].coding.status, STAGE_STATUS.PENDING);
  });

  test('cap: slot-fill — one job completes, the held job is dispatched', () => {
    const state = makeState();
    markPreStagesPassed(state);
    for (let i = 0; i < 6; i++) addJob(state, 'J' + i);
    scheduler.decideNext(state, makeConfig()); // dispatch J0..J4
    markCodingPassed(state, 'J0');             // free one slot
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.job_id, 'J5');
  });

  test('cap: retry does not exceed the cap when full', () => {
    const state = makeState();
    markPreStagesPassed(state);
    for (let i = 0; i < 6; i++) addJob(state, 'J' + i);
    scheduler.decideNext(state, makeConfig()); // dispatch J0..J4 (cap 5); J5 held
    const j5 = stateLib.getJobs(state)['J5'];
    j5.coding.status = STAGE_STATUS.FAILED;    // simulate a failed prior attempt
    j5.attempt_count = 0;
    const result = scheduler.decideNext(state, makeConfig()); // cap full
    assert.strictEqual(result.action, 'wait');
    // J5 was reset for retry (attempt bumped) but held back, not dispatched.
    assert.strictEqual(stateLib.getJobs(state)['J5'].coding.status, STAGE_STATUS.PENDING);
    assert.strictEqual(stateLib.getJobs(state)['J5'].attempt_count, 1);
  });

  test('dispatched jobs are marked IN_PROGRESS (streaming safety)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    addJob(state, 'J2');
    scheduler.decideNext(state, makeConfig());
    assert.strictEqual(stateLib.getJobs(state)['J1'].coding.status, STAGE_STATUS.IN_PROGRESS);
    assert.strictEqual(stateLib.getJobs(state)['J2'].coding.status, STAGE_STATUS.IN_PROGRESS);
  });
});

// =====================================================================
// Group 3b: Concurrency cap (config parse helpers)
// =====================================================================

describe('Group 3b: Concurrency cap config', () => {
  test('parseMaxConcurrency: N >= 1 -> floor(N)', () => {
    assert.strictEqual(configLib.parseMaxConcurrency(5, 5), 5);
    assert.strictEqual(configLib.parseMaxConcurrency('5', 5), 5);
    assert.strictEqual(configLib.parseMaxConcurrency(4.7, 5), 4);
  });

  test('parseMaxConcurrency: 0 -> Infinity (unlimited)', () => {
    assert.strictEqual(configLib.parseMaxConcurrency(0, 5), Infinity);
    assert.strictEqual(configLib.parseMaxConcurrency('0', 5), Infinity);
  });

  test('parseMaxConcurrency: negative/NaN/empty -> fallback', () => {
    assert.strictEqual(configLib.parseMaxConcurrency(-1, 5), 5);
    assert.strictEqual(configLib.parseMaxConcurrency('abc', 5), 5);
    assert.strictEqual(configLib.parseMaxConcurrency('', 5), 5);
    assert.strictEqual(configLib.parseMaxConcurrency(undefined, 5), 5);
    assert.strictEqual(configLib.parseMaxConcurrency(null, 5), 5);
  });

  test('getMaxConcurrency: default when config lacks parallelism', () => {
    assert.strictEqual(configLib.getMaxConcurrency(makeConfig()), 5);
    assert.strictEqual(configLib.getMaxConcurrency({}), 5);
    assert.strictEqual(configLib.getMaxConcurrency(null), 5);
  });

  test('getMaxConcurrency: honors explicit parallelism value', () => {
    assert.strictEqual(configLib.getMaxConcurrency(makeConfig({ parallelism: { max_concurrent_coding_jobs: 2 } })), 2);
    assert.strictEqual(configLib.getMaxConcurrency(makeConfig({ parallelism: { max_concurrent_coding_jobs: 0 } })), Infinity);
  });
});

// =====================================================================
// Group 4: Dependency ordering
// =====================================================================

describe('Group 4: Dependency ordering', () => {
  test('downstream job waits for upstream coding', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    addJob(state, 'J2', { depends_on: ['J1'] });
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.job_id, 'J1', 'only the upstream job is dispatched');
  });

  test('after upstream PASSED, downstream becomes ready', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    addJob(state, 'J2', { depends_on: ['J1'] });
    scheduler.decideNext(state, makeConfig()); // dispatch J1
    markCodingPassed(state, 'J1');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.job_id, 'J2');
  });

  test('streaming: downstream dispatched while sibling still in flight (no batch wait)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');                          // fast job
    addJob(state, 'J2');                          // slow sibling (stays in flight)
    addJob(state, 'J3', { depends_on: ['J1'] });  // downstream of fast job
    scheduler.decideNext(state, makeConfig());    // dispatch J1 + J2
    markCodingPassed(state, 'J1');                // J1 completes mid-batch
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.job_id, 'J3', 'downstream dispatched while sibling still in flight');
    assert.strictEqual(
      stateLib.getJobs(state)['J2'].coding.status,
      STAGE_STATUS.IN_PROGRESS,
      'sibling remains in flight (streaming, not batch)'
    );
  });
});

// =====================================================================
// Group 5: Fail-fast on a failed dependency
// =====================================================================

describe('Group 5: Fail-fast on a failed dependency', () => {
  test('job depending on a terminally-failed job -> fail', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    addJob(state, 'J2', { depends_on: ['J1'] });
    markJobFailed(state, 'J1');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.strictEqual(result.job_id, 'J2');
    assert.ok(/depends on FAILED job J1/.test(result.reason));
  });
});

// =====================================================================
// Group 6: Cycle detection
// =====================================================================

describe('Group 6: Cycle detection', () => {
  test('cyclic depends_on -> fail with cycle path', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1', { depends_on: ['J2'] });
    addJob(state, 'J2', { depends_on: ['J1'] });
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.ok(/cycle/.test(result.reason), 'reason mentions cycle');
  });
});

// =====================================================================
// Group 7: Stale runs
// =====================================================================

describe('Group 7: Stale runs', () => {
  test('stale IN_PROGRESS job coding -> retry', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    const job = stateLib.getJobs(state)['J1'];
    job.coding.status = STAGE_STATUS.IN_PROGRESS;
    job.coding.started_at = isoAgo(40 * 60 * 1000); // 40min > 30min stale window
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'retry');
    assert.strictEqual(result.job_id, 'J1');
  });

  test('fresh IN_PROGRESS job coding -> wait (not stale)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    const job = stateLib.getJobs(state)['J1'];
    job.coding.status = STAGE_STATUS.IN_PROGRESS;
    job.coding.started_at = new Date().toISOString();
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'wait');
  });

  test('stale IN_PROGRESS job coding with retries exhausted -> fail (not wait)', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    const job = stateLib.getJobs(state)['J1'];
    job.coding.status = STAGE_STATUS.IN_PROGRESS;
    job.coding.started_at = isoAgo(40 * 60 * 1000);
    job.attempt_count = 2;
    job.max_retries = 2;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.strictEqual(result.job_id, 'J1');
  });
});

// =====================================================================
// Group 8: Streaming dispatch (no re-dispatch)
// =====================================================================

describe('Group 8: Streaming dispatch', () => {
  test('re-calling scheduler while a job is in flight returns wait', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    const first = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(first.action, 'dispatch');
    const second = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(second.action, 'wait', 'job already IN_PROGRESS → wait');
  });

  test('re-calling scheduler while verification sub-stage in flight returns wait', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    markCodingPassed(state, 'J1');
    const first = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(first.scope, 'verification');
    assert.strictEqual(first.sub_stage, VERIFICATION_STAGES.TESTING);
    const second = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(second.action, 'wait');
  });
});

// =====================================================================
// Group 9: Agent maps
// =====================================================================

describe('Group 9: Agent maps', () => {
  test('GLOBAL_TO_AGENT maps leaf global stages; composites have no agent', () => {
    assert.strictEqual(scheduler.GLOBAL_TO_AGENT['spec-check'], 'spec-checker');
    assert.strictEqual(scheduler.GLOBAL_TO_AGENT['task-decompose'], 'task-decomposer');
    assert.strictEqual(scheduler.GLOBAL_TO_AGENT['baseline-regression'], 'regression-runner');
    assert.strictEqual(scheduler.GLOBAL_TO_AGENT['evidence-verify'], 'evidence-verifier');
    assert.strictEqual(scheduler.GLOBAL_TO_AGENT['implementation'], undefined);
    assert.strictEqual(scheduler.GLOBAL_TO_AGENT['verification'], undefined);
  });

  test('VERIFICATION_TO_AGENT maps sub-stages', () => {
    assert.strictEqual(scheduler.VERIFICATION_TO_AGENT['testing'], 'test-generator');
    assert.strictEqual(scheduler.VERIFICATION_TO_AGENT['review'], 'code-reviewer');
    assert.strictEqual(scheduler.VERIFICATION_TO_AGENT['regression'], 'regression-runner');
    assert.strictEqual(scheduler.VERIFICATION_TO_AGENT['fix'], 'fixer');
  });
});

// =====================================================================
// Group 10: Terminal states
// =====================================================================

describe('Group 10: Terminal states', () => {
  test('all stages PASSED -> done', () => {
    const state = makeState();
    markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
    markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
    markGlobalPassed(state, GLOBAL_STAGES.BASELINE_REGRESSION);
    addJob(state, 'J1');
    markCodingPassed(state, 'J1');
    markVerificationPassed(state);
    markGlobalPassed(state, GLOBAL_STAGES.EVIDENCE_VERIFY);
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'done');
  });

  test('a terminally-FAILED job -> fail', () => {
    const state = makeState();
    markPreStagesPassed(state);
    addJob(state, 'J1');
    markJobFailed(state, 'J1');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.strictEqual(result.job_id, 'J1');
  });
});
