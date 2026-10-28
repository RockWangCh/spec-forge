/**
 * Export consistency self-check (Job-DAG Pipeline Model).
 *
 * Audits state.cjs module.exports to ensure every key resolves to a defined
 * function. Guards against the regression where a helper was defined
 * internally but missing from module.exports.
 *
 * Run: node --test hooks/lib/__tests__/state.exports.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));

test('module.exports is a non-empty object', () => {
  assert.ok(typeof stateLib === 'object' && stateLib !== null);
  assert.ok(Object.keys(stateLib).length > 0);
});

test('every exported key resolves to a defined function', () => {
  const bad = [];
  for (const key of Object.keys(stateLib)) {
    const v = stateLib[key];
    if (typeof v === 'undefined' || v === null) {
      bad.push({ key, reason: 'undefined/null' });
      continue;
    }
    // Constants (objects/arrays/sets) are allowed; functions must be callable.
    if (typeof v !== 'function') continue;
  }
  assert.deepEqual(bad, [], `undefined/null exports: ${JSON.stringify(bad)}`);
});

test('all path helpers are exported', () => {
  const required = [
    'resolveSpecsDir',
    'resolveTSDir',
    'resolveStateFile'
  ];
  for (const name of required) {
    assert.strictEqual(
      typeof stateLib[name],
      'function',
      `missing path helper: ${name}`
    );
  }
});

test('all job helpers are exported', () => {
  const required = [
    'getJobs',
    'initJobsFromManifest',
    'detectJobCycle',
    'getJobStatus',
    'recomputeJobStatus',
    'setJobCodingStage',
    'resetJobCodingStage',
    'allJobsTerminal',
    'allJobsPassed',
    'allJobsPassedOrWarned',
    'hasAnyJobWarn',
    'hasAnyJobRun',
    'jobDepsCodingPassed',
    'jobHasFailedDep',
    'recomputeJobCodingStatus'
  ];
  for (const name of required) {
    assert.strictEqual(
      typeof stateLib[name],
      'function',
      `missing job helper: ${name}`
    );
  }
});

test('all verification helpers are exported', () => {
  const required = [
    'getVerificationStage',
    'getCurrentRound',
    'recomputeVerificationStatus',
    'startNextVerificationRound',
    'recomputeImplementationStatus'
  ];
  for (const name of required) {
    assert.strictEqual(
      typeof stateLib[name],
      'function',
      `missing verification helper: ${name}`
    );
  }
});

test('all global-stage helpers are exported', () => {
  const required = [
    'setGlobalStage',
    'recomputeGlobalStageStatus',
    'allMandatoryStagesPassed',
    'allMandatoryStagesPassedOrWarned'
  ];
  for (const name of required) {
    assert.strictEqual(
      typeof stateLib[name],
      'function',
      `missing global helper: ${name}`
    );
  }
});

test('VERIFICATION_STAGES and VERIFICATION_STAGE_ORDER are exported', () => {
  assert.ok(stateLib.VERIFICATION_STAGES, 'VERIFICATION_STAGES exported');
  assert.ok(stateLib.VERIFICATION_STAGE_ORDER, 'VERIFICATION_STAGE_ORDER exported');
  assert.strictEqual(stateLib.VERIFICATION_STAGES.TESTING, 'testing');
  assert.strictEqual(stateLib.VERIFICATION_STAGES.REVIEW, 'review');
  assert.strictEqual(stateLib.VERIFICATION_STAGES.REGRESSION, 'regression');
  assert.strictEqual(stateLib.VERIFICATION_STAGES.FIX, 'fix');
  assert.deepStrictEqual(
    stateLib.VERIFICATION_STAGE_ORDER,
    ['testing', 'review', 'regression', 'fix']
  );
});

test('defaultState has schema_version 8 and pipeline_mode job-dag-pipeline', () => {
  const s = stateLib.defaultState();
  assert.strictEqual(s.schema_version, 8);
  assert.strictEqual(s.pipeline_mode, 'job-dag-pipeline');
  assert.ok(s.stages.implementation, 'has implementation stage');
  assert.ok(Array.isArray(s.stages.implementation.jobs));
  assert.strictEqual(s.stages.implementation.jobs.length, 0);
  assert.ok(s.stages.verification, 'has verification stage');
});

test('STAGE_STATUS includes all canonical statuses', () => {
  const expected = ['PENDING', 'IN_PROGRESS', 'PASSED', 'WARN', 'FAILED', 'BLOCKED', 'SKIPPED'];
  for (const s of expected) {
    assert.ok(s in stateLib.STAGE_STATUS, `missing STAGE_STATUS.${s}`);
  }
});

test('JOB_STATUS includes all canonical statuses', () => {
  const expected = ['PENDING', 'IN_PROGRESS', 'PASSED', 'WARN', 'FAILED', 'BLOCKED'];
  for (const s of expected) {
    assert.ok(s in stateLib.JOB_STATUS, `missing JOB_STATUS.${s}`);
  }
});
