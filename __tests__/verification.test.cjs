/**
 * Unit tests for the project-level verification loop (scheduler.cjs).
 *
 * Covers:
 *   - baseline-regression: pre-coding full build+test (terminate on FAIL)
 *   - verification: post-implementation loop (testing → review → regression,
 *     with a fix loop: fix → testing, max 2 rounds; fixer WARN soft-pass)
 *
 * Run: node --test __tests__/verification.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));
const scheduler = require(path.join(__dirname, '..', 'scripts', 'scheduler.cjs'));

const {
  STAGE_STATUS,
  GLOBAL_STAGES,
  VERIFICATION_STAGES
} = stateLib;

function makeConfig(overrides) {
  return Object.assign({
    retry_policy: { global_max_retries: 2 }
  }, overrides || {});
}

function makeState() {
  const state = stateLib.defaultState();
  state.ts = '20990101-000000';
  return state;
}

function curRound(state) {
  return stateLib.getCurrentRound(stateLib.getVerificationStage(state));
}

function markGlobalPassed(state, stageName) {
  const stage = state.stages[stageName];
  stage.status = STAGE_STATUS.PASSED;
  stage.markers = stage.markers || {};
  stage.markers.marker_outcome = 'PASSED';
  stage.completed_at = new Date().toISOString();
}

function addJob(state, jobId) {
  const job = stateLib.defaultJob({ id: jobId });
  state.stages.implementation.jobs.push(job);
  return job;
}

function markCodingPassed(state, jobId) {
  const job = stateLib.getJobs(state)[jobId];
  job.coding.status = STAGE_STATUS.PASSED;
  job.coding.markers = job.coding.markers || {};
  job.coding.markers.marker_outcome = 'PASSED';
  job.coding.completed_at = new Date().toISOString();
  stateLib.recomputeJobStatus(state, jobId);
}

// A state where spec-check / task-decompose / baseline-regression are PASSED
// and all jobs' coding is PASSED — ready for the verification gate.
function makeImplementationDoneState() {
  const state = makeState();
  markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
  markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
  markGlobalPassed(state, GLOBAL_STAGES.BASELINE_REGRESSION);
  addJob(state, 'J1');
  markCodingPassed(state, 'J1');
  return state;
}

describe('baseline-regression', () => {
  test('spec+task PASSED -> dispatch baseline-regression (regression-runner)', () => {
    const state = makeState();
    markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
    markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'global');
    assert.strictEqual(result.stage, GLOBAL_STAGES.BASELINE_REGRESSION);
    assert.strictEqual(result.agent, 'regression-runner');
  });

  test('baseline-regression PASSED -> proceed to job coding', () => {
    const state = makeState();
    markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
    markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
    markGlobalPassed(state, GLOBAL_STAGES.BASELINE_REGRESSION);
    addJob(state, 'J1');
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'job');
    assert.strictEqual(result.job_id, 'J1');
    assert.strictEqual(result.stage, 'coding');
  });

  test('baseline-regression FAILED with no retries -> fail (terminate)', () => {
    const state = makeState();
    markGlobalPassed(state, GLOBAL_STAGES.SPEC_CHECK);
    markGlobalPassed(state, GLOBAL_STAGES.TASK_DECOMPOSE);
    const stage = state.stages[GLOBAL_STAGES.BASELINE_REGRESSION];
    stage.status = STAGE_STATUS.FAILED;
    stage.attempt_count = 3; // max_retries=2 exhausted
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.strictEqual(result.stage, GLOBAL_STAGES.BASELINE_REGRESSION);
  });
});

describe('verification gate (post-implementation)', () => {
  test('implementation PASSED -> dispatch verification testing (test-generator)', () => {
    const state = makeImplementationDoneState();
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'verification');
    assert.strictEqual(result.stage, GLOBAL_STAGES.VERIFICATION);
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.TESTING);
    assert.strictEqual(result.agent, 'test-generator');
  });

  test('stale verification sub-stage retry is bounded (exhausted -> fix)', () => {
    const state = makeImplementationDoneState();
    const sub = curRound(state).testing;
    sub.status = STAGE_STATUS.IN_PROGRESS;
    sub.started_at = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // stale
    sub.attempt_count = 2; // == global_max_retries (2)
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.FIX);
  });

  test('dispatching testing marks verification composite IN_PROGRESS', () => {
    const state = makeImplementationDoneState();
    const ver = stateLib.getVerificationStage(state);
    assert.strictEqual(ver.status, STAGE_STATUS.PENDING);
    scheduler.decideNext(state, makeConfig());
    assert.strictEqual(ver.status, STAGE_STATUS.IN_PROGRESS);
  });

  test('testing PASSED -> dispatch review (code-reviewer)', () => {
    const state = makeImplementationDoneState();
    curRound(state).testing.status = STAGE_STATUS.PASSED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.scope, 'verification');
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.REVIEW);
    assert.strictEqual(result.agent, 'code-reviewer');
  });

  test('review PASSED -> dispatch regression (regression-runner)', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.scope, 'verification');
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.REGRESSION);
    assert.strictEqual(result.agent, 'regression-runner');
  });

  test('regression PASSED -> dispatch evidence-verify', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    cur.regression.status = STAGE_STATUS.PASSED;
    cur.regression.completed_at = new Date().toISOString();
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'global');
    assert.strictEqual(result.stage, GLOBAL_STAGES.EVIDENCE_VERIFY);
    assert.strictEqual(result.agent, 'evidence-verifier');
    assert.strictEqual(cur.fix.status, STAGE_STATUS.SKIPPED);
    assert.strictEqual(cur.fix.skip_reason, 'regression passed');
  });

  test('regression WARN -> fix SKIPPED (perf soft pass, no fix)', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    cur.regression.status = STAGE_STATUS.WARN;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(cur.fix.status, STAGE_STATUS.SKIPPED);
    assert.strictEqual(cur.fix.skip_reason, 'regression warn');
    assert.strictEqual(stateLib.getVerificationStage(state).status, STAGE_STATUS.WARN);
    assert.strictEqual(result.scope, 'global');
    assert.strictEqual(result.stage, GLOBAL_STAGES.EVIDENCE_VERIFY);
  });

  test('testing FAILED -> dispatch fix (skip review + regression)', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.FAILED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.scope, 'verification');
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.FIX);
    assert.strictEqual(result.agent, 'fixer');
    assert.strictEqual(cur.review.status, STAGE_STATUS.SKIPPED);
    assert.strictEqual(cur.review.skip_reason, 'testing failed');
    assert.strictEqual(cur.regression.status, STAGE_STATUS.SKIPPED);
  });

  test('review FAILED -> dispatch fix (short-circuit, skip regression)', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.FAILED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.scope, 'verification');
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.FIX);
    assert.strictEqual(result.agent, 'fixer');
    assert.strictEqual(cur.regression.status, STAGE_STATUS.SKIPPED);
    assert.strictEqual(cur.regression.skip_reason, 'review failed');
  });

  test('regression FAILED -> dispatch fix (fixer)', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    cur.regression.status = STAGE_STATUS.FAILED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.scope, 'verification');
    assert.strictEqual(result.sub_stage, VERIFICATION_STAGES.FIX);
    assert.strictEqual(result.agent, 'fixer');
  });

  test('fix PASSED -> start next round -> re-run testing', () => {
    const state = makeImplementationDoneState();
    const ver = stateLib.getVerificationStage(state);
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    cur.regression.status = STAGE_STATUS.FAILED;

    let r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.sub_stage, VERIFICATION_STAGES.FIX);

    // fix PASSED → archive current round + start next round
    cur.fix.status = STAGE_STATUS.PASSED;
    r = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(r.sub_stage, VERIFICATION_STAGES.TESTING);
    assert.strictEqual(ver.rounds.length, 2);
    // archived round preserved its failure + fix
    assert.strictEqual(ver.rounds[0].regression.status, STAGE_STATUS.FAILED);
    assert.strictEqual(ver.rounds[0].fix.status, STAGE_STATUS.PASSED);
    // new round starts fresh
    assert.strictEqual(ver.rounds[1].regression.status, STAGE_STATUS.PENDING);
  });

  test('fix WARN -> verification WARN (soft pass) -> evidence-verify', () => {
    const state = makeImplementationDoneState();
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    cur.regression.status = STAGE_STATUS.FAILED;
    cur.fix.status = STAGE_STATUS.WARN;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(stateLib.getVerificationStage(state).status, STAGE_STATUS.WARN);
    assert.strictEqual(result.action, 'dispatch');
    assert.strictEqual(result.scope, 'global');
    assert.strictEqual(result.stage, GLOBAL_STAGES.EVIDENCE_VERIFY);
  });

  test('regression FAILED with retries exhausted -> fail', () => {
    const state = makeImplementationDoneState();
    // simulate max_retries=2 fix rounds already completed (rounds.length=3)
    stateLib.startNextVerificationRound(state);
    stateLib.startNextVerificationRound(state);
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.PASSED;
    cur.review.status = STAGE_STATUS.PASSED;
    cur.regression.status = STAGE_STATUS.FAILED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.ok(/Verification FAILED/.test(result.reason), 'reason should mention verification: ' + result.reason);
    assert.strictEqual(cur.fix.status, STAGE_STATUS.SKIPPED);
    assert.strictEqual(cur.fix.skip_reason, 'retries exhausted');
  });

  test('testing FAILED with retries exhausted -> fail (uniform cap)', () => {
    const state = makeImplementationDoneState();
    // simulate max_retries=2 fix rounds already completed (rounds.length=3)
    stateLib.startNextVerificationRound(state);
    stateLib.startNextVerificationRound(state);
    const cur = curRound(state);
    cur.testing.status = STAGE_STATUS.FAILED;
    const result = scheduler.decideNext(state, makeConfig());
    assert.strictEqual(result.action, 'fail');
    assert.ok(/Verification FAILED/.test(result.reason), 'reason should mention verification: ' + result.reason);
  });
});
