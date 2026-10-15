/**
 * spec-forge — State Management Library
 *
 * Unified state management with atomic writes. State is stored at
 * specs/{TS}/state.json.
 *
 * State model (job-dag-pipeline):
 *   - Global stages: spec-check → task-decompose → baseline-regression →
 *     implementation (holds flat jobs) → verification (holds loop) →
 *     evidence-verify
 *   - Jobs live inside implementation.jobs[] (flat, full job objects)
 *   - Each job performs ONLY `coding` (parallel, driven by depends_on)
 *   - The `verification` composite stage runs one project-level loop over the
 *     whole change set: testing → review → regression → (fix → testing)
 *   - A job is PASSED iff its coding PASSED (or WARN/SKIPPED)
 *   - Completion: all global stages PASSED (implementation.status covers jobs,
 *     verification.status covers the loop)
 */

const configLib = require('./config.cjs');
const {
  GLOBAL_STAGES,
  GLOBAL_STAGE_ORDER,
  VERIFICATION_STAGES,
  VERIFICATION_STAGE_ORDER,
  STAGE_STATUS,
  JOB_STATUS
} = configLib;
const stageEntry = require('./stage-entry.cjs');
const storeLib = require('./store.cjs');
const {
  save,
  resolveSpecsDir,
  resolveTSDir,
  resolveStateFile,
  ensureTsLifecycle,
  markTsCompleted
} = storeLib;

// Stage enums (GLOBAL_STAGES / GLOBAL_STAGE_ORDER / VERIFICATION_STAGES /
// VERIFICATION_STAGE_ORDER / STAGE_STATUS / JOB_STATUS) are defined in
// config.cjs (single source of truth) and imported above; re-exported below
// for backward compatibility.

// ---- Default state factories ----

/**
 * Create a default stage-like entry (used for global stages, job coding
 * stages, and verification sub-stages).
 *
 * @returns {object} Default stage entry
 */
function defaultStage() {
  return {
    status: STAGE_STATUS.PENDING,
    started_at: null,
    completed_at: null,
    attempt_count: 0,
    markers: {},
    artifacts: [],
    runs: []
  };
}

/**
 * Get the implementation composite stage (holds the flat job list).
 *
 * @param {object} state - Pipeline state
 * @returns {object|null} The implementation stage entry, or null
 */
function getImplementation(state) {
  if (!state || !state.stages) return null;
  return state.stages[GLOBAL_STAGES.IMPLEMENTATION] || null;
}

/**
 * Get the jobs map from state. Collects jobs from implementation.jobs[].
 *
 * The returned map is a fresh object whose values are REFERENCES to the actual
 * job objects stored in implementation.jobs[] — mutations to a job via the
 * returned map are reflected in implementation.jobs[j].
 *
 * @param {object} state - Pipeline state
 * @returns {object} Jobs map (jobId → job entry)
 */
function getJobs(state) {
  var out = {};
  var impl = getImplementation(state);
  if (!impl || !Array.isArray(impl.jobs)) return out;
  for (var j = 0; j < impl.jobs.length; j++) {
    var job = impl.jobs[j];
    if (job && job.id) out[job.id] = job;
  }
  return out;
}

/**
 * Create a default job entry. A job owns ONLY the `coding` stage;
 * verification (testing/review/regression/fix) lives on the `verification`
 * composite stage, not inside the job.
 *
 * @param {object} [meta] - Job metadata from manifest
 * @returns {object} Default job entry
 */
function defaultJob(meta) {
  return {
    id: (meta && meta.id) || null,
    layer: (meta && meta.layer) || null,
    description: (meta && meta.description) || '',
    files: Array.isArray(meta && meta.files) ? meta.files.slice() : [],
    produces: Array.isArray(meta && meta.produces) ? meta.produces.slice() : [],
    depends_on: Array.isArray(meta && meta.depends_on) ? meta.depends_on.slice() : [],
    agent_type: (meta && meta.agent_type) || 'implementer',
    attempt_count: 0,
    max_retries: 2,
    // A job owns a single `coding` stage. Verification runs at the project
    // level once all jobs finish coding.
    coding: defaultStage(),
    status: JOB_STATUS.PENDING
  };
}

/**
 * Create a fresh verification round (testing / review / regression / fix).
 *
 * Each round is an independent snapshot of the four sub-stages. The current
 * round is always the last element of `verification.rounds`; completed rounds
 * are archived as earlier elements so the loop history (including SKIPPED
 * sub-stages) is preserved.
 *
 * @returns {object} A fresh round entry
 */
function newVerificationRound() {
  return {
    testing: defaultStage(),
    review: defaultStage(),
    regression: defaultStage(),
    fix: defaultStage()
  };
}

/**
 * Create a default verification-loop stage (an extended global stage).
 *
 * The `verification` composite global stage owns a project-level verification
 * loop (testing -> review -> regression -> fix, looping back to testing). Its
 * sub-stages run once over the whole change set after all jobs' coding PASSED.
 *
 * @returns {object} Default verification stage entry
 */
function defaultVerificationStage() {
  var stage = defaultStage();
  stage.max_retries = 2;
  stage.rounds = [newVerificationRound()];
  return stage;
}

/**
 * Create a default implementation stage (composite global stage).
 *
 * The `implementation` stage holds the flat job list. It does NOT dispatch an
 * agent — its status is derived from the jobs it contains (PASSED when every
 * job's coding PASSED/WARN/SKIPPED).
 *
 * @returns {object} Default implementation stage entry
 */
function defaultImplementationStage() {
  return {
    status: STAGE_STATUS.PENDING,
    started_at: null,
    completed_at: null,
    jobs: []
  };
}

/**
 * Create a fresh pipeline state object.
 *
 * @returns {object} Default pipeline state
 */
function defaultState() {
  var stages = {};
  for (var i = 0; i < GLOBAL_STAGE_ORDER.length; i++) {
    var stageName = GLOBAL_STAGE_ORDER[i];
    if (stageName === GLOBAL_STAGES.VERIFICATION) {
      stages[stageName] = defaultVerificationStage();
    } else if (stageName === GLOBAL_STAGES.IMPLEMENTATION) {
      stages[stageName] = defaultImplementationStage();
    } else {
      stages[stageName] = defaultStage();
    }
  }

  return {
    // ---- Schema version ----
    schema_version: 8,

    // ---- Session identity ----
    session_id: null,
    turn_started_at: new Date().toISOString(),
    turn_count: 0,
    ts: null,

    // ---- TS lifecycle ----
    ts_lifecycle: 'active',
    ts_created_at: new Date().toISOString(),
    ts_completed_at: null,

    // ---- Pipeline configuration ----
    pipeline_mode: 'job-dag-pipeline',

    // ---- Auto-commit (opt-in via `/spec-forge --auto-commit`) ----
    auto_commit: false,
    commit: null,

    // ---- Global stages (leaf stages + composite implementation/verification) ----
    stages: stages,

    // ---- Completion gating ----
    completion_blocked: false,
    completion_block_reason: null
  };
}

/**
 * Load state from specs/{TS}/state.json, falling back to a fresh default state
 * when no valid state exists (invalid TS / missing file / corrupt file).
 */
function load(ts, projectRoot) {
  return storeLib.load(ts, projectRoot) || defaultState();
}

// ---- Global stage helpers ----

/**
 * Set a global stage's status with timestamp management.
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} stageName - Global stage name
 * @param {string} status - New status value
 * @returns {object} state (for chaining)
 */
function setGlobalStage(state, stageName, status) {
  if (!state || !state.stages) {
    console.error('[harness:state] setGlobalStage() called with invalid state');
    return state;
  }

  if (!state.stages[stageName]) {
    state.stages[stageName] = defaultStage();
  }

  stageEntry.transition(state.stages[stageName], status);
  return state;
}

function getCurrentStage(state, config) {
  if (!state || !state.stages) {
    return GLOBAL_STAGES.EVIDENCE_VERIFY;
  }

  var order = (config && config.stages && config.stages.order)
    ? config.stages.order
    : GLOBAL_STAGE_ORDER;

  for (var i = 0; i < order.length; i++) {
    var stageName = order[i];
    if (!state.stages[stageName]) continue;
    var s = state.stages[stageName];
    if (s.status === STAGE_STATUS.IN_PROGRESS) return stageName;
    if (s.status === STAGE_STATUS.PENDING) return stageName;
  }

  return order[order.length - 1] || GLOBAL_STAGES.EVIDENCE_VERIFY;
}

// ---- Job management ----

/**
 * Initialize jobs from a task-decomposer manifest.
 * Called by the handler when task-decomposer produces a job-manifest.json.
 *
 * Jobs are stored flat inside implementation.jobs[] as full job objects.
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {object} manifest - { jobs: [{...}] }
 * @returns {object} { ok: true, count } or { ok: false, cycle: [...] }
 */
function initJobsFromManifest(state, manifest) {
  if (!state || !manifest || !Array.isArray(manifest.jobs)) {
    return { ok: false, reason: 'manifest.jobs missing or not an array' };
  }

  var impl = getImplementation(state);
  if (!impl) {
    return { ok: false, reason: 'implementation stage missing' };
  }

  var jobs = [];
  for (var j = 0; j < manifest.jobs.length; j++) {
    var jobMeta = manifest.jobs[j];
    var job = defaultJob({
      id: jobMeta.id,
      layer: jobMeta.layer || null,
      description: jobMeta.description || '',
      files: jobMeta.files || [],
      produces: jobMeta.produces || [],
      depends_on: jobMeta.depends_on || [],
      agent_type: jobMeta.agent_type || 'implementer'
    });
    if (job.id) jobs.push(job);
  }

  // Cycle detection on depends_on before committing — a cyclic DAG would
  // otherwise never satisfy jobDepsCodingPassed and stall in `wait` forever.
  var jobsMap = {};
  for (var i = 0; i < jobs.length; i++) jobsMap[jobs[i].id] = jobs[i];
  var cycle = detectJobCycle(jobsMap);
  if (cycle) {
    impl.jobs = [];
    return { ok: false, cycle: cycle };
  }

  impl.jobs = jobs;
  return { ok: true, count: jobs.length };
}

/**
 * Detect a cycle in a job dependency graph.
 *
 * @param {object} jobs - Map of jobId → job (each job has `depends_on: []`)
 * @returns {string[]|null} Job ids forming a cycle (closed path), or null
 */
function detectJobCycle(jobs) {
  if (!jobs || typeof jobs !== 'object') return null;
  var GRAY = 1;
  var BLACK = 2;
  var color = {};
  var stack = [];

  function visit(id) {
    color[id] = GRAY;
    stack.push(id);
    var job = jobs[id];
    var deps = (job && Array.isArray(job.depends_on)) ? job.depends_on : [];
    for (var i = 0; i < deps.length; i++) {
      var dep = deps[i];
      if (!Object.prototype.hasOwnProperty.call(jobs, dep)) continue; // unknown dep — ignore
      if (color[dep] === GRAY) {
        // Back-edge → cycle. Report the closed path.
        var cycleStart = stack.indexOf(dep);
        return stack.slice(cycleStart).concat(dep);
      }
      if (color[dep] !== BLACK) {
        var cyc = visit(dep);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    color[id] = BLACK;
    return null;
  }

  var ids = Object.keys(jobs);
  for (var i = 0; i < ids.length; i++) {
    if (color[ids[i]] !== BLACK) {
      var cycle = visit(ids[i]);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * Get a job's current status. If the stored status is PENDING or IN_PROGRESS,
 * recompute from its coding stage.
 *
 * @param {object} state - Pipeline state
 * @param {string} jobId - Job ID
 * @returns {string} Job status
 */
function getJobStatus(state, jobId) {
  if (!state) return JOB_STATUS.PENDING;
  var jobs = getJobs(state);
  if (!jobs[jobId]) return JOB_STATUS.PENDING;
  return recomputeJobStatus(state, jobId);
}

/**
 * Recompute a job's aggregate status from its coding stage (job-dag model).
 *
 * Rules:
 *   - coding PENDING → PENDING
 *   - coding IN_PROGRESS → IN_PROGRESS
 *   - coding FAILED, retries exhausted → FAILED
 *   - coding FAILED, retries available → IN_PROGRESS
 *   - coding PASSED → PASSED
 *   - coding WARN → WARN
 *   - coding SKIPPED → PASSED (defensive)
 *   - coding BLOCKED → BLOCKED
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} jobId - Job ID
 * @returns {string} The computed job status
 */
function recomputeJobStatus(state, jobId) {
  if (!state) return JOB_STATUS.PENDING;
  var jobs = getJobs(state);
  if (!jobs[jobId]) return JOB_STATUS.PENDING;

  var job = jobs[jobId];
  var codingStage = job.coding;
  if (!codingStage) return job.status || JOB_STATUS.PENDING;

  switch (codingStage.status) {
    case STAGE_STATUS.PENDING:
      job.status = JOB_STATUS.PENDING;
      break;
    case STAGE_STATUS.IN_PROGRESS:
      job.status = JOB_STATUS.IN_PROGRESS;
      break;
    case STAGE_STATUS.FAILED:
      job.status = (job.attempt_count >= job.max_retries)
        ? JOB_STATUS.FAILED
        : JOB_STATUS.IN_PROGRESS;
      break;
    case STAGE_STATUS.BLOCKED:
      job.status = JOB_STATUS.BLOCKED;
      break;
    case STAGE_STATUS.WARN:
      job.status = JOB_STATUS.WARN;
      break;
    case STAGE_STATUS.SKIPPED:
      job.status = JOB_STATUS.PASSED;
      break;
    case STAGE_STATUS.PASSED:
    default:
      job.status = JOB_STATUS.PASSED;
      break;
  }

  return job.status;
}

/**
 * Check if all jobs a job depends_on have coding PASSED (or WARN/SKIPPED).
 * Used by the scheduler to determine if a job's coding can start — downstream
 * coding only needs upstream interfaces ready.
 *
 * @param {object} state - Pipeline state
 * @param {string} jobId - Job ID
 * @returns {boolean} true if all deps are coding-PASSED (or job has no deps)
 */
function jobDepsCodingPassed(state, jobId) {
  var jobs = getJobs(state);
  var job = jobs[jobId];
  if (!job || !Array.isArray(job.depends_on) || job.depends_on.length === 0) return true;
  for (var i = 0; i < job.depends_on.length; i++) {
    var dep = jobs[job.depends_on[i]];
    if (!dep || !dep.coding) return false;
    var cs = dep.coding.status;
    if (cs !== STAGE_STATUS.PASSED && cs !== STAGE_STATUS.WARN && cs !== STAGE_STATUS.SKIPPED) return false;
  }
  return true;
}

/**
 * Check if a job has a terminally-failed dependency (coding FAILED, retries exhausted).
 * Used by the scheduler to fail fast when a dependency can never produce its interface.
 *
 * @param {object} state - Pipeline state
 * @param {string} jobId - Job ID
 * @returns {string|null} The failed dep's job ID, or null if no failed deps
 */
function jobHasFailedDep(state, jobId) {
  var jobs = getJobs(state);
  var job = jobs[jobId];
  if (!job || !Array.isArray(job.depends_on) || job.depends_on.length === 0) return null;
  for (var i = 0; i < job.depends_on.length; i++) {
    var depId = job.depends_on[i];
    var dep = jobs[depId];
    if (!dep) continue;
    var depStatus = recomputeJobStatus(state, depId);
    if (depStatus === JOB_STATUS.FAILED) return depId;
  }
  return null;
}

/**
 * Set a job's coding stage status.
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} jobId - Job ID
 * @param {string} status - New status
 */
function setJobCodingStage(state, jobId, status) {
  if (!state) return;
  var jobs = getJobs(state);
  if (!jobs[jobId]) return;
  var job = jobs[jobId];
  if (!job.coding) return;

  stageEntry.transition(job.coding, status);

  // Recompute job status
  recomputeJobStatus(state, jobId);
}

/**
 * Reset a job's coding stage (for retry).
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} jobId - Job ID
 */
function resetJobCodingStage(state, jobId) {
  if (!state) return;
  var jobs = getJobs(state);
  if (!jobs[jobId]) return;
  var job = jobs[jobId];
  // Reset the coding stage to a fresh default
  job.coding = defaultStage();
  // Bump attempt_count for the upcoming retry
  job.attempt_count += 1;
}

/**
 * Check if all jobs are in terminal state (PASSED, WARN, or FAILED).
 *
 * @param {object} state - Pipeline state
 * @returns {boolean}
 */
function allJobsTerminal(state) {
  if (!state) return true;
  var jobs = getJobs(state);
  var jobIds = Object.keys(jobs);
  if (jobIds.length === 0) return true;
  for (var i = 0; i < jobIds.length; i++) {
    var status = recomputeJobStatus(state, jobIds[i]);
    if (status !== JOB_STATUS.PASSED && status !== JOB_STATUS.WARN && status !== JOB_STATUS.FAILED) return false;
  }
  return true;
}

/**
 * Check if all jobs are PASSED.
 *
 * @param {object} state - Pipeline state
 * @returns {boolean}
 */
function allJobsPassed(state) {
  if (!state) return true;
  var jobs = getJobs(state);
  var jobIds = Object.keys(jobs);
  if (jobIds.length === 0) return true;
  for (var i = 0; i < jobIds.length; i++) {
    var status = recomputeJobStatus(state, jobIds[i]);
    if (status !== JOB_STATUS.PASSED) return false;
  }
  return true;
}

/**
 * Check if all jobs are PASSED or WARN (soft pass).
 *
 * @param {object} state - Pipeline state
 * @returns {boolean}
 */
function allJobsPassedOrWarned(state) {
  if (!state) return true;
  var jobs = getJobs(state);
  var jobIds = Object.keys(jobs);
  if (jobIds.length === 0) return true;
  for (var i = 0; i < jobIds.length; i++) {
    var status = recomputeJobStatus(state, jobIds[i]);
    if (status !== JOB_STATUS.PASSED && status !== JOB_STATUS.WARN) return false;
  }
  return true;
}

/**
 * Check if any job has a WARN status (for evidence-verify to review).
 *
 * @param {object} state - Pipeline state
 * @returns {boolean}
 */
function hasAnyJobWarn(state) {
  if (!state) return false;
  var jobs = getJobs(state);
  var jobIds = Object.keys(jobs);
  for (var i = 0; i < jobIds.length; i++) {
    if (recomputeJobStatus(state, jobIds[i]) === JOB_STATUS.WARN) return true;
  }
  return false;
}

/**
 * Check if any job has been dispatched (has runs in its coding stage).
 *
 * @param {object} state - Pipeline state
 * @returns {boolean}
 */
function hasAnyJobRun(state) {
  if (!state) return false;
  var jobs = getJobs(state);
  var jobIds = Object.keys(jobs);
  for (var i = 0; i < jobIds.length; i++) {
    var job = jobs[jobIds[i]];
    if (!job || !job.coding) continue;
    if (Array.isArray(job.coding.runs) && job.coding.runs.length > 0) return true;
  }
  return false;
}

// ---- Verification-loop management ----
//
// The `verification` composite global stage owns a project-level verification
// loop (testing -> review -> regression -> fix). These helpers read and reset
// that loop's sub-stages.

/**
 * Get the verification global stage, backfilling its sub-stages if missing.
 *
 * @param {object} state - Pipeline state
 * @returns {object|null} The verification stage entry, or null
 */
function getVerificationStage(state) {
  if (!state || !state.stages) return null;
  var ver = state.stages[GLOBAL_STAGES.VERIFICATION];
  if (!ver) return null;
  if (typeof ver.max_retries !== 'number') ver.max_retries = 2;
  if (!Array.isArray(ver.rounds) || ver.rounds.length === 0) {
    ver.rounds = [newVerificationRound()];
  }
  return ver;
}

/**
 * Get the current (last) verification round, backfilling one if missing.
 *
 * @param {object} ver - The verification stage entry
 * @returns {object|null} The current round, or null if `ver` is falsy
 */
function getCurrentRound(ver) {
  if (!ver) return null;
  if (!Array.isArray(ver.rounds) || ver.rounds.length === 0) {
    ver.rounds = [newVerificationRound()];
  }
  return ver.rounds[ver.rounds.length - 1];
}

/**
 * Recompute the verification stage's aggregate status from its sub-stages.
 *
 * Rules:
 *   - fix sub-stage WARN  -> WARN (soft pass; non-code failure recorded)
 *   - regression sub-stage WARN -> WARN (soft pass; perf regression)
 *   - regression sub-stage PASSED -> PASSED
 *   - regression sub-stage FAILED -> FAILED iff retries exhausted, else IN_PROGRESS
 *   - any sub-stage IN_PROGRESS -> IN_PROGRESS
 *   - otherwise -> PENDING
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @returns {string} The verification stage status
 */
function recomputeVerificationStatus(state) {
  var ver = getVerificationStage(state);
  if (!ver) return STAGE_STATUS.PENDING;

  var sub = getCurrentRound(ver);
  var regSub = sub[VERIFICATION_STAGES.REGRESSION];
  var fixSub = sub[VERIFICATION_STAGES.FIX];

  if (fixSub && fixSub.status === STAGE_STATUS.WARN) {
    ver.status = STAGE_STATUS.WARN;
    return ver.status;
  }

  // Perf regression (soft pass): the regression sub-stage can reach WARN when
  // the before/after performance comparison crosses a threshold. WARN is a
  // soft pass — the pipeline completes and evidence-verifier reviews the delta.
  if (regSub && regSub.status === STAGE_STATUS.WARN) {
    ver.status = STAGE_STATUS.WARN;
    if (!ver.completed_at) ver.completed_at = new Date().toISOString();
    return ver.status;
  }

  if (regSub) {
    if (regSub.status === STAGE_STATUS.PASSED) {
      ver.status = STAGE_STATUS.PASSED;
      if (!ver.completed_at) ver.completed_at = new Date().toISOString();
      return ver.status;
    }
    if (regSub.status === STAGE_STATUS.FAILED) {
      var maxRetries = (typeof ver.max_retries === 'number') ? ver.max_retries : 2;
      var fixRounds = ver.rounds.length - 1;
      ver.status = (fixRounds >= maxRetries) ? STAGE_STATUS.FAILED : STAGE_STATUS.IN_PROGRESS;
      return ver.status;
    }
    if (regSub.status === STAGE_STATUS.IN_PROGRESS) {
      ver.status = STAGE_STATUS.IN_PROGRESS;
      return ver.status;
    }
  }

  for (var i = 0; i < VERIFICATION_STAGE_ORDER.length; i++) {
    var s = sub[VERIFICATION_STAGE_ORDER[i]];
    if (s && s.status === STAGE_STATUS.IN_PROGRESS) {
      ver.status = STAGE_STATUS.IN_PROGRESS;
      return ver.status;
    }
  }

  // 任一子阶段非 PENDING（如 testing PASSED + review PENDING 的中途状态）→ 循环
  // 仍在进行，composite 应为 IN_PROGRESS 而非 PENDING。只有四者全 PENDING 才 PENDING。
  for (var i = 0; i < VERIFICATION_STAGE_ORDER.length; i++) {
    var s = sub[VERIFICATION_STAGE_ORDER[i]];
    if (s && s.status !== STAGE_STATUS.PENDING) {
      ver.status = STAGE_STATUS.IN_PROGRESS;
      return ver.status;
    }
  }

  ver.status = STAGE_STATUS.PENDING;
  return ver.status;
}

/**
 * Start the next verification round (archives the current one).
 *
 * Called after a fix round resolves (PASS or FAIL) so the loop re-runs from
 * testing. Each round is preserved in `verification.rounds`; the number of
 * completed fix rounds is `rounds.length - 1`, which `max_retries` bounds.
 *
 * @param {object} state - Pipeline state (mutated in place)
 */
function startNextVerificationRound(state) {
  var ver = getVerificationStage(state);
  if (!ver) return;
  ver.rounds.push(newVerificationRound());
  ver.status = STAGE_STATUS.PENDING;
}

// ---- Global stage recompute ----

/**
 * Recompute a global stage's status from its runs array and markers.
 *
 * Rules:
 *   1. If marker_outcome exists and is PASSED → PASSED
 *   2. If marker_outcome exists and is FAILED → FAILED (no downgrade from PASSED)
 *   3. If any run is IN_PROGRESS (not stale) → IN_PROGRESS
 *   4. If all runs are PASSED → PASSED
 *   5. If any run is FAILED (none IN_PROGRESS) → FAILED
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} stageName - Global stage name
 * @returns {string} The new stage status
 */
function recomputeGlobalStageStatus(state, stageName) {
  if (!state || !state.stages || !state.stages[stageName]) return STAGE_STATUS.PENDING;

  var stage = state.stages[stageName];
  if (!Array.isArray(stage.runs)) stage.runs = [];

  return stageEntry.recompute(stage);
}

/**
 * Recompute a job's coding stage status from its runs and markers.
 * Same logic as recomputeGlobalStageStatus but for the job's coding stage.
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @param {string} jobId - Job ID
 * @returns {string} The new coding stage status
 */
function recomputeJobCodingStatus(state, jobId) {
  if (!state) return STAGE_STATUS.PENDING;
  var jobs = getJobs(state);
  if (!jobs[jobId]) return STAGE_STATUS.PENDING;
  var job = jobs[jobId];
  if (!job.coding) return STAGE_STATUS.PENDING;

  var cs = job.coding;
  if (!Array.isArray(cs.runs)) cs.runs = [];

  var status = stageEntry.recompute(cs);

  // Recompute job status after coding stage change
  recomputeJobStatus(state, jobId);
  return status;
}

// ---- All-stages-passed check ----

function allMandatoryStagesPassed(state) {
  if (!state || !state.stages) return false;

  // Refresh implementation.status from its jobs before the gate check.
  recomputeImplementationStatus(state);

  // All global stages must be PASSED (implementation.status covers jobs;
  // verification.status covers the verification loop)
  for (var i = 0; i < GLOBAL_STAGE_ORDER.length; i++) {
    var gs = state.stages[GLOBAL_STAGE_ORDER[i]];
    if (!gs || gs.status !== STAGE_STATUS.PASSED) return false;
  }

  return true;
}

/**
 * Relaxed completion gate: all global stages PASSED or WARN.
 *
 * @param {object} state - Pipeline state
 * @returns {boolean}
 */
function allMandatoryStagesPassedOrWarned(state) {
  if (!state || !state.stages) return false;

  // Refresh implementation.status from its jobs before the gate check.
  recomputeImplementationStatus(state);

  for (var i = 0; i < GLOBAL_STAGE_ORDER.length; i++) {
    var gs = state.stages[GLOBAL_STAGE_ORDER[i]];
    if (!gs) return false;
    if (gs.status !== STAGE_STATUS.PASSED && gs.status !== STAGE_STATUS.WARN) return false;
  }

  return true;
}

/**
 * Recompute the implementation stage's status from its jobs.
 *
 * The implementation stage is a composite node: it holds the flat job list and
 * does NOT dispatch an agent. Its status aggregates all job coding statuses:
 *   - any job FAILED/BLOCKED → FAILED
 *   - any job IN_PROGRESS    → IN_PROGRESS
 *   - any job PENDING        → PENDING
 *   - any job WARN, none failed/pending → WARN
 *   - all jobs PASSED        → PASSED
 *
 * @param {object} state - Pipeline state (mutated in place)
 * @returns {string|null} The implementation stage status, or null
 */
function recomputeImplementationStatus(state) {
  var impl = getImplementation(state);
  if (!impl) return null;
  var jobs = impl.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    impl.status = STAGE_STATUS.PENDING;
    return impl.status;
  }
  var anyFailed = false;
  var anyInProgress = false;
  var anyPending = false;
  var anyWarn = false;
  for (var i = 0; i < jobs.length; i++) {
    var cs = (jobs[i] && jobs[i].coding) ? jobs[i].coding.status : STAGE_STATUS.PENDING;
    if (cs === STAGE_STATUS.FAILED || cs === STAGE_STATUS.BLOCKED) anyFailed = true;
    else if (cs === STAGE_STATUS.IN_PROGRESS) anyInProgress = true;
    else if (cs === STAGE_STATUS.PENDING) anyPending = true;
    else if (cs === STAGE_STATUS.WARN) anyWarn = true;
  }
  if (anyFailed) impl.status = STAGE_STATUS.FAILED;
  else if (anyInProgress) impl.status = STAGE_STATUS.IN_PROGRESS;
  else if (anyPending) impl.status = STAGE_STATUS.PENDING;
  else if (anyWarn) impl.status = STAGE_STATUS.WARN;
  else impl.status = STAGE_STATUS.PASSED;

  // Stamp started_at on first IN_PROGRESS (the composite never goes through a
  // dispatch builder, unlike simple global stages).
  if (impl.status === STAGE_STATUS.IN_PROGRESS && !impl.started_at) {
    impl.started_at = new Date().toISOString();
  }

  if (impl.status === STAGE_STATUS.PASSED || impl.status === STAGE_STATUS.WARN || impl.status === STAGE_STATUS.FAILED) {
    if (!impl.completed_at) impl.completed_at = new Date().toISOString();
  }
  return impl.status;
}

// ---- Exports ----
module.exports = {
  // Constants
  GLOBAL_STAGES,
  GLOBAL_STAGE_ORDER,
  VERIFICATION_STAGES,
  VERIFICATION_STAGE_ORDER,
  STAGE_STATUS,
  JOB_STATUS,

  // State factories
  defaultState,
  defaultStage,
  defaultJob,
  defaultVerificationStage,
  defaultImplementationStage,

  // State file operations
  load,
  save,
  getJobs,

  // Path resolvers
  resolveSpecsDir,
  resolveTSDir,
  resolveStateFile,

  // Global stage helpers
  setGlobalStage,
  recomputeGlobalStageStatus,
  getCurrentStage,

  // Job management
  initJobsFromManifest,
  detectJobCycle,
  getJobStatus,
  recomputeJobStatus,
  setJobCodingStage,
  resetJobCodingStage,
  allJobsTerminal,
  allJobsPassed,
  allJobsPassedOrWarned,
  hasAnyJobWarn,
  hasAnyJobRun,
  jobDepsCodingPassed,
  jobHasFailedDep,

  // Implementation stage
  getImplementation,
  recomputeImplementationStatus,

  // Verification-loop management
  getVerificationStage,
  getCurrentRound,
  recomputeVerificationStatus,
  startNextVerificationRound,

  // Stage status checks
  allMandatoryStagesPassed,
  allMandatoryStagesPassedOrWarned,
  recomputeJobCodingStatus,

  // TS Lifecycle
  ensureTsLifecycle,
  markTsCompleted
};
