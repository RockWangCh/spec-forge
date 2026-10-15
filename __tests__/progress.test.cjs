/**
 * Progress Bar tests — flow-light rendering + state loading.
 *
 * Run: node --test __tests__/progress.test.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const progress = require(path.join(__dirname, '..', 'scripts', 'progress.cjs'));
const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));

const { renderProgress, loadStateForBar, fmtDuration, stageDurationMs } = progress;
const { defaultState, defaultJob, defaultStage, STAGE_STATUS } = stateLib;

// ---- Fixture helpers ------------------------------------------------------

/** A fresh verification round (mirrors state.cjs's un-exported newVerificationRound). */
function freshRound() {
  return {
    testing: defaultStage(),
    review: defaultStage(),
    regression: defaultStage(),
    fix: defaultStage()
  };
}

// ---- Fixture helpers ------------------------------------------------------

/** Fresh default state with the leading three leaf stages marked PASSED. */
function passedPrefixState() {
  const state = defaultState();
  state.stages['spec-check'].status = STAGE_STATUS.PASSED;
  state.stages['task-decompose'].status = STAGE_STATUS.PASSED;
  state.stages['baseline-regression'].status = STAGE_STATUS.PASSED;
  return state;
}

/** Build a state where implementation is IN_PROGRESS with the given coding statuses. */
function implState(codingStatuses) {
  const state = passedPrefixState();
  const impl = state.stages.implementation;
  impl.jobs = codingStatuses.map(function (cs, i) {
    const job = defaultJob({ id: 'J' + i + '-0' });
    job.coding.status = cs;
    return job;
  });
  impl.status = STAGE_STATUS.IN_PROGRESS;
  return state;
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-progress-'));
}

// ---- Session-scoped marker fixtures ----------------------------------------

// 固定测试 session id —— 测试进程可能本身带有 CLAUDE_CODE_SESSION_ID（在 Claude Code
// 会话里跑 node --test），必须显式控制才能让断言确定。
const SID = '2c41db36-d855-45f4-af61-c0085149388f';

/** 临时设置/清除 CLAUDE_CODE_SESSION_ID，测试后恢复。sid=null 表示清除（非 Claude 环境）。 */
function withSessionId(sid, fn) {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  if (sid === null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = sid;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
}

/** 在项目 specs/session-active/<sid> 写入本 session 的活跃 TS 标记。 */
function writeSessionMarker(root, ts, sid) {
  const file = path.join(root, 'specs', 'session-active', sid || SID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ts, 'utf8');
}

// ---- Tests: main row -------------------------------------------------------

test('fresh pipeline: all PENDING, no detail, no [fail]', () => {
  const state = defaultState();
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ·spec-check → ·task-decompose → ·baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('spec-check PASSED, task-decompose IN_PROGRESS (leaf: no detail row)', () => {
  const state = passedPrefixState();
  state.stages['task-decompose'].status = STAGE_STATUS.IN_PROGRESS;
  state.stages['spec-check'].status = STAGE_STATUS.PASSED;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ▸task-decompose → ✓baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('FAILED stage → ✗ light + [fail] suffix', () => {
  const state = passedPrefixState();
  state.stages['baseline-regression'].status = STAGE_STATUS.FAILED;
  state.stages['task-decompose'].status = STAGE_STATUS.PASSED;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✗baseline-regression → ·implementation → ·verification → ·evidence-verify [fail]'
  );
});

test('BLOCKED stage → ⚠ light + [fail] suffix', () => {
  const state = passedPrefixState();
  state.stages['task-decompose'].status = STAGE_STATUS.BLOCKED;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ⚠task-decompose → ✓baseline-regression → ·implementation → ·verification → ·evidence-verify [fail]'
  );
});

test('WARN stage → ✓ (soft pass), no [fail]', () => {
  const state = passedPrefixState();
  state.stages['spec-check'].status = STAGE_STATUS.WARN;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('SKIPPED stage → ⊘', () => {
  const state = passedPrefixState();
  state.stages['task-decompose'].status = STAGE_STATUS.SKIPPED;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ⊘task-decompose → ✓baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('unknown status → neutral · (defensive)', () => {
  const state = defaultState();
  state.stages['spec-check'].status = 'BOGUS';
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ·spec-check → ·task-decompose → ·baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('all PASSED (pipeline done): all-green strip, no [fail]; verification row persists', () => {
  const state = defaultState();
  for (const name of Object.keys(state.stages)) {
    state.stages[name].status = STAGE_STATUS.PASSED;
  }
  // verification PASSED is driven by its regression sub-stage (recomputeVerificationStatus)
  state.stages.verification.rounds[0].regression.status = STAGE_STATUS.PASSED;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ✓implementation → ✓verification → ✓evidence-verify\nverification r1: ·testing → ·review → ✓regression → ·fix'
  );
});

// ---- Tests: implementation detail row -------------------------------------

test('implementation IN_PROGRESS: job lights in DAG order', () => {
  const state = implState([STAGE_STATUS.PASSED, STAGE_STATUS.IN_PROGRESS, STAGE_STATUS.PENDING]);
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ▸implementation → ·verification → ·evidence-verify\njobs: ✓J0-0 ▸J1-0 ·J2-0'
  );
});

test('implementation with WARN / FAILED / SKIPPED jobs', () => {
  const state = implState([STAGE_STATUS.WARN, STAGE_STATUS.FAILED, STAGE_STATUS.SKIPPED]);
  // a failed job aggregates implementation → FAILED (recomputeImplementationStatus)
  state.stages.implementation.status = STAGE_STATUS.FAILED;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ✗implementation → ·verification → ·evidence-verify [fail]\njobs: ✓J0-0 ✗J1-0 ⊘J2-0'
  );
});

test('many jobs wrap to 2 lines then truncate the last line with " …"', () => {
  // detailWidth=60，'jobs: ' 前缀 6 → 每行预算 54。token 约 5-6 字符，一行放 ~9 个、
  // 2 行放 ~17 个 —— 22 个 job 必触发第 3 行 → 末行 ' …' 截断。
  const statuses = new Array(22).fill(STAGE_STATUS.PENDING);
  statuses[0] = STAGE_STATUS.PASSED;
  statuses[1] = STAGE_STATUS.IN_PROGRESS;
  const state = implState(statuses);
  const out = renderProgress(state, { color: false, maxDetailLen: 60 });
  const detailLines = out.split('\n').slice(1);
  assert.strictEqual(detailLines.length, 2, 'jobs detail wraps to exactly 2 lines');
  assert.ok(detailLines[0].indexOf('jobs: ') === 0, 'first detail line carries the prefix');
  assert.ok(detailLines[1].endsWith(' …'), 'truncated last line ends with " …"');
  for (const line of detailLines) {
    assert.ok(line.length <= 60, 'each detail line within budget: ' + JSON.stringify(line));
  }
});

test('implementation with zero jobs: no detail row', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.IN_PROGRESS;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ▸implementation → ·verification → ·evidence-verify'
  );
});

// ---- Tests: verification detail row ---------------------------------------

test('verification round 1 testing IN_PROGRESS', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  ver.rounds[0].testing.status = STAGE_STATUS.IN_PROGRESS;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ✓implementation → ▸verification → ·evidence-verify\nverification r1: ▸testing → ·review → ·regression → ·fix'
  );
});

test('verification round 2 after a fix loop-back', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  // round 1: review FAILED → fix PASSED → loop back
  ver.rounds[0].testing.status = STAGE_STATUS.PASSED;
  ver.rounds[0].review.status = STAGE_STATUS.FAILED;
  ver.rounds[0].regression.status = STAGE_STATUS.SKIPPED;
  ver.rounds[0].fix.status = STAGE_STATUS.PASSED;
  // round 2: testing passed, review in progress
  ver.rounds.push(freshRound());
  ver.rounds[1].testing.status = STAGE_STATUS.PASSED;
  ver.rounds[1].review.status = STAGE_STATUS.IN_PROGRESS;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ✓implementation → ▸verification → ·evidence-verify\nverification r2: ✓testing → ▸review → ·regression → ·fix'
  );
});

test('verification regression WARN → ✓ (soft pass); verification row persists past evidence-verify', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.WARN;
  ver.rounds[0].testing.status = STAGE_STATUS.PASSED;
  ver.rounds[0].review.status = STAGE_STATUS.PASSED;
  ver.rounds[0].regression.status = STAGE_STATUS.WARN;
  state.stages['evidence-verify'].status = STAGE_STATUS.IN_PROGRESS;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ✓implementation → ✓verification → ▸evidence-verify\nverification r1: ✓testing → ✓review → ✓regression → ·fix'
  );
});

test('verification with malformed rounds (missing) still renders round 1 pending', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  delete ver.rounds;
  assert.strictEqual(
    renderProgress(state, { color: false }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ✓implementation → ▸verification → ·evidence-verify\nverification r1: ·testing → ·review → ·regression → ·fix'
  );
});

// ---- Tests: detail-row persistence + durations -----------------------------

test('jobs and verification detail rows persist together after implementation finishes', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  state.stages.implementation.jobs = [defaultJob({ id: 'J0-1' }), defaultJob({ id: 'J1-2' })];
  state.stages.implementation.jobs[0].coding.status = STAGE_STATUS.PASSED;
  state.stages.implementation.jobs[1].coding.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  ver.rounds[0].testing.status = STAGE_STATUS.IN_PROGRESS;

  const lines = renderProgress(state, { color: false }).split('\n');
  assert.ok(lines.some(function (l) { return l.indexOf('jobs:') === 0; }), 'jobs row persists');
  assert.ok(lines.some(function (l) { return l.indexOf('verification r1:') === 0; }), 'verification row persists');
  // both rows must be present, in order (jobs before verification)
  const jobIdx = lines.findIndex(function (l) { return l.indexOf('jobs:') === 0; });
  const verIdx = lines.findIndex(function (l) { return l.indexOf('verification r1:') === 0; });
  assert.ok(jobIdx !== -1 && verIdx !== -1 && jobIdx < verIdx, 'jobs before verification');
});

test('job coding duration appears in the jobs detail row', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const job = defaultJob({ id: 'J0-1' });
  job.coding.status = STAGE_STATUS.PASSED;
  job.coding.started_at = '2026-08-24T00:00:00.000Z';
  job.coding.completed_at = '2026-08-24T00:03:12.000Z';
  state.stages.implementation.jobs = [job];

  const out = renderProgress(state, { color: false, now: Date.parse('2026-08-24T00:06:30.000Z') });
  const jobLine = out.split('\n').find(function (l) { return l.indexOf('jobs:') === 0; });
  assert.ok(jobLine.indexOf('✓J0-1 3m12s') !== -1, 'job duration shown');
});

test('verification sub-stage durations appear in the verification detail row', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  ver.rounds[0].testing.status = STAGE_STATUS.PASSED;
  ver.rounds[0].testing.started_at = '2026-08-24T00:00:00.000Z';
  ver.rounds[0].testing.completed_at = '2026-08-24T00:01:04.000Z';
  ver.rounds[0].review.status = STAGE_STATUS.IN_PROGRESS;
  ver.rounds[0].review.started_at = '2026-08-24T00:01:10.000Z';

  const out = renderProgress(state, { color: false, now: Date.parse('2026-08-24T00:06:30.000Z') });
  const verLine = out.split('\n').find(function (l) { return l.indexOf('verification r1:') === 0; });
  assert.ok(verLine.indexOf('✓testing 1m04s') !== -1, 'testing terminal duration shown');
  assert.ok(verLine.indexOf('▸review 5m20s') !== -1, 'review live elapsed shown');
});

test('detail rows persist: jobs row survives after implementation FAILED (terminal)', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.FAILED;
  state.stages.implementation.jobs = [defaultJob({ id: 'J0-1' })];
  state.stages.implementation.jobs[0].coding.status = STAGE_STATUS.FAILED;
  const out = renderProgress(state, { color: false });
  const lines = out.split('\n');
  assert.ok(lines.some(function (l) { return l.indexOf('jobs:') === 0; }), 'jobs row persists after implementation FAILED');
  assert.ok(out.indexOf('[fail]') !== -1, '[fail] present');
});

// ---- Tests: ANSI color -----------------------------------------------------

test('color=true wraps green PASSED in ANSI green', () => {
  const state = passedPrefixState();
  state.stages['task-decompose'].status = STAGE_STATUS.IN_PROGRESS;
  const out = renderProgress(state, { color: true });
  assert.ok(out.indexOf('\x1b[32m✓spec-check\x1b[0m') !== -1, 'PASSED stage is green');
  assert.ok(out.indexOf('\x1b[36m▸task-decompose\x1b[0m') !== -1, 'IN_PROGRESS stage is cyan');
});

test('color=false emits no ANSI codes', () => {
  const state = passedPrefixState();
  state.stages['task-decompose'].status = STAGE_STATUS.IN_PROGRESS;
  const out = renderProgress(state, { color: false });
  assert.ok(out.indexOf('\x1b[') === -1, 'no escape sequences when color disabled');
});

// ---- Tests: stage durations -------------------------------------------------

test('fmtDuration: compact formats', () => {
  assert.strictEqual(fmtDuration(45000), '45s');
  assert.strictEqual(fmtDuration(64000), '1m04s');
  assert.strictEqual(fmtDuration(192000), '3m12s');
  assert.strictEqual(fmtDuration(1920000), '32m');
  assert.strictEqual(fmtDuration(-1), null);
  assert.strictEqual(fmtDuration('x'), null);
});

test('stageDurationMs: terminal = completed_at − started_at; active = now − started_at', () => {
  const stage = { status: 'PASSED', started_at: '2026-08-24T00:00:00.000Z', completed_at: '2026-08-24T00:03:12.000Z' };
  assert.strictEqual(stageDurationMs(stage, 0), 192000);
  const active = { status: 'IN_PROGRESS', started_at: '2026-08-24T00:01:00.000Z' };
  assert.strictEqual(stageDurationMs(active, Date.parse('2026-08-24T00:06:30.000Z')), 330000);
  // no started_at / inverted timestamps → null
  assert.strictEqual(stageDurationMs({ status: 'PASSED', completed_at: '2026-08-24T00:03:12.000Z' }, 0), null);
  assert.strictEqual(stageDurationMs(null, 0), null);
});

test('stage durations appended inline on the main row', () => {
  const state = passedPrefixState();
  state.stages['spec-check'].started_at = '2026-08-24T00:00:00.000Z';
  state.stages['spec-check'].completed_at = '2026-08-24T00:03:12.000Z';
  state.stages['task-decompose'].status = STAGE_STATUS.IN_PROGRESS;
  state.stages['task-decompose'].started_at = '2026-08-24T00:01:00.000Z';
  const now = Date.parse('2026-08-24T00:06:30.000Z');
  assert.strictEqual(
    renderProgress(state, { color: false, now }),
    'sf ✓spec-check 3m12s → ▸task-decompose 5m30s → ✓baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('stage without started_at (legacy/pending) shows no duration', () => {
  const state = passedPrefixState();
  // terminal but only completed_at present — like legacy derived recompute
  state.stages['spec-check'].completed_at = '2026-08-24T00:03:12.000Z';
  assert.strictEqual(
    renderProgress(state, { color: false, now: Date.parse('2026-08-24T00:06:30.000Z') }),
    'sf ✓spec-check → ✓task-decompose → ✓baseline-regression → ·implementation → ·verification → ·evidence-verify'
  );
});

test('duration renders gray in color mode', () => {
  const state = passedPrefixState();
  state.stages['spec-check'].started_at = '2026-08-24T00:00:00.000Z';
  state.stages['spec-check'].completed_at = '2026-08-24T00:03:12.000Z';
  const out = renderProgress(state, { color: true, now: Date.parse('2026-08-24T00:06:30.000Z') });
  assert.ok(out.indexOf('\x1b[90m 3m12s\x1b[0m') !== -1, 'duration is gray');
});

// ---- Tests: state loading (session-scoped marker) --------------------------

test('idle: no session marker → { status: idle }', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    assert.deepStrictEqual(loadStateForBar(root), { status: 'idle' });
  });
});

test('idle: no CLAUDE_CODE_SESSION_ID (non-Claude env) → { status: idle } (fail-closed)', () => {
  withSessionId(null, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    writeSessionMarker(root, ts);
    // 即使磁盘上有标记，没有 session id 也视作未启用
    assert.deepStrictEqual(loadStateForBar(root), { status: 'idle' });
  });
});

test('idle: another session marker exists but not mine → { status: idle } (no cross-session leak)', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    writeSessionMarker(root, ts, 'another-session-uuid');
    assert.deepStrictEqual(loadStateForBar(root), { status: 'idle' });
  });
});

test('error: session marker present with a valid TS but state.json missing → { status: error }', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    writeSessionMarker(root, '20260818-165553-2i5b');
    assert.deepStrictEqual(loadStateForBar(root), { status: 'error' });
  });
});

test('ok: reads the state pointed to by this session marker', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    fs.mkdirSync(path.join(root, 'specs', ts), { recursive: true });
    writeSessionMarker(root, ts);
    const state = defaultState();
    state.ts = ts;
    fs.writeFileSync(path.join(root, 'specs', ts, 'state.json'), JSON.stringify(state), 'utf8');

    const res = loadStateForBar(root);
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.state.ts, ts);
  });
});

test('error: corrupt state.json → { status: error } (never throws)', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    fs.mkdirSync(path.join(root, 'specs', ts), { recursive: true });
    writeSessionMarker(root, ts);
    fs.writeFileSync(path.join(root, 'specs', ts, 'state.json'), '{not json', 'utf8');
    assert.deepStrictEqual(loadStateForBar(root), { status: 'error' });
  });
});

// ---- Tests: auto-follow (upward search for the session marker) -------------

test('searchUp: finds an ancestor session marker from a subdir', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    fs.mkdirSync(path.join(root, 'specs', ts), { recursive: true });
    writeSessionMarker(root, ts);
    const state = defaultState();
    state.ts = ts;
    fs.writeFileSync(path.join(root, 'specs', ts, 'state.json'), JSON.stringify(state), 'utf8');

    const subdir = path.join(root, 'src', 'nested');
    fs.mkdirSync(subdir, { recursive: true });
    const res = loadStateForBar(subdir, { searchUp: true });
    assert.strictEqual(res.status, 'ok');
    assert.strictEqual(res.state.ts, ts);
  });
});

test('explicit project-root does NOT walk up: missing session marker → idle', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    fs.mkdirSync(path.join(root, 'specs', ts), { recursive: true });
    writeSessionMarker(root, ts);
    // subdir has no session marker; passing it explicitly stays there (no walk up)
    const subdir = path.join(root, 'src');
    fs.mkdirSync(subdir, { recursive: true });
    assert.deepStrictEqual(loadStateForBar(subdir), { status: 'idle' });
  });
});

test('CLI launched in a subdir (no --project-root) auto-resolves the ancestor session pipeline', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    fs.mkdirSync(path.join(root, 'specs', ts), { recursive: true });
    writeSessionMarker(root, ts);
    const state = defaultState();
    state.ts = ts;
    fs.writeFileSync(path.join(root, 'specs', ts, 'state.json'), JSON.stringify(state), 'utf8');
    const subdir = path.join(root, 'src', 'deep');
    fs.mkdirSync(subdir, { recursive: true });

    const res = require('child_process').spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'progress.cjs'), '--no-color'],
      {
        cwd: subdir,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { PROJECT_DIR: '', COLUMNS: '200', CLAUDE_CODE_SESSION_ID: SID })
      }
    );
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), 'sf ·spec-check → ·task-decompose → ·baseline-regression → ·implementation → ·verification → ·evidence-verify');
  });
});

// ---- Tests: terminal-width wrapping ----------------------------------------

test('narrow width wraps the strip token-aware (whole tokens, each line ≤ width)', () => {
  const state = defaultState();
  const out = renderProgress(state, { color: false, width: 40 });
  const lines = out.split('\n');
  assert.ok(lines.length >= 3, 'strip wraps to multiple lines');
  for (const line of lines) {
    assert.ok(line.length <= 40, 'each wrapped line within width: ' + line);
  }
  // token-aware: the first line ends at a whole token boundary, no mid-token break
  assert.strictEqual(lines[0], 'sf ·spec-check → ·task-decompose');
  const joined = lines.join('');
  for (const name of ['spec-check', 'task-decompose', 'baseline-regression', 'implementation', 'verification', 'evidence-verify']) {
    assert.ok(joined.indexOf(name) !== -1, 'every stage name present: ' + name);
  }
});

test('wide width ≥ strip length keeps a single line', () => {
  const state = defaultState();
  const out = renderProgress(state, { color: false, width: 200 });
  assert.strictEqual(out.split('\n').length, 1);
});

test('wrapped strip keeps [fail] on the last line', () => {
  const state = defaultState();
  state.stages['spec-check'].status = STAGE_STATUS.FAILED;
  const out = renderProgress(state, { color: false, width: 40 });
  const lines = out.split('\n');
  assert.ok(lines[lines.length - 1].endsWith('[fail]'), '[fail] on last wrapped line');
});

test('detail rows follow width when it is narrower than maxDetailLen', () => {
  const state = implState([STAGE_STATUS.PASSED, STAGE_STATUS.IN_PROGRESS]);
  const out = renderProgress(state, { color: false, width: 30 });
  const detail = out.split('\n').find(function (l) { return l.indexOf('jobs:') === 0; });
  assert.ok(detail && detail.length <= 30, 'detail row within width');
});

test('main-row continuation lines indent 3 (aligned under content)', () => {
  const state = defaultState();
  const out = renderProgress(state, { color: false, width: 40 });
  const lines = out.split('\n');
  assert.ok(lines.length >= 3, 'strip wraps to multiple lines');
  assert.ok(lines[0].indexOf('sf ') === 0, 'first line has sf prefix');
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].indexOf('   ') === 0, 'continuation indented 3: ' + JSON.stringify(lines[i]));
    assert.ok(lines[i].length <= 40, 'each line within width: ' + JSON.stringify(lines[i]));
  }
});

test('invariant: every rendered line ≤ width (main + jobs + verification, no fail)', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.IN_PROGRESS;
  state.stages.implementation.jobs = [];
  for (let i = 0; i < 20; i++) {
    state.stages.implementation.jobs.push(defaultJob({ id: 'J' + i + '-0' }));
  }
  state.stages.implementation.jobs[0].coding.status = STAGE_STATUS.PASSED;
  state.stages.implementation.jobs[1].coding.status = STAGE_STATUS.IN_PROGRESS;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  ver.rounds[0].testing.status = STAGE_STATUS.IN_PROGRESS;

  const out = renderProgress(state, { color: false, width: 44 });
  const lines = out.split('\n');
  assert.ok(lines.length >= 4, 'main wraps + both detail rows present');
  for (const line of lines) {
    assert.ok(line.length <= 44, 'every line ≤ width: ' + JSON.stringify(line));
  }
});

test('verification detail wraps to 2 lines, continuation aligned under content', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.PASSED;
  const ver = state.stages.verification;
  ver.status = STAGE_STATUS.IN_PROGRESS;
  ver.rounds[0].testing.status = STAGE_STATUS.IN_PROGRESS;

  const out = renderProgress(state, { color: false, width: 40 });
  const lines = out.split('\n');
  // 续行以 17 个空格开头、不含 'verification r1:' 文本 —— 从首行前缀切到末尾（verification 是最后一行）。
  const start = lines.findIndex(function (l) { return l.indexOf('verification r1: ') === 0; });
  const verLines = lines.slice(start);
  assert.strictEqual(verLines.length, 2, 'verification wraps to 2 lines');
  assert.strictEqual(verLines[0], 'verification r1: ▸testing → ·review');
  const lead = verLines[1].match(/^ */)[0].length;
  assert.strictEqual(lead, 'verification r1: '.length, 'continuation indented to content column');
  assert.strictEqual(verLines[1], ' '.repeat('verification r1: '.length) + '·regression → ·fix');
  assert.ok(verLines[1].length <= 40, 'continuation within width');
});

test('single over-wide token keeps its line whole (overflow is the documented exception)', () => {
  const state = passedPrefixState();
  state.stages.implementation.status = STAGE_STATUS.IN_PROGRESS;
  const job = defaultJob({ id: 'J10-42' });
  job.coding.status = STAGE_STATUS.PASSED;
  job.coding.started_at = '2026-08-24T00:00:00.000Z';
  job.coding.completed_at = '2026-08-24T00:12:05.000Z';
  state.stages.implementation.jobs = [job];

  const out = renderProgress(state, { color: false, width: 16 });
  const jobLine = out.split('\n').find(function (l) { return l.indexOf('jobs:') === 0; });
  assert.strictEqual(jobLine, 'jobs: ✓J10-42 12m05s');
  assert.ok(jobLine.indexOf(' …') === -1, 'no truncation marker for a single token');
  assert.ok(jobLine.length > 16, 'single over-wide token overflows its line');
});

test('maxDetailLen narrower than width wraps the detail row at the narrower width', () => {
  const state = implState([
    STAGE_STATUS.PASSED, STAGE_STATUS.PASSED, STAGE_STATUS.IN_PROGRESS,
    STAGE_STATUS.PENDING, STAGE_STATUS.PENDING, STAGE_STATUS.PENDING,
    STAGE_STATUS.PENDING, STAGE_STATUS.PENDING
  ]);
  const out = renderProgress(state, { color: false, width: 100, maxDetailLen: 40 });
  const detail = out.split('\n').find(function (l) { return l.indexOf('jobs:') === 0; });
  assert.ok(detail && detail.length <= 40, 'detail row wraps within the narrower maxDetailLen');
  assert.ok(detail.length <= 40, 'detail line within maxDetailLen: ' + JSON.stringify(detail));
});

// ---- Tests: CLI safety (never non-zero; not-enabled → silent) --------------

test('CLI exits 0 with no output when this session is not enabled (fail-closed)', () => {
  const root = tmpProject();
  const res = require('child_process').spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'progress.cjs'), '--project-root=' + root, '--no-color'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_CODE_SESSION_ID: SID }) }
  );
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '');
});

test('CLI exits 0 and renders the session pipeline when this session is enabled', () => {
  const root = tmpProject();
  const ts = '20260818-165553-2i5b';
  fs.mkdirSync(path.join(root, 'specs', ts), { recursive: true });
  writeSessionMarker(root, ts);
  const state = defaultState();
  state.ts = ts;
  fs.writeFileSync(path.join(root, 'specs', ts, 'state.json'), JSON.stringify(state), 'utf8');

  const res = require('child_process').spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'progress.cjs'), '--project-root=' + root, '--no-color'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_CODE_SESSION_ID: SID, COLUMNS: '200' }) }
  );
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'sf ·spec-check → ·task-decompose → ·baseline-regression → ·implementation → ·verification → ·evidence-verify');
});
