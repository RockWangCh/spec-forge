/**
 * Auto-commit tests — pure helpers + defaultState fields + diff export.
 *
 * The deterministic core of the commit epilogue is the specs/ exclusion
 * (`isSpecsPath`) and the fallback message builder (`readSpecTitle` /
 * `buildFallbackMessage`). The git plumbing in `cmdCommit` runs
 * `execFileSync` against the target repo, so it's exercised by integration
 * rather than unit tests here.
 *
 * Run: node --test __tests__/commit.test.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));
const diffLib = require(path.join(__dirname, '..', 'scripts', 'diff.cjs'));
const cliLib = require(path.join(__dirname, '..', 'scripts', 'cli.cjs'));

const { isSpecsPath, readSpecTitle, buildFallbackMessage, performCommit } = cliLib;
const { execSync } = require('child_process');

test('defaultState carries auto_commit=false and commit=null', () => {
  const state = stateLib.defaultState();
  assert.strictEqual(state.auto_commit, false);
  assert.strictEqual(state.commit, null);
});

test('diff.cjs exports isGitRepo as a function', () => {
  assert.strictEqual(typeof diffLib.isGitRepo, 'function');
});

test('changedFiles returns full paths when first porcelain entry is unstaged (leading-space X column)', () => {
  // Regression: execSync(...).trim() used to strip the leading space of the
  // porcelain X column (" M src/lib.ts" → "M src/lib.ts"), shifting substring(3)
  // and mangling the path ("src/lib.ts" → "rc/lib.ts") — which broke the
  // auto-commit `git add` in cmdCommit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-diff-'));
  try {
    execSync('git init -q', { cwd: root, stdio: 'pipe' });
    execSync('git config user.name t', { cwd: root, stdio: 'pipe' });
    execSync('git config user.email t@t', { cwd: root, stdio: 'pipe' });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'lib.ts'), 'export const v = 1;\n');
    execSync('git add -A', { cwd: root, stdio: 'pipe' });
    execSync('git commit -qm baseline', { cwd: root, stdio: 'pipe' });
    fs.writeFileSync(path.join(root, 'src', 'lib.ts'), 'export const v = 2;\n');
    const changed = diffLib.changedFiles(root);
    assert.ok(changed.includes('src/lib.ts'), 'expected src/lib.ts in changed, got ' + JSON.stringify(changed));
    assert.ok(!changed.includes('rc/lib.ts'), 'must not mangle the leading-space entry: ' + JSON.stringify(changed));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isSpecsPath excludes specs/ and everything under it (either separator)', () => {
  assert.strictEqual(isSpecsPath('specs'), true);
  assert.strictEqual(isSpecsPath('specs/20260826-120000/state.json'), true);
  assert.strictEqual(isSpecsPath('specs\\20260826-120000\\state.json'), true);
  assert.strictEqual(isSpecsPath('src/core/board.ts'), false);
  assert.strictEqual(isSpecsPath('src/specs/board.ts'), false);
});

test('readSpecTitle reads ### Title from specs/{TS}/spec.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    const ts = '20260826-120000-abcd';
    const tsDir = path.join(root, 'specs', ts);
    fs.mkdirSync(tsDir, { recursive: true });
    fs.writeFileSync(path.join(tsDir, 'spec.md'),
      '## VALIDATED SPEC\n\n### Title\n\nAdd OAuth2 login\n\n### User Story\n\nAs a user...\n');
    assert.strictEqual(readSpecTitle({ ts: ts }, root), 'Add OAuth2 login');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readSpecTitle returns empty when spec.md has no Title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    const ts = '20260826-120000-abcd';
    const tsDir = path.join(root, 'specs', ts);
    fs.mkdirSync(tsDir, { recursive: true });
    fs.writeFileSync(path.join(tsDir, 'spec.md'), '## VALIDATED SPEC\n\n### User Story\n\nAs a user...\n');
    assert.strictEqual(readSpecTitle({ ts: ts }, root), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildFallbackMessage uses title when present, else chore fallback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    const ts = '20260826-120000-abcd';
    const tsDir = path.join(root, 'specs', ts);
    fs.mkdirSync(tsDir, { recursive: true });
    fs.writeFileSync(path.join(tsDir, 'spec.md'), '### Title\n\nAdd OAuth2 login\n');
    assert.strictEqual(buildFallbackMessage({ ts: ts }, root), 'Add OAuth2 login\n');

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
    try {
      assert.strictEqual(buildFallbackMessage({ ts: ts }, emptyRoot), 'chore: spec-forge changes\n');
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performCommit is a no-op when auto_commit is disabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    const ts = '20260826-120000-abcd';
    const state = { ts: ts, auto_commit: false, commit: null };
    const result = performCommit(state, ts, null, root);
    assert.strictEqual(result.committed, false);
    assert.strictEqual(result.skipped, 'auto-commit-not-enabled');
    assert.strictEqual(state.commit, null, 'must not touch state when disabled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performCommit skips not-a-git-repo and records it in state.commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    const ts = '20260826-120000-abcd';
    const state = { ts: ts, auto_commit: true, commit: null };
    const result = performCommit(state, ts, null, root);
    assert.strictEqual(result.committed, false);
    assert.strictEqual(result.skipped, 'not-a-git-repo');
    assert.strictEqual(state.commit.status, 'skipped');
    assert.strictEqual(state.commit.reason, 'not-a-git-repo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performCommit skips already-committed and returns the recorded hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    const ts = '20260826-120000-abcd';
    const state = {
      ts: ts,
      auto_commit: true,
      commit: { status: 'committed', hash: 'abc123', committed_at: new Date().toISOString() }
    };
    const result = performCommit(state, ts, null, root);
    assert.strictEqual(result.committed, false);
    assert.strictEqual(result.skipped, 'already-committed');
    assert.strictEqual(result.hash, 'abc123');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('performCommit commits changed source files (real git path)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-commit-'));
  try {
    execSync('git init -q', { cwd: root, stdio: 'pipe' });
    execSync('git config user.name t', { cwd: root, stdio: 'pipe' });
    execSync('git config user.email t@t', { cwd: root, stdio: 'pipe' });
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
    execSync('git add -A && git commit -qm baseline', { cwd: root, stdio: 'pipe' });

    // changed source file + spec title for the fallback message
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(2);\n');
    const ts = '20260826-120000-abcd';
    const tsDir = path.join(root, 'specs', ts);
    fs.mkdirSync(tsDir, { recursive: true });
    fs.writeFileSync(path.join(tsDir, 'spec.md'), '### Title\n\nAdd OAuth2 login\n');

    const state = { ts: ts, auto_commit: true, commit: null };
    const result = performCommit(state, ts, null, root);

    assert.strictEqual(result.committed, true, 'should commit: ' + JSON.stringify(result));
    assert.ok(result.hash && result.hash.length > 0, 'should record a hash');
    assert.strictEqual(state.commit.status, 'committed');
    assert.ok(state.commit.message.includes('Add OAuth2 login'), 'fallback title in message');
    assert.ok(state.commit.message.includes('Generated-by: spec-forge'), 'trailer in message');

    // specs/ must be excluded from the commit
    const log = execSync('git show --stat --oneline HEAD', { cwd: root, encoding: 'utf8' });
    assert.ok(!log.includes('specs/'), 'specs/ must be excluded: ' + log);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
