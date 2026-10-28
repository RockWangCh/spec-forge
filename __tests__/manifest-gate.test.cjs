/**
 * Unit tests for the content-manifest gate.
 *
 * coding (job) and verification-testing stages must emit a durable content
 * manifest describing WHAT they did, not just pass/fail markers. The gate
 * validates only existence + parseable JSON + key identity fields; semantic
 * consistency is the review/evidence-verifier's responsibility.
 *
 * Covers:
 *   - _validateManifestFile (missing / invalid JSON / non-object / missing key / valid)
 *   - _checkManifestGate (job coding + verification testing gated; others not)
 *   - handleSubagentStop integration (PASS without manifest -> FAILED; with -> PASSED)
 *   - WARN is still gated (soft pass needs a manifest too)
 *   - content-non-empty is NOT enforced (empty changed_files/symbols still pass)
 *
 * Run: node --test __tests__/manifest-gate.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// PROJECT_DIR must be set BEFORE requiring subagent-handler — SPECS_DIR is
// captured at module load time. Use a throwaway dir so the gate looks for
// manifests under a path we control.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-gate-'));
process.env.PROJECT_DIR = tmpRoot;

const handler = require(path.join(__dirname, '..', 'scripts', 'subagent-handler.cjs'));
const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));

const { _validateManifestFile, _checkManifestGate, handleSubagentStop } = handler;

const TS = '20990101-000000';
const specsDir = path.join(tmpRoot, 'specs', TS);

function makeState() {
  const state = stateLib.defaultState();
  state.ts = TS;
  return state;
}

// State with one flat job (job-dag model: implementation.jobs[]).
function makeJobState(jobId) {
  const state = makeState();
  state.stages.implementation.jobs.push(
    stateLib.defaultJob({ id: jobId, agent_type: 'implementer' })
  );
  return state;
}

function writeRaw(relName, content) {
  const p = path.join(specsDir, relName);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function writeManifest(relName, obj) {
  return writeRaw(relName, JSON.stringify(obj));
}

function handoffOutput(decision) {
  return 'HANDOFF_BEGIN\n' + JSON.stringify({ decision: decision, artifacts: [] }) + '\nHANDOFF_END';
}

// ---- _validateManifestFile ----

test('_validateManifestFile: missing file -> not ok', () => {
  const r = _validateManifestFile(path.join(specsDir, 'does-not-exist.json'), ['ts']);
  assert.strictEqual(r.ok, false);
  assert.ok(/missing manifest/.test(r.reason), 'reason mentions missing manifest');
});

test('_validateManifestFile: invalid JSON -> not ok', () => {
  const p = writeRaw('invalid.json', '{not valid json');
  const r = _validateManifestFile(p, ['ts']);
  assert.strictEqual(r.ok, false);
  assert.ok(/parseable/.test(r.reason), 'reason mentions parseable JSON');
});

test('_validateManifestFile: non-object (array) -> not ok', () => {
  const p = writeManifest('array.json', [1, 2, 3]);
  const r = _validateManifestFile(p, ['ts']);
  assert.strictEqual(r.ok, false);
});

test('_validateManifestFile: missing identity key -> not ok', () => {
  const p = writeManifest('nokey.json', { ts: TS, agent: 'implementer' });
  const r = _validateManifestFile(p, ['ts', 'job_id', 'agent', 'stage']);
  assert.strictEqual(r.ok, false);
  assert.ok(/missing key "job_id"/.test(r.reason), 'reason names the missing key');
});

test('_validateManifestFile: valid object with all keys -> ok', () => {
  const p = writeManifest('ok.json', { ts: TS, job_id: 'J0-1', agent: 'implementer', stage: 'coding' });
  const r = _validateManifestFile(p, ['ts', 'job_id', 'agent', 'stage']);
  assert.strictEqual(r.ok, true);
});

// ---- _checkManifestGate ----

test('_checkManifestGate: job scope, manifest present -> ok', () => {
  writeManifest('coding-manifest-JGATE-OK.json', {
    ts: TS, job_id: 'JGATE-OK', agent: 'implementer', stage: 'coding',
    changed_files: [], symbols: [] // content-non-empty is NOT enforced
  });
  const r = _checkManifestGate(makeState(), { scope: 'job', jobId: 'JGATE-OK' });
  assert.strictEqual(r.ok, true);
});

test('_checkManifestGate: job scope, manifest missing -> not ok', () => {
  const r = _checkManifestGate(makeState(), { scope: 'job', jobId: 'JGATE-MISSING' });
  assert.strictEqual(r.ok, false);
});

test('_checkManifestGate: verification testing scope, manifest present -> ok', () => {
  writeManifest('test-manifest.json', {
    ts: TS, agent: 'test-generator', stage: 'testing'
  });
  const r = _checkManifestGate(makeState(), { scope: 'verification', subStage: 'testing' });
  assert.strictEqual(r.ok, true);
});

test('_checkManifestGate: non-gated scopes -> null (no gate)', () => {
  assert.strictEqual(_checkManifestGate(makeState(), { scope: 'verification', subStage: 'review' }), null);
  assert.strictEqual(_checkManifestGate(makeState(), { scope: 'verification', subStage: 'fix' }), null);
  assert.strictEqual(_checkManifestGate(makeState(), { scope: 'verification', subStage: 'regression' }), null);
  assert.strictEqual(_checkManifestGate(makeState(), { scope: 'global', stageName: 'spec-check' }), null);
});

// ---- handleSubagentStop integration ----

test('handleSubagentStop: implementer PASS without manifest -> FAILED', () => {
  const state = makeJobState('J-IMPL-NOMAN');
  handleSubagentStop(state, { scope: 'job', jobId: 'J-IMPL-NOMAN' }, 'implementer', handoffOutput('PASS'), 'completed');
  const coding = stateLib.getJobs(state)['J-IMPL-NOMAN'].coding;
  assert.strictEqual(coding.markers.marker_outcome, 'FAILED');
  assert.ok(Array.isArray(coding.markers.validation_errors), 'validation_errors recorded');
  assert.ok(coding.markers.validation_errors.some((e) => /manifest/.test(e)), 'error mentions manifest');
});

test('handleSubagentStop: implementer PASS with manifest -> PASSED', () => {
  writeManifest('coding-manifest-J-IMPL-HAS.json', {
    ts: TS, job_id: 'J-IMPL-HAS', agent: 'implementer', stage: 'coding',
    changed_files: [{ path: 'src/a.cpp', op: 'modified', summary: 'x' }],
    symbols: [{ name: 'f', kind: 'function', signature: '()', file: 'src/a.cpp', description: 'x' }]
  });
  const state = makeJobState('J-IMPL-HAS');
  handleSubagentStop(state, { scope: 'job', jobId: 'J-IMPL-HAS' }, 'implementer', handoffOutput('PASS'), 'completed');
  assert.strictEqual(stateLib.getJobs(state)['J-IMPL-HAS'].coding.markers.marker_outcome, 'PASSED');
});

test('handleSubagentStop: verification testing PASS without manifest -> FAILED', () => {
  const state = makeState();
  state.ts = '20990101-999999'; // distinct TS dir → no leftover test-manifest.json
  handleSubagentStop(state, { scope: 'verification', subStage: 'testing' }, 'test-generator', handoffOutput('PASS'), 'completed');
  assert.strictEqual(stateLib.getCurrentRound(stateLib.getVerificationStage(state)).testing.markers.marker_outcome, 'FAILED');
});

test('handleSubagentStop: verification testing PASS with manifest -> PASSED', () => {
  writeManifest('test-manifest.json', {
    ts: TS, agent: 'test-generator', stage: 'testing',
    acceptance_criteria: [{ id: 'AC-1', scenario: 'x', tests: ['t'], status: 'TRACED' }]
  });
  const state = makeState();
  handleSubagentStop(state, { scope: 'verification', subStage: 'testing' }, 'test-generator', handoffOutput('PASS'), 'completed');
  assert.strictEqual(stateLib.getCurrentRound(stateLib.getVerificationStage(state)).testing.markers.marker_outcome, 'PASSED');
});

test('handleSubagentStop: implementer FAIL without manifest -> stays FAILED (no gate on FAIL)', () => {
  const state = makeJobState('J-IMPL-FAIL');
  handleSubagentStop(state, { scope: 'job', jobId: 'J-IMPL-FAIL' }, 'implementer', handoffOutput('FAIL'), 'completed');
  assert.strictEqual(stateLib.getJobs(state)['J-IMPL-FAIL'].coding.markers.marker_outcome, 'FAILED');
});

test('handleSubagentStop: WARN decision still gated (soft pass needs manifest too)', () => {
  const state = makeJobState('J-IMPL-WARN');
  handleSubagentStop(state, { scope: 'job', jobId: 'J-IMPL-WARN' }, 'implementer', handoffOutput('WARN'), 'completed');
  assert.strictEqual(stateLib.getJobs(state)['J-IMPL-WARN'].coding.markers.marker_outcome, 'FAILED');
});
