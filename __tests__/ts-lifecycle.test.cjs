/**
 * TS Lifecycle — Unit Tests for One-Session-One-TS guarantees.
 *
 * Tests ensureTsLifecycle and markTsCompleted in isolation (pure function tests).
 *
 * Run: node --test __tests__/ts-lifecycle.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));

// ---- Helpers ----

function makeMinimalState() {
  // Build a state via the canonical factory so the lifecycle tests
  // operate against the real default shape.
  // Tests that need a state MISSING lifecycle fields delete them explicitly.
  const state = stateLib.defaultState();
  state.ts = '20260714-000000-aaaa';
  state.session_id = 'test-session';
  return state;
}

function makeTempProjectDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-lifecycle-'));
  fs.mkdirSync(path.join(root,  'specs'), { recursive: true });
  return root;
}

function writeState(root, ts, state) {
  const dir = path.join(root,  'specs', ts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

// ---- Tests ----

test('ensureTsLifecycle adds fields to state missing them', () => {
  const state = makeMinimalState();
  // defaultState() populates ts_lifecycle; simulate a state missing those fields.
  delete state.ts_lifecycle;
  delete state.ts_created_at;
  delete state.ts_completed_at;
  assert.strictEqual(state.ts_lifecycle, undefined);

  stateLib.ensureTsLifecycle(state);

  assert.strictEqual(state.ts_lifecycle, 'active');
  assert.ok(state.ts_created_at, 'ts_created_at should be set');
  assert.strictEqual(state.ts_completed_at, null);
});

test('ensureTsLifecycle preserves existing fields', () => {
  const state = makeMinimalState();
  const frozen = '2026-07-14T10:00:00.000Z';
  state.ts_lifecycle = 'completed';
  state.ts_created_at = frozen;
  state.ts_completed_at = frozen;

  stateLib.ensureTsLifecycle(state);

  assert.strictEqual(state.ts_lifecycle, 'completed');
  assert.strictEqual(state.ts_created_at, frozen);
  assert.strictEqual(state.ts_completed_at, frozen);
});

test('ensureTsLifecycle handles null/undefined state gracefully', () => {
  // Should not throw
  stateLib.ensureTsLifecycle(null);
  stateLib.ensureTsLifecycle(undefined);
});

test('markTsCompleted sets lifecycle to completed and records timestamp', () => {
  const state = makeMinimalState();
  stateLib.ensureTsLifecycle(state);
  assert.strictEqual(state.ts_lifecycle, 'active');

  stateLib.markTsCompleted(state);

  assert.strictEqual(state.ts_lifecycle, 'completed');
  assert.ok(state.ts_completed_at, 'ts_completed_at should be set');
  assert.ok(state.ts_created_at, 'ts_created_at should still be set');
});

test('defaultState includes TS lifecycle fields', () => {
  const state = stateLib.defaultState();

  assert.strictEqual(state.ts_lifecycle, 'active');
  assert.ok(state.ts_created_at, 'ts_created_at should be set');
  assert.strictEqual(state.ts_completed_at, null);
});

test('load with existing state.json applies ensureTsLifecycle', () => {
  const root = makeTempProjectDir();
  const ts = '20260714-111111-aaaa';
  const minimalState = makeMinimalState();
  // Omit lifecycle fields
  delete minimalState.ts_lifecycle;
  delete minimalState.ts_created_at;
  delete minimalState.ts_completed_at;
  writeState(root, ts, minimalState);

  const loaded = stateLib.load(ts, root);

  // ensureTsLifecycle should have been applied during load
  assert.strictEqual(loaded.ts_lifecycle, 'active');
  assert.ok(loaded.ts_created_at);
  assert.strictEqual(loaded.ts_completed_at, null);
});
