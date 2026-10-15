/**
 * Baseline safety regression (Job-DAG Pipeline Model).
 *
 * Loads every real state.json under specs/ and asserts that no
 * stage currently PASSED is downgraded to a non-PASSED status when the
 * The recompute functions run against it. This guards the "do not regress
 * healthy PASSED cases" requirement using actual production data.
 *
 * Scope:
 *   - Global stages:        recomputeGlobalStageStatus(state, stageName)
 *   - Job coding stage:     recomputeJobCodingStatus(state, jobId)
 *                          (coding only — verification runs at project level)
 *
 * Note: stages that are currently NON-passed may legitimately CHANGE (e.g. an
 * evidence-verify that was stuck at IN_PROGRESS may now resolve to PASSED —
 * that is the fix, not a regression). This test only pins the
 * PASSED -> PASSED invariant.
 *
 * Run: node --test hooks/lib/__tests__/state.baseline.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const stateLib = require(path.join(__dirname, '..', 'scripts', 'state.cjs'));
const {
  STAGE_STATUS,
  GLOBAL_STAGES,
  GLOBAL_STAGE_ORDER
} = stateLib;

// ---- Fixture discovery ----------------------------------------------------

/**
 * Real specs directory: <projectRoot>/specs/
 * (matches SPECS_DIR in state.cjs resolved against PROJECT_DIR)
 */
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SPECS_DIR = path.join(PROJECT_ROOT, 'specs');

/**
 * Load every real state.json under specs/{TS}/.
 * Only fixtures with a recognized ts are included.
 *
 * @returns {Array<{ts: string, state: object}>}
 */
function loadSpecStates() {
  const out = [];
  if (!fs.existsSync(SPECS_DIR)) return out;

  let entries;
  try {
    entries = fs.readdirSync(SPECS_DIR, { withFileTypes: true });
  } catch (_) {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    // TS dirs look like 20260706-110133 or 20260706-110133-abcd
    if (!/^\d{8}-\d{6}(?:-[a-z0-9]{4})?$/.test(entry.name)) continue;

    const stateFile = path.join(SPECS_DIR, entry.name, 'state.json');
    if (!fs.existsSync(stateFile)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // Only states with matching ts are kept.
      if (!raw || raw.ts !== entry.name) continue;
      if (!raw.stages) continue;
      // Use load() for a normalized view (ensures lifecycle fields, etc.)
      // — pass the project root so paths resolve identically to production hooks.
      const state = stateLib.load(entry.name, PROJECT_ROOT);
      if (state && state.ts === entry.name) {
        out.push({ ts: entry.name, state });
      }
    } catch (_) {
      // skip unparseable
    }
  }
  return out;
}

// ---- Tests ----------------------------------------------------------------

test('baseline: no currently-PASSED global stage is downgraded by recompute', () => {
  const specs = loadSpecStates();
  if (specs.length === 0) {
    // No real fixtures in this checkout — skip without failing.
    return;
  }

  let checked = 0;
  for (const { ts, state } of specs) {
    if (!state || !state.stages) continue;

    for (const stageName of GLOBAL_STAGE_ORDER) {
      const stage = state.stages[stageName];
      if (!stage || stage.status !== STAGE_STATUS.PASSED) continue;

      checked++;
      const after = stateLib.recomputeGlobalStageStatus(state, stageName);
      assert.strictEqual(
        after,
        STAGE_STATUS.PASSED,
        `spec ${ts} global stage ${stageName}: PASSED must not be downgraded (got ${after})`
      );
    }
  }

  // We don't assert checked > 0 here — a fresh checkout may have no PASSED
  // stages yet. The test's value is in pinning the invariant when fixtures
  // exist, not in requiring fixtures to exist.
});

test('baseline: no currently-PASSED job coding stage is downgraded by recompute', () => {
  const specs = loadSpecStates();
  if (specs.length === 0) {
    return;
  }

  let checked = 0;
  for (const { ts, state } of specs) {
    // Jobs live inside state.stages.implementation.jobs[] (flat full job objects).
    // Use getJobs() for reads. job coding is the only job-level stage.
    const jobsMap = state ? stateLib.getJobs(state) : null;
    if (!jobsMap) continue;

    for (const jobId of Object.keys(jobsMap)) {
      const job = jobsMap[jobId];
      if (!job || !job.coding) continue;

      const cs = job.coding;
      if (!cs || cs.status !== STAGE_STATUS.PASSED) continue;

      checked++;
      const after = stateLib.recomputeJobCodingStatus(state, jobId);
      assert.strictEqual(
        after,
        STAGE_STATUS.PASSED,
        `spec ${ts} job ${jobId} coding stage: PASSED must not be downgraded (got ${after})`
      );
    }
  }
});

test('baseline: the known-bug evidence-verify (110133) recomputes to PASSED', () => {
  const specs = loadSpecStates();
  const buggy = specs.find(s => s.ts === '20260706-110133');
  if (!buggy) {
    // Fixture not present in this checkout — skip without failing.
    return;
  }

  const stageName = GLOBAL_STAGES.EVIDENCE_VERIFY;
  const ev = buggy.state.stages && buggy.state.stages[stageName];
  assert.ok(ev, 'evidence-verify global stage present in state');

  // Precondition: it was stuck non-PASSED with a PASSED marker + a PASSED last run.
  const after = stateLib.recomputeGlobalStageStatus(buggy.state, stageName);
  assert.strictEqual(
    after,
    STAGE_STATUS.PASSED,
    'the stuck retry global stage is now resolved to PASSED'
  );
});

// =====================================================================
// Robustness P1 fix #10 — corrupt state.json backup
// =====================================================================

test('#10 load() backs up corrupt state.json before returning default', () => {
  // A corrupt state.json previously caused a silent reset to defaultState(),
  // losing the entire pipeline progress with no way to investigate. The fix
  // copies the offending file to state.json.corrupt.{ts}.{timestamp} before
  // falling back, so the scene is preserved for post-mortem.
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-backup-'));
  const ts = '20990101-000000';
  const specsTsDir = path.join(root,  'specs', ts);
  fs.mkdirSync(specsTsDir, { recursive: true });

  const stateFile = path.join(specsTsDir, 'state.json');
  const corruptContent = '{ "this is": "not valid JSON", missing-closing-brace';
  fs.writeFileSync(stateFile, corruptContent, 'utf8');

  // load() should return a default state (not throw)...
  const loaded = stateLib.load(ts, root);
  assert.strictEqual(loaded.schema_version, 8, 'returns defaultState on corrupt input');
  assert.strictEqual(loaded.ts, null, 'defaultState has null ts');

  // ...AND a backup file should now exist alongside the original.
  const entries = fs.readdirSync(specsTsDir);
  const backups = entries.filter(function(e) { return e.indexOf('state.json.corrupt.') === 0; });
  assert.strictEqual(backups.length, 1, 'exactly one corrupt backup created: ' + JSON.stringify(backups));

  // The backup preserves the original corrupt content for investigation.
  const backupContent = fs.readFileSync(path.join(specsTsDir, backups[0]), 'utf8');
  assert.strictEqual(backupContent, corruptContent, 'backup preserves original corrupt content');

  fs.rmSync(root, { recursive: true, force: true });
});
