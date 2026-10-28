/**
 * Pipeline Configuration Library (Job-DAG Pipeline Model)
 *
 * Single source of truth for pipeline configuration. All configuration is
 * defined inline — no external config file is read at runtime.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants — Global Stages (pipeline-level)
// ---------------------------------------------------------------------------

const GLOBAL_STAGES = Object.freeze({
  SPEC_CHECK: 'spec-check',
  TASK_DECOMPOSE: 'task-decompose',
  BASELINE_REGRESSION: 'baseline-regression',
  IMPLEMENTATION: 'implementation',
  VERIFICATION: 'verification',
  EVIDENCE_VERIFY: 'evidence-verify'
});

const GLOBAL_STAGE_ORDER = Object.freeze([
  GLOBAL_STAGES.SPEC_CHECK,
  GLOBAL_STAGES.TASK_DECOMPOSE,
  GLOBAL_STAGES.BASELINE_REGRESSION,
  GLOBAL_STAGES.IMPLEMENTATION,
  GLOBAL_STAGES.VERIFICATION,
  GLOBAL_STAGES.EVIDENCE_VERIFY
]);

// stage → agent (dispatch-time forward mapping). `regression-runner` serves
// BOTH baseline-regression (a global leaf) and verification.regression (a
// sub-stage); the description's `GLOBAL=<stage>` / `GLOBAL=verification
// STAGE=regression` tags disambiguate. The `verification` composite stage is
// intentionally absent — like `implementation`, it does not dispatch an agent
// directly (its sub-stages do).
const GLOBAL_TO_AGENT = Object.freeze({
  'spec-check': 'spec-checker',
  'task-decompose': 'task-decomposer',
  'baseline-regression': 'regression-runner',
  'evidence-verify': 'evidence-verifier'
});

// agent → global stage fallback (used by `cli.cjs update` when a description
// carries no resolvable scope). `regression-runner` is intentionally absent —
// it is ambiguous between baseline-regression and regression, so it cannot be
// inferred from the agent alone.
const AGENT_TO_GLOBAL_STAGE = Object.freeze({
  'spec-checker': GLOBAL_STAGES.SPEC_CHECK,
  'task-decomposer': GLOBAL_STAGES.TASK_DECOMPOSE,
  'evidence-verifier': GLOBAL_STAGES.EVIDENCE_VERIFY
});

// ---------------------------------------------------------------------------
// Constants — Verification-loop Sub-stages
// ---------------------------------------------------------------------------
// The `verification` composite stage runs a project-level loop after ALL jobs'
// coding PASSED:
//   testing:    test-generator writes & runs unit tests for the whole change
//               set (one test-suite run covers every job; also verifies the
//               change set compiles). Catches cross-job integration issues.
//   review:     code-reviewer inspects all code + tests in one pass.
//   regression: regression-runner runs the full project build + test suite.
//   fix:        fixer addresses failures from testing / review / regression;
//               on success the loop re-runs testing → review → regression.
const VERIFICATION_STAGES = Object.freeze({
  TESTING: 'testing',
  REVIEW: 'review',
  REGRESSION: 'regression',
  FIX: 'fix'
});

const VERIFICATION_STAGE_ORDER = Object.freeze([
  VERIFICATION_STAGES.TESTING,
  VERIFICATION_STAGES.REVIEW,
  VERIFICATION_STAGES.REGRESSION,
  VERIFICATION_STAGES.FIX
]);

// Verification sub-stage → agent
const VERIFICATION_TO_AGENT = Object.freeze({
  'testing': 'test-generator',
  'review': 'code-reviewer',
  'regression': 'regression-runner',
  'fix': 'fixer'
});

// ---------------------------------------------------------------------------
// Status enums (single source of truth — shared by state.cjs + stage-entry.cjs)
// ---------------------------------------------------------------------------

const STAGE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  PASSED: 'PASSED',
  WARN: 'WARN',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  SKIPPED: 'SKIPPED'
});

const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  PASSED: 'PASSED',
  WARN: 'WARN',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED'
});

// Stale-detection window: an IN_PROGRESS run/stage older than this is treated
// as stale (marked FAILED or retried). Single source — do NOT duplicate this
// literal in recompute paths.
const DEFAULT_STALE_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Stage Requirements
// ---------------------------------------------------------------------------

const GLOBAL_STAGE_REQUIREMENTS = Object.freeze({
  'spec-check': { upstream_stages: [] },
  'task-decompose': { upstream_stages: ['spec-check'] },
  'baseline-regression': { upstream_stages: ['task-decompose'] },
  'implementation': { upstream_stages: ['baseline-regression'] },
  'verification': { upstream_stages: ['implementation'] },
  'evidence-verify': { upstream_stages: ['verification'] }
});

// ---------------------------------------------------------------------------
// Retry Policy
// ---------------------------------------------------------------------------
// max_retries = retries allowed AFTER the first attempt; total attempts = max_retries + 1.
// Defaults (max_retries = 2) allow up to 3 total attempts. Jobs hardcode max_retries in state.cjs defaultJob (not configurable here).
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_POLICY = Object.freeze({
  global_max_retries: 2
});

// ---------------------------------------------------------------------------
// Parallelism Policy
// ---------------------------------------------------------------------------
// max_concurrent_coding_jobs caps the number of coding jobs in flight at once
// (status IN_PROGRESS). Unlike the pre-1cbad5a "batch size" cap (slice), this
// bounds TRUE concurrency: the scheduler dispatches at most (cap - inFlight)
// new jobs per call and returns `wait` once the cap is reached. 0 = unlimited.
// Env override: SPEC_FORGE_MAX_CONCURRENCY (see parseMaxConcurrency).
// ---------------------------------------------------------------------------

const DEFAULT_PARALLELISM_POLICY = Object.freeze({
  max_concurrent_coding_jobs: 5
});

/**
 * Resolve a max-concurrency value from a raw input (env var or config field).
 *
 *   N >= 1              -> floor(N)      (1 is naturally serial)
 *   0                   -> Infinity      (unlimited — restore pre-cap behavior)
 *   negative / NaN / empty -> fallback  (default 5)
 *
 * @param {*} raw - Raw value (string from env, number, or undefined)
 * @param {number} fallback - Default when raw is absent/invalid
 * @returns {number} Resolved cap (>= 1, or Infinity for unlimited)
 */
function parseMaxConcurrency(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  var n = typeof raw === 'number' ? raw : Number(raw);
  if (!isFinite(n)) return fallback;
  if (n === 0) return Infinity;
  if (n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Read the effective coding-job concurrency cap from a config object.
 * Falls back to the default when the config lacks a parallelism policy (e.g.
 * bare test fixtures that only carry retry_policy).
 *
 * @param {object} config - Harness config (from loadConfig or a test fixture)
 * @returns {number} Cap (>= 1, or Infinity for unlimited)
 */
function getMaxConcurrency(config) {
  var fallback = DEFAULT_PARALLELISM_POLICY.max_concurrent_coding_jobs;
  if (!config || !config.parallelism) return fallback;
  return parseMaxConcurrency(config.parallelism.max_concurrent_coding_jobs, fallback);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function loadConfig(_projectRoot) {
  return {
    pipeline_model: 'job-dag-pipeline',
    stages: {
      order: GLOBAL_STAGE_ORDER.slice(),
      requirements: JSON.parse(JSON.stringify(GLOBAL_STAGE_REQUIREMENTS))
    },
    // Verification-loop sub-stages: testing → review → regression (+ fix).
    verification_stages: {
      order: VERIFICATION_STAGE_ORDER.slice(),
      to_agent: Object.assign({}, VERIFICATION_TO_AGENT)
    },
    retry_policy: Object.assign({}, DEFAULT_RETRY_POLICY),
    parallelism: Object.assign({}, DEFAULT_PARALLELISM_POLICY),
    history: { max_sessions: 20 }
  };
}

function getStageRequirements(config, stageName) {
  if (
    config &&
    config.stages &&
    config.stages.requirements &&
    config.stages.requirements[stageName]
  ) {
    return config.stages.requirements[stageName];
  }
  if (GLOBAL_STAGE_REQUIREMENTS[stageName]) {
    return JSON.parse(JSON.stringify(GLOBAL_STAGE_REQUIREMENTS[stageName]));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cross-platform shell helpers
// ---------------------------------------------------------------------------
// Agents generating shell commands for test/build runs historically reached
// for Unix-only utilities like `head`/`tail`/`sed`, which break on Windows.
// These helpers let agents and hooks produce platform-appropriate commands.

/**
 * Detect whether the current process runs on Windows.
 * @returns {boolean}
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * Return a short note for agent prompt hints warning about cross-platform
 * command compatibility. Appended to testing/evidence-verify prompts.
 *
 * @returns {string}
 */
function getPlatformShellNote() {
  if (isWindows()) {
    return ' Platform: Windows. Do NOT use `head`/`tail`/`sed`/`grep`/`find` in shell commands — use PowerShell equivalents (e.g. `Select-Object -First N` instead of `head -n N`). Prefer `npx vitest run` directly without pipe truncation.';
  }
  return ' Platform: Unix. Standard shell utilities (`head`, `tail`, `grep`) are available.';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  GLOBAL_STAGES,
  GLOBAL_STAGE_ORDER,
  GLOBAL_TO_AGENT,
  AGENT_TO_GLOBAL_STAGE,
  VERIFICATION_STAGES,
  VERIFICATION_STAGE_ORDER,
  VERIFICATION_TO_AGENT,
  STAGE_STATUS,
  JOB_STATUS,
  DEFAULT_STALE_MS,
  GLOBAL_STAGE_REQUIREMENTS,
  DEFAULT_RETRY_POLICY,
  DEFAULT_PARALLELISM_POLICY,

  loadConfig,
  getStageRequirements,
  parseMaxConcurrency,
  getMaxConcurrency,

  isWindows,
  getPlatformShellNote
};
