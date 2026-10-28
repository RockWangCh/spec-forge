/**
 * Unit tests for the job-dag-pipeline state machine.
 *
 * Covers:
 *   - recomputeGlobalStageStatus (attempt window + marker precedence + idempotency)
 *   - recomputeJobCodingStatus (same logic, job coding scope — coding only)
 *   - recomputeJobStatus (aggregation: coding status only, no wave)
 *   - recomputeVerificationStatus (testing/review/regression/fix loop)
 *   - startNextVerificationRound (archive round + start next round)
 *   - setGlobalStage / setJobCodingStage (attempt window reset)
 *   - allJobsTerminal / allJobsPassed / resetJobCodingStage
 *   - initJobsFromManifest (flat jobs + cycle detection)
 *
 * Run: node --test __tests__/state.recompute.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));
const {
  STAGE_STATUS,
  JOB_STATUS,
  GLOBAL_STAGES
} = stateLib;

// ---- Fixture helpers ----

function isoAgo(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

function makeStage(overrides) {
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

function makeState() {
  const state = stateLib.defaultState();
  state.ts = '20990101-000000';
  return state;
}

// Jobs live inside state.stages.implementation.jobs[] (flat).
function getJobs(state) {
  return stateLib.getJobs(state);
}

function makeGlobalState(stageName, stage) {
  const state = makeState();
  if (stage) state.stages[stageName] = stage;
  return state;
}

// Build a state with one flat job whose coding stage is populated.
function makeJobState(jobId, codingStageObj, jobOverrides) {
  const state = makeState();
  const job = stateLib.defaultJob({ id: jobId, agent_type: 'implementer' });
  if (codingStageObj) job.coding = codingStageObj;
  if (jobOverrides) Object.assign(job, jobOverrides);
  state.stages.implementation.jobs.push(job);
  return state;
}

function run(outcome, startedAt, extra) {
  return Object.assign({
    agent_type: null,
    agent_id: 'a-' + outcome,
    tool_use_id: 'tu-' + Math.random().toString(36).slice(2),
    outcome: outcome,
    started_at: startedAt,
    stopped_at: outcome === 'IN_PROGRESS' ? null : startedAt,
    exit_status: outcome === 'IN_PROGRESS' ? null : 'completed'
  }, extra || {});
}

// =====================================================================
// recomputeGlobalStageStatus
// =====================================================================

test('1. retry-success: prior-attempt FAILED runs excluded by window, marker PASSED -> PASSED', () => {
  const t0 = isoAgo(20 * 60000);
  const t1 = isoAgo(15 * 60000);
  const t2 = isoAgo(2 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: t2,
    attempt_count: 2,
    markers: { marker_outcome: 'PASSED' },
    runs: [run('FAILED', t0), run('FAILED', t1), run('PASSED', t2)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY);
  assert.strictEqual(result, STAGE_STATUS.PASSED);
  assert.strictEqual(stage.status, STAGE_STATUS.PASSED);
});

test('2. retry-still-failing: attempt-2 run FAILED + marker FAILED -> FAILED (not IN_PROGRESS)', () => {
  const t0 = isoAgo(20 * 60000);
  const t2 = isoAgo(2 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: t2,
    attempt_count: 2,
    markers: { marker_outcome: 'FAILED' },
    runs: [run('FAILED', t0), run('FAILED', t2)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY);
  assert.strictEqual(result, STAGE_STATUS.FAILED);
});

test('3. evidence-verify happy: in-window PASSED run + marker PASSED -> PASSED', () => {
  const start = isoAgo(10 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: start,
    attempt_count: 1,
    markers: { marker_outcome: 'PASSED', review_decision: 'APPROVE' },
    runs: [run('PASSED', start)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY);
  assert.strictEqual(result, STAGE_STATUS.PASSED);
});

test('4. global stage FAILED run (no in-progress) -> FAILED', () => {
  const start = isoAgo(10 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: start,
    attempt_count: 1,
    runs: [run('FAILED', start)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.SPEC_CHECK);
  assert.strictEqual(result, STAGE_STATUS.FAILED);
});

test('5. global stage partial (IN_PROGRESS run) -> IN_PROGRESS, not premature PASSED', () => {
  const start = isoAgo(5 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: start,
    attempt_count: 1,
    runs: [run('IN_PROGRESS', start)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.SPEC_CHECK);
  assert.strictEqual(result, STAGE_STATUS.IN_PROGRESS);
});

test('6. marker/run divergence: run=FAILED but marker=PASSED -> PASSED', () => {
  const t = isoAgo(5 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: t,
    attempt_count: 1,
    markers: { marker_outcome: 'PASSED' },
    runs: [run('FAILED', t)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY);
  assert.strictEqual(result, STAGE_STATUS.PASSED);
});

test('7. no in-window runs and no marker -> status unchanged (PENDING stays PENDING)', () => {
  const stage = makeStage({ status: STAGE_STATUS.PENDING });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.SPEC_CHECK);
  assert.strictEqual(result, STAGE_STATUS.PENDING);
  assert.strictEqual(stage.status, STAGE_STATUS.PENDING);
});

test('8. stale IN_PROGRESS from a prior attempt is excluded by window; current attempt PASSED decides', () => {
  const oldStale = isoAgo(60 * 60000);
  const t2 = isoAgo(2 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: t2,
    attempt_count: 2,
    markers: { marker_outcome: 'PASSED' },
    runs: [run('IN_PROGRESS', oldStale), run('PASSED', t2)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY);
  assert.strictEqual(result, STAGE_STATUS.PASSED);
});

test('9. idempotency: recompute twice stays PASSED, never flips to IN_PROGRESS', () => {
  const t2 = isoAgo(2 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: t2,
    attempt_count: 2,
    markers: { marker_outcome: 'PASSED' },
    runs: [run('PASSED', t2)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  assert.strictEqual(stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY), STAGE_STATUS.PASSED);
  stage.runs.push(run('IN_PROGRESS', isoAgo(1 * 60000)));
  assert.strictEqual(stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.EVIDENCE_VERIFY), STAGE_STATUS.PASSED);
  assert.strictEqual(stage.status, STAGE_STATUS.PASSED);
});

test('10. out-of-order completion converges to PASSED after each recompute', () => {
  const start = isoAgo(10 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: start,
    attempt_count: 1,
    runs: [run('IN_PROGRESS', start)]
  });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  assert.strictEqual(stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.SPEC_CHECK), STAGE_STATUS.IN_PROGRESS);
  stage.runs[0].outcome = 'PASSED';
  stage.runs[0].stopped_at = start;
  assert.strictEqual(stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.SPEC_CHECK), STAGE_STATUS.PASSED);
});

// =====================================================================
// recomputeJobCodingStatus + recomputeJobStatus (coding only, no wave)
// =====================================================================

test('11. job coding PASSED -> job PASSED (no wave dependency)', () => {
  const state = makeJobState('j1', null);
  stateLib.setJobCodingStage(state, 'j1', STAGE_STATUS.PASSED);
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.PASSED);
});

test('12. job coding WARN -> job WARN', () => {
  const state = makeJobState('j1', null);
  getJobs(state)['j1'].coding.status = STAGE_STATUS.WARN;
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.WARN);
});

test('13. job coding FAILED + retries exhausted -> job FAILED', () => {
  const state = makeJobState('j1', null, { attempt_count: 2, max_retries: 2 });
  getJobs(state)['j1'].coding.status = STAGE_STATUS.FAILED;
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.FAILED);
});

test('14. job coding FAILED but retries available -> job IN_PROGRESS (retry pending)', () => {
  const state = makeJobState('j1', null, { attempt_count: 0, max_retries: 2 });
  getJobs(state)['j1'].coding.status = STAGE_STATUS.FAILED;
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.IN_PROGRESS);
});

test('15. job coding IN_PROGRESS -> job IN_PROGRESS', () => {
  const state = makeJobState('j1', null);
  stateLib.setJobCodingStage(state, 'j1', STAGE_STATUS.IN_PROGRESS);
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.IN_PROGRESS);
});

test('16. job coding PENDING -> job PENDING', () => {
  const state = makeJobState('j1', null);
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.PENDING);
});

test('17. job coding BLOCKED -> job BLOCKED', () => {
  const state = makeJobState('j1', null);
  getJobs(state)['j1'].coding.status = STAGE_STATUS.BLOCKED;
  assert.strictEqual(stateLib.recomputeJobStatus(state, 'j1'), JOB_STATUS.BLOCKED);
});

// =====================================================================
// recomputeVerificationStatus + startNextVerificationRound
// =====================================================================

function curRound(state) {
  return stateLib.getCurrentRound(stateLib.getVerificationStage(state));
}

test('verification: regression PASSED -> composite PASSED', () => {
  const state = makeState();
  curRound(state).regression.status = STAGE_STATUS.PASSED;
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.PASSED);
});

test('verification: fix WARN -> composite WARN (soft pass)', () => {
  const state = makeState();
  curRound(state).fix.status = STAGE_STATUS.WARN;
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.WARN);
});

test('verification: regression WARN -> composite WARN (perf regression soft pass)', () => {
  const state = makeState();
  curRound(state).regression.status = STAGE_STATUS.WARN;
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.WARN);
});

test('verification: regression FAILED + retries available -> IN_PROGRESS', () => {
  const state = makeState();
  const ver = stateLib.getVerificationStage(state);
  ver.max_retries = 2;
  curRound(state).regression.status = STAGE_STATUS.FAILED;
  // rounds.length = 1 → fixRounds = 0 < max_retries
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.IN_PROGRESS);
});

test('verification: regression FAILED + retries exhausted -> FAILED', () => {
  const state = makeState();
  const ver = stateLib.getVerificationStage(state);
  // simulate max_retries=2 fix rounds completed → rounds.length = 3
  stateLib.startNextVerificationRound(state);
  stateLib.startNextVerificationRound(state);
  ver.max_retries = 2;
  curRound(state).regression.status = STAGE_STATUS.FAILED;
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.FAILED);
});

test('verification: testing IN_PROGRESS -> composite IN_PROGRESS', () => {
  const state = makeState();
  curRound(state).testing.status = STAGE_STATUS.IN_PROGRESS;
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.IN_PROGRESS);
});

test('verification: all PENDING -> composite PENDING', () => {
  const state = makeState();
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.PENDING);
});

test('verification: testing PASSED + review PENDING -> composite IN_PROGRESS', () => {
  const state = makeState();
  curRound(state).testing.status = STAGE_STATUS.PASSED;
  assert.strictEqual(stateLib.recomputeVerificationStatus(state), STAGE_STATUS.IN_PROGRESS);
});

test('startNextVerificationRound: archives current round + starts a fresh one', () => {
  const state = makeState();
  const ver = stateLib.getVerificationStage(state);
  const cur = curRound(state);
  cur.testing.status = STAGE_STATUS.PASSED;
  cur.review.status = STAGE_STATUS.PASSED;
  cur.regression.status = STAGE_STATUS.FAILED;
  cur.fix.status = STAGE_STATUS.PASSED;

  stateLib.startNextVerificationRound(state);

  assert.strictEqual(ver.rounds.length, 2);
  // archived round preserved
  assert.strictEqual(ver.rounds[0].regression.status, STAGE_STATUS.FAILED);
  assert.strictEqual(ver.rounds[0].fix.status, STAGE_STATUS.PASSED);
  // new round is fresh
  assert.strictEqual(ver.rounds[1].testing.status, STAGE_STATUS.PENDING);
  assert.strictEqual(ver.rounds[1].regression.status, STAGE_STATUS.PENDING);
  assert.strictEqual(ver.status, STAGE_STATUS.PENDING);
});

test('getVerificationStage: ignores legacy flat stages + backfills rounds', () => {
  const state = makeState();
  const ver = stateLib.getVerificationStage(state);
  // simulate a state.json written under the old flat `stages` model
  delete ver.rounds;
  ver.stages = { testing: { status: STAGE_STATUS.PASSED }, review: {}, regression: {}, fix: {} };

  const got = stateLib.getVerificationStage(state);
  assert.ok(Array.isArray(got.rounds), 'rounds backfilled');
  assert.strictEqual(got.rounds.length, 1, 'one fresh round');
  assert.strictEqual(got.rounds[0].testing.status, STAGE_STATUS.PENDING, 'legacy stages discarded');
});

// =====================================================================
// setGlobalStage / setJobCodingStage: attempt window reset
// =====================================================================

test('setGlobalStage: fresh retry from FAILED resets started_at, clears markers/artifacts, bumps attempt_count', () => {
  const oldStart = isoAgo(60 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.FAILED,
    started_at: oldStart,
    completed_at: oldStart,
    attempt_count: 1,
    markers: { marker_outcome: 'FAILED' },
    artifacts: ['x.md']
  });
  const state = makeGlobalState(GLOBAL_STAGES.EVIDENCE_VERIFY, stage);
  stateLib.setGlobalStage(state, GLOBAL_STAGES.EVIDENCE_VERIFY, STAGE_STATUS.IN_PROGRESS);
  assert.notStrictEqual(stage.started_at, oldStart, 'started_at should be reset to the new attempt start');
  assert.deepStrictEqual(stage.markers, {}, 'markers cleared on retry');
  assert.deepStrictEqual(stage.artifacts, [], 'artifacts cleared on retry');
  assert.strictEqual(stage.attempt_count, 2);
});

test('setGlobalStage: additional dispatch while already IN_PROGRESS does NOT reset started_at (same attempt)', () => {
  const start = isoAgo(10 * 60000);
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: start,
    attempt_count: 1,
    markers: { some: 'thing' }
  });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  stateLib.setGlobalStage(state, GLOBAL_STAGES.SPEC_CHECK, STAGE_STATUS.IN_PROGRESS);
  assert.strictEqual(stage.started_at, start, 'started_at unchanged within the same attempt');
  assert.strictEqual(stage.attempt_count, 1, 'attempt_count not bumped within same attempt');
  assert.deepStrictEqual(stage.markers, { some: 'thing' }, 'markers preserved within same attempt');
});

test('setGlobalStage: first entry from PENDING sets started_at and attempt_count=1 without clearing', () => {
  const stage = makeStage({ status: STAGE_STATUS.PENDING });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  stateLib.setGlobalStage(state, GLOBAL_STAGES.SPEC_CHECK, STAGE_STATUS.IN_PROGRESS);
  assert.ok(stage.started_at, 'started_at set on first entry');
  assert.strictEqual(stage.attempt_count, 1);
});

test('setJobCodingStage: first entry sets started_at and bumps attempt_count', () => {
  const state = makeJobState('j1', null);
  stateLib.setJobCodingStage(state, 'j1', STAGE_STATUS.IN_PROGRESS);
  const ms = getJobs(state)['j1'].coding;
  assert.ok(ms.started_at, 'coding stage started_at set');
  assert.strictEqual(ms.attempt_count, 1);
});

// =====================================================================
// allJobsTerminal / allJobsPassed
// =====================================================================

test('allJobsTerminal / allJobsPassed: empty jobs -> true for both', () => {
  const state = makeState();
  assert.strictEqual(stateLib.allJobsTerminal(state), true);
  assert.strictEqual(stateLib.allJobsPassed(state), true);
});

test('allJobsTerminal: false when a job is IN_PROGRESS; true when all terminal', () => {
  const state = makeState();
  state.stages.implementation.jobs.push(stateLib.defaultJob({ id: 'j1' }));
  state.stages.implementation.jobs.push(stateLib.defaultJob({ id: 'j2' }));
  stateLib.setJobCodingStage(state, 'j1', STAGE_STATUS.PASSED);
  // j1 PASSED, j2 PENDING -> not all terminal, not all passed
  assert.strictEqual(stateLib.allJobsTerminal(state), false);
  assert.strictEqual(stateLib.allJobsPassed(state), false);
  stateLib.setJobCodingStage(state, 'j2', STAGE_STATUS.PASSED);
  assert.strictEqual(stateLib.allJobsTerminal(state), true);
  assert.strictEqual(stateLib.allJobsPassed(state), true);
});

test('allJobsPassed: false when a job is FAILED', () => {
  const state = makeState();
  state.stages.implementation.jobs.push(stateLib.defaultJob({ id: 'j1' }));
  getJobs(state)['j1'].max_retries = 0;
  getJobs(state)['j1'].attempt_count = 1;
  getJobs(state)['j1'].coding.status = STAGE_STATUS.FAILED;
  assert.strictEqual(stateLib.allJobsTerminal(state), true);
  assert.strictEqual(stateLib.allJobsPassed(state), false);
});

// =====================================================================
// resetJobCodingStage
// =====================================================================

test('resetJobCodingStage: clears coding stage and bumps attempt_count', () => {
  const state = makeJobState('j1', null);
  stateLib.setJobCodingStage(state, 'j1', STAGE_STATUS.PASSED);
  const beforeRetry = getJobs(state)['j1'].attempt_count;

  stateLib.resetJobCodingStage(state, 'j1');

  const job = getJobs(state)['j1'];
  assert.strictEqual(job.attempt_count, beforeRetry + 1, 'attempt_count bumped');
  assert.strictEqual(job.coding.status, STAGE_STATUS.PENDING);
});

// =====================================================================
// initJobsFromManifest (flat jobs + cycle detection)
// =====================================================================

test('initJobsFromManifest: creates flat jobs with coding stage', () => {
  const state = makeState();
  const result = stateLib.initJobsFromManifest(state, {
    jobs: [{
      id: 'j1',
      agent_type: 'implementer',
      description: 'do thing',
      files: ['a.ts'],
      produces: ['a.ts'],
      depends_on: []
    }]
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(Object.keys(getJobs(state)).length, 1);
  const job = getJobs(state)['j1'];
  assert.strictEqual(job.id, 'j1');
  assert.strictEqual(job.agent_type, 'implementer');
  assert.strictEqual(job.description, 'do thing');
  assert.deepStrictEqual(job.files, ['a.ts']);
  assert.ok(job.coding, 'coding stage exists');
  assert.strictEqual(job.testing, undefined, 'no testing/review/fix on the job');
  assert.strictEqual(job.review, undefined);
  assert.strictEqual(job.status, JOB_STATUS.PENDING);
  assert.strictEqual(state.stages.implementation.jobs.length, 1);
});

test('initJobsFromManifest: multiple flat jobs with depends_on', () => {
  const state = makeState();
  const result = stateLib.initJobsFromManifest(state, {
    jobs: [
      { id: 'j1', agent_type: 'implementer', description: 'a', files: [], produces: [], depends_on: [] },
      { id: 'j2', agent_type: 'implementer', description: 'b', files: [], produces: [], depends_on: ['j1'] }
    ]
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(Object.keys(getJobs(state)).length, 2);
  assert.strictEqual(state.stages.implementation.jobs.length, 2);
  assert.deepStrictEqual(getJobs(state)['j2'].depends_on, ['j1']);
});

test('initJobsFromManifest: rejects cyclic depends_on', () => {
  const state = makeState();
  const result = stateLib.initJobsFromManifest(state, {
    jobs: [
      { id: 'j1', depends_on: ['j2'] },
      { id: 'j2', depends_on: ['j1'] }
    ]
  });
  assert.strictEqual(result.ok, false);
  assert.ok(Array.isArray(result.cycle), 'cycle reported');
  assert.strictEqual(state.stages.implementation.jobs.length, 0, 'no jobs committed on cycle');
});

// =====================================================================
// Robustness P0 fixes (#3)
// =====================================================================

test('P0-3: recomputeGlobalStageStatus treats an IN_PROGRESS run missing started_at as stale FAILED', () => {
  const stage = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: isoAgo(5 * 60000),
    attempt_count: 1,
    runs: [{
      agent_type: 'spec-checker',
      agent_id: 'a-missing-ts',
      tool_use_id: 'tu-missing',
      outcome: 'IN_PROGRESS',
      started_at: null,
      stopped_at: null,
      exit_status: null
    }]
  });
  const state = makeGlobalState(GLOBAL_STAGES.SPEC_CHECK, stage);
  const result = stateLib.recomputeGlobalStageStatus(state, GLOBAL_STAGES.SPEC_CHECK);
  assert.strictEqual(result, STAGE_STATUS.FAILED, 'missing started_at => stale => FAILED');
  assert.strictEqual(stage.runs[0].outcome, 'FAILED');
  assert.strictEqual(stage.runs[0].exit_status, 'stale');
});

test('P0-3b: recomputeJobCodingStatus treats an IN_PROGRESS run missing started_at as stale FAILED', () => {
  const ms = makeStage({
    status: STAGE_STATUS.IN_PROGRESS,
    started_at: isoAgo(5 * 60000),
    attempt_count: 1,
    runs: [{
      agent_type: 'implementer',
      agent_id: 'a-missing-ts',
      tool_use_id: 'tu-missing',
      outcome: 'IN_PROGRESS',
      started_at: null,
      stopped_at: null,
      exit_status: null
    }]
  });
  const state = makeJobState('j1', ms);
  const result = stateLib.recomputeJobCodingStatus(state, 'j1');
  assert.strictEqual(result, STAGE_STATUS.FAILED, 'missing started_at => stale => FAILED');
  assert.strictEqual(ms.runs[0].outcome, 'FAILED');
  assert.strictEqual(ms.runs[0].exit_status, 'stale');
});
