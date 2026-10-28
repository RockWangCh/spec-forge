/**
 * Unit tests for subagent-handler fallback + artifact validation paths.
 *
 * Covers:
 *   - validateHandoffArtifacts: FAIL on missing-on-disk artifacts (with
 *     validation_errors), PASS on existing artifacts, accepts both string and
 *     {path} artifact shapes.
 *   - reconcileHandoffFiles: closes an IN_PROGRESS job coding from its handoff
 *     file (backgrounded-task fallback) and normalizes/dedupes mixed-shape
 *     artifacts.
 *
 * Run: node --test __tests__/subagent-handler.test.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// PROJECT_DIR must be set BEFORE requiring subagent-handler (the module
// captures SPECS_DIR / PROJECT_ROOT at load time).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-handler-'));
process.env.PROJECT_DIR = tmpRoot;

const handler = require(path.join(__dirname, '..', 'scripts', 'subagent-handler.cjs'));
const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));

const { reconcileHandoffFiles, validateHandoffArtifacts } = handler;

const TS = '20990101-000000';
const specsDir = path.join(tmpRoot, 'specs', TS);

test('validateHandoffArtifacts fails missing on-disk artifacts', () => {
  const stageObj = { markers: {} };
  const ok = validateHandoffArtifacts(stageObj, {
    artifacts: [{ path: '/definitely-missing-file.txt' }]
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(stageObj.markers.marker_outcome, 'FAILED');
  assert.ok(
    Array.isArray(stageObj.markers.validation_errors) && stageObj.markers.validation_errors.length > 0,
    'should record validation_errors'
  );
});

test('validateHandoffArtifacts passes existing artifacts (string + {path} shape)', () => {
  const real = path.join(tmpRoot, 'real.txt');
  fs.writeFileSync(real, 'x');
  const stageObj = { markers: {} };
  const ok = validateHandoffArtifacts(stageObj, { artifacts: [real, { path: real }] });
  assert.strictEqual(ok, true);
  assert.strictEqual(stageObj.markers.marker_outcome, undefined);
});

test('reconcileHandoffFiles closes IN_PROGRESS job coding and normalizes artifacts', () => {
  const state = stateLib.defaultState();
  state.ts = TS;
  const job = stateLib.defaultJob({ id: 'J1' });
  job.coding.status = 'IN_PROGRESS';
  state.stages.implementation.jobs.push(job);

  fs.mkdirSync(specsDir, { recursive: true });
  // Mixed-shape + duplicate artifacts (the shape seen in the wild).
  fs.writeFileSync(path.join(specsDir, 'handoff-J1-coding.json'), JSON.stringify({
    decision: 'PASS',
    artifacts: [{ path: '/a' }, '/a', '/b'],
    summary: 'done'
  }));
  // Valid coding manifest so the PASS is not downgraded by the manifest gate.
  fs.writeFileSync(path.join(specsDir, 'coding-manifest-J1.json'), JSON.stringify({
    ts: TS, job_id: 'J1', agent: 'implementer', stage: 'coding'
  }));

  const closed = reconcileHandoffFiles(state, TS, tmpRoot);

  assert.strictEqual(closed, true);
  assert.strictEqual(job.coding.status, 'PASSED');
  assert.deepStrictEqual(job.coding.artifacts, ['/a', '/b']);
});
