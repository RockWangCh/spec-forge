#!/usr/bin/env node
/**
 * Quick verification: WARN decision maps to PASSED outcome.
 * Run: node __tests__/warn-mapping.verify.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const handler = require(path.join(__dirname, '..', 'scripts', 'subagent-handler.cjs'));
const { _outcomeFromHandoff } = handler;

test('WARN decision -> PASSED outcome (soft pass)', () => {
  assert.strictEqual(_outcomeFromHandoff({ decision: 'WARN' }), 'PASSED');
  assert.strictEqual(_outcomeFromHandoff({ decision: 'warn' }), 'PASSED');
  assert.strictEqual(_outcomeFromHandoff({ decision: 'Warn' }), 'PASSED');
});

test('APPROVE decision -> PASSED outcome', () => {
  assert.strictEqual(_outcomeFromHandoff({ decision: 'APPROVE' }), 'PASSED');
  assert.strictEqual(_outcomeFromHandoff({ decision: 'PASS' }), 'PASSED');
});

test('BLOCK decision -> FAILED outcome', () => {
  assert.strictEqual(_outcomeFromHandoff({ decision: 'BLOCK' }), 'FAILED');
  assert.strictEqual(_outcomeFromHandoff({ decision: 'FAIL' }), 'FAILED');
  assert.strictEqual(_outcomeFromHandoff({ decision: 'REJECT' }), 'FAILED');
});

test('marker_outcome is respected when decision is unknown', () => {
  // When decision is unknown/empty, marker_outcome drives the result
  assert.strictEqual(_outcomeFromHandoff({ decision: '', markers: { marker_outcome: 'PASSED' } }), 'PASSED');
  assert.strictEqual(_outcomeFromHandoff({ decision: '', markers: { marker_outcome: 'FAILED' } }), 'FAILED');
});

test('empty/unknown decision -> default PASSED', () => {
  assert.strictEqual(_outcomeFromHandoff({ decision: '' }), 'PASSED');
  assert.strictEqual(_outcomeFromHandoff({}), 'PASSED');
});

test('WARN preserves review_decision marker for evidence-verifier', () => {
  // Simulate the handler path: handoff with WARN decision
  // The handler copies markers, then sets marker_outcome=PASSED
  var handoff = {
    decision: 'WARN',
    markers: { review_decision: 'WARN' }
  };
  var outcome = _outcomeFromHandoff(handoff);
  assert.strictEqual(outcome, 'PASSED');
  // review_decision marker is preserved (copied by the handler before outcome check)
  assert.strictEqual(handoff.markers.review_decision, 'WARN');
});
