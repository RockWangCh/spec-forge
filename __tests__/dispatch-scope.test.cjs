#!/usr/bin/env node
/**
 * Unit tests for the dispatch-scope 协议 (dispatch-scope.cjs).
 *
 * Covers encode / decode of the description string, and the round-trip
 * decode(encode(x)) === x invariant for global / verification scopes.
 *
 * Run: node --test __tests__/dispatch-scope.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const dispatchScope = require(path.join(__dirname, '..', 'scripts', 'dispatch-scope.cjs'));

test('encode: global scope', () => {
  assert.strictEqual(
    dispatchScope.encode('20260724-100000-test', { scope: 'global', stageName: 'spec-check' }),
    'TS=20260724-100000-test GLOBAL=spec-check'
  );
});

test('encode: ts null falls back to "unknown"', () => {
  assert.strictEqual(
    dispatchScope.encode(null, { scope: 'global', stageName: 'evidence-verify' }),
    'TS=unknown GLOBAL=evidence-verify'
  );
});

test('encode: job scope (no WAVE=)', () => {
  assert.strictEqual(
    dispatchScope.encode('ts', { scope: 'job', jobId: 'J1' }),
    'TS=ts JOB=J1 STAGE=coding'
  );
});

test('encode: verification sub-stage scope', () => {
  assert.strictEqual(
    dispatchScope.encode('ts', { scope: 'verification', subStage: 'fix' }),
    'TS=ts GLOBAL=verification STAGE=fix'
  );
});

test('decode: global', () => {
  assert.deepStrictEqual(
    dispatchScope.decode('TS=x GLOBAL=spec-check'),
    { scope: 'global', stageName: 'spec-check' }
  );
});

test('decode: job (JOB= takes precedence)', () => {
  assert.deepStrictEqual(
    dispatchScope.decode('TS=x JOB=J1 STAGE=coding'),
    { scope: 'job', jobId: 'J1' }
  );
});

test('decode: verification sub-stage', () => {
  assert.deepStrictEqual(
    dispatchScope.decode('TS=x GLOBAL=verification STAGE=fix'),
    { scope: 'verification', stageName: 'verification', subStage: 'fix' }
  );
});

test('decode: baseline-regression is a global scope (not verification)', () => {
  assert.deepStrictEqual(
    dispatchScope.decode('TS=x GLOBAL=baseline-regression'),
    { scope: 'global', stageName: 'baseline-regression' }
  );
});

test('decode: unknown for null / garbage', () => {
  assert.deepStrictEqual(dispatchScope.decode(null), { scope: 'unknown' });
  assert.deepStrictEqual(dispatchScope.decode('garbage'), { scope: 'unknown' });
});

test('extractTs returns TS from description', () => {
  assert.strictEqual(
    dispatchScope.extractTs('TS=20260724-100000-test GLOBAL=spec-check'),
    '20260724-100000-test'
  );
  assert.strictEqual(
    dispatchScope.extractTs('TS=20260724-100000-test JOB=J1 STAGE=coding'),
    '20260724-100000-test'
  );
});

test('extractTs returns null for missing / garbage input', () => {
  assert.strictEqual(dispatchScope.extractTs(null), null);
  assert.strictEqual(dispatchScope.extractTs(''), null);
  assert.strictEqual(dispatchScope.extractTs('GLOBAL=spec-check'), null);
  assert.strictEqual(dispatchScope.extractTs('garbage'), null);
});

test('round-trip: decode(encode(ts, scope)) === scope (global/verification)', () => {
  const cases = [
    { scope: 'global', stageName: 'spec-check' },
    { scope: 'verification', subStage: 'testing' },
    { scope: 'verification', subStage: 'regression' }
  ];
  for (const c of cases) {
    const decoded = dispatchScope.decode(dispatchScope.encode('ts', c));
    if (c.scope === 'verification') {
      // decode 额外回填 stageName（encode 时硬编码 GLOBAL=verification）。
      assert.deepStrictEqual(decoded, { scope: 'verification', stageName: 'verification', subStage: c.subStage });
    } else {
      assert.deepStrictEqual(decoded, c);
    }
  }
});
