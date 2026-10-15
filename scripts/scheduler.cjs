#!/usr/bin/env node
/**
 * spec-forge — Deterministic Scheduler (Job-DAG Pipeline Model)
 *
 * This is the single decision point for the pipeline. The Coordinator (LLM)
 * calls this script, reads the JSON instruction from stdout, and executes it
 * without any further state judgment.
 *
 * Model:
 *   - Each job performs ONLY coding (parallel, driven by depends_on)
 *   - After ALL jobs' coding PASSED, the `verification` composite stage runs
 *   * one project-level loop: testing → review → regression → (fix → testing)
 *   - Jobs form a flat DAG (depends_on); no wave abstraction
 *
 * Usage:
 *   node scripts/scheduler.cjs [--ts=<TS>]
 *
 * Zero external dependencies. Reads state from specs/{TS}/state.json. TS comes
 * from the --ts flag (session marker as fallback); no global .active pointer.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const stateLib = require('./state.cjs');
const configLib = require('./config.cjs');
const dispatchScope = require('./dispatch-scope.cjs');
const sessionLib = require('./session.cjs');

// best-effort event logger (non-fatal)
let eventLogger = null;
try {
  eventLogger = require('./event-logger.cjs');
} catch (e) {
  eventLogger = null;
}

const {
  DEFAULT_STALE_MS,
  GLOBAL_TO_AGENT,
  VERIFICATION_TO_AGENT
} = configLib;

const STAGE_STATUS = stateLib.STAGE_STATUS;
const JOB_STATUS = stateLib.JOB_STATUS;
const GLOBAL_STAGES = stateLib.GLOBAL_STAGES;
const GLOBAL_STAGE_ORDER = stateLib.GLOBAL_STAGE_ORDER;
const VERIFICATION_STAGES = stateLib.VERIFICATION_STAGES;

// ---- Decision logic ----

/**
 * Determine the next action for the pipeline.
 * Pure function: no I/O, all data via arguments.
 *
 * The job coding runs as a gate between task-decompose and verification; the
 * verification loop runs between implementation and evidence-verify.
 *
 * @param {object} state - Pipeline state
 * @param {object} config - Harness config
 * @returns {object} Instruction object: { action, ... }
 */
function decideNext(state, config, projectRoot) {
  // Validate state
  if (!state || !state.stages) {
    return { action: 'fail', reason: 'Invalid state: missing stages' };
  }

  // Iterate global stages in order. baseline-regression is a normal global
  // stage; `implementation` dispatches job coding (flat DAG); `verification`
  // runs the project-level loop before evidence-verify.
  for (var i = 0; i < GLOBAL_STAGE_ORDER.length; i++) {
    var stageName = GLOBAL_STAGE_ORDER[i];

    if (stageName === GLOBAL_STAGES.IMPLEMENTATION) {
      // Implementation node: evaluate the flat job DAG (coding only).
      var implResult = _evaluateImplementation(state, config, projectRoot);
      if (implResult) return implResult;
      continue;
    }

    if (stageName === GLOBAL_STAGES.VERIFICATION) {
      // Verification gate: project-level loop (runs after all jobs PASS).
      var verResult = _evaluateVerification(state, config);
      if (verResult) return verResult;
      continue;
    }

    var result = _evaluateGlobalStage(state, config, stageName);
    if (result) return result;
  }

  return { action: 'done', summary: 'All global stages PASSED (or WARN) and all jobs PASSED (or WARN)' };
}

/**
 * Evaluate a single global stage and return an instruction if action needed.
 *
 * @returns {object|null} Instruction or null (stage is PASSED, continue)
 */
function _evaluateGlobalStage(state, config, stageName) {
  var stage = state.stages[stageName];
  if (!stage) {
    // Stage doesn't exist — create it and dispatch
    return _buildGlobalDispatch(state, stageName);
  }

  switch (stage.status) {
    case STAGE_STATUS.PENDING:
      // Check upstream requirements
      var upstreamOk = _checkGlobalUpstream(state, config, stageName);
      if (!upstreamOk.ok) {
        return { action: 'wait', reason: upstreamOk.reason };
      }
      // evidence-verify requires all jobs to be terminal and PASSED (or WARN — soft pass)
      if (stageName === GLOBAL_STAGES.EVIDENCE_VERIFY) {
        if (!stateLib.allJobsTerminal(state)) {
          return { action: 'wait', reason: 'Waiting for all jobs to reach terminal state before ' + stageName };
        }
        // Accept WARN (soft pass) in addition to PASSED. WARN jobs are
        // flagged for evidence-verify review but do not block the pipeline.
        if (!stateLib.allJobsPassedOrWarned(state)) {
          return { action: 'fail', reason: 'Cannot proceed to evidence-verify: some jobs FAILED',
                   stage: stageName };
        }
      }
      return _buildGlobalDispatch(state, stageName);

    case STAGE_STATUS.IN_PROGRESS:
      // Check for stale runs
      var staleCheck = _checkStaleRuns(stage);
      if (staleCheck.isStale) {
        // Retry if possible, bounded by max_retries. attempt_count is 1-based
        // (first dispatch = 1), so the last retry is allowed when
        // attempt_count == max_retries (total attempts = max_retries + 1).
        var sMaxRetries = config.retry_policy ? config.retry_policy.global_max_retries : 2;
        if (stage.attempt_count <= sMaxRetries) {
          stage.attempt_count += 1;
          // Re-dispatch: reset started_at so the fresh run is not immediately
          // re-flagged stale (status is already IN_PROGRESS).
          stage.started_at = new Date().toISOString();
          return {
            action: 'retry',
            scope: 'global',
            stage: stageName,
            agent: GLOBAL_TO_AGENT[stageName],
            attempt: stage.attempt_count,
            reason: 'stale_run: ' + staleCheck.reason,
            description: dispatchScope.encode(state.ts, { scope: 'global', stageName: stageName })
          };
        }
        return { action: 'fail', stage: stageName, reason: 'Global stage stale after max retries' };
      }
      return { action: 'wait', reason: 'Global stage ' + stageName + ' is IN_PROGRESS' };

    case STAGE_STATUS.FAILED:
      // Retry if possible, bounded by max_retries. Bump attempt_count so a
      // repeated FAILED eventually fails the stage instead of retrying forever.
      // Mark IN_PROGRESS for streaming safety so a re-call to the scheduler
      // while the retried agent is in flight does not re-retry the stage.
      var gMaxRetries = config.retry_policy ? config.retry_policy.global_max_retries : 2;
      if (stage.attempt_count <= gMaxRetries) {
        // Route through transition: clears the previous attempt's markers/artifacts
        // and bumps attempt_count (consistent with the 1-based first dispatch).
        stateLib.setGlobalStage(state, stageName, STAGE_STATUS.IN_PROGRESS);
        return {
          action: 'retry',
          scope: 'global',
          stage: stageName,
          agent: GLOBAL_TO_AGENT[stageName],
          attempt: stage.attempt_count,
          reason: 'previous attempt FAILED',
          description: dispatchScope.encode(state.ts, { scope: 'global', stageName: stageName })
        };
      }
      return { action: 'fail', stage: stageName, reason: 'Global stage FAILED after ' + (stage.attempt_count + 1) + ' attempts (max_retries=' + gMaxRetries + ')' };

    case STAGE_STATUS.PASSED:
    case STAGE_STATUS.SKIPPED:
      return null; // Continue to next stage

    default:
      return null;
  }
}

/**
 * Evaluate the implementation stage (flat job DAG, coding only).
 *
 * A job's coding is ready when its `depends_on` deps have coding PASSED (or
 * WARN/SKIPPED). Ready jobs are dispatched up to a concurrency cap (default 5,
 * `SPEC_FORGE_MAX_CONCURRENCY` overrides, 0 = unlimited); jobs beyond the cap
 * wait for a freed slot. There is no wave abstraction and no cross-wave
 * serialization — the DAG's `depends_on` edges are the only ordering.
 *
 * @returns {object|null} Instruction or null (all jobs PASSED, continue)
 */
function _evaluateImplementation(state, config, projectRoot) {
  var jobs = stateLib.getJobs(state);
  var jobIds = Object.keys(jobs);
  if (jobIds.length === 0) {
    return {
      action: 'fail',
      reason: 'task-decomposer produced 0 jobs — manifest is empty'
    };
  }

  // Defensive cycle guard: a cyclic depends_on graph would never satisfy
  // jobDepsCodingPassed and would stall in `wait` forever.
  var cycle = stateLib.detectJobCycle(jobs);
  if (cycle) {
    return {
      action: 'fail',
      reason: 'Job dependency cycle detected: ' + cycle.join(' -> ')
    };
  }

  // Collect ready coding jobs (depends_on satisfied), bounded by the concurrency
  // cap; streaming re-calls dispatch newly-ready jobs as slots free up.
  var codingResult = _collectReadyCodingJobs(state, config);

  // Refresh implementation.status from its jobs.
  stateLib.recomputeImplementationStatus(state);

  if (codingResult) return codingResult;

  // No dispatch possible — check for terminal failures, then completion.
  for (var j = 0; j < jobIds.length; j++) {
    var jobStatus = stateLib.recomputeJobStatus(state, jobIds[j]);
    if (jobStatus === JOB_STATUS.FAILED) {
      return {
        action: 'fail',
        job_id: jobIds[j],
        reason: 'Job ' + jobIds[j] + ' coding FAILED after max retries'
      };
    }
  }

  var impl = stateLib.getImplementation(state);
  if (impl && (impl.status === STAGE_STATUS.PASSED || impl.status === STAGE_STATUS.WARN)) {
    return null; // All jobs terminal PASSED/WARN → proceed to verification
  }

  return { action: 'wait', reason: 'Jobs in progress (coding)' };
}

/**
 * Evaluate the project-level verification loop (testing → review → regression,
 * looping back to testing via fix when a stage fails).
 *
 * Runs after all jobs PASS/WARN and before evidence-verify.
 *
 *   - testing FAILED  → fix (skip review + regression)
 *   - review FAILED   → fix (short-circuit, skip regression)
 *   - regression FAILED → fix (bounded by max_retries)
 *   - fix PASSED      → reset the loop, re-run from testing
 *   - fix WARN        → composite WARN (soft pass, non-code failure)
 *   - regression PASSED/WARN → composite PASSED/WARN (exit)
 *
 * @returns {object|null} Instruction or null (verification PASSED/WARN)
 */
function _evaluateVerification(state, config) {
  var ver = stateLib.getVerificationStage(state);
  if (!ver) {
    return { action: 'fail', reason: 'Verification stage missing from state' };
  }

  var cur = stateLib.getCurrentRound(ver);

  // Step 1: testing (entry)
  var testingResult = _evaluateVerificationSubStage(state, config, VERIFICATION_STAGES.TESTING);
  if (testingResult) return testingResult;

  if (cur.testing.status === STAGE_STATUS.FAILED) {
    _markVerificationSkipped(cur, [VERIFICATION_STAGES.REVIEW, VERIFICATION_STAGES.REGRESSION], 'testing failed');
    return _afterVerificationFailure(state, config);
  }

  // testing PASSED/WARN → review
  var reviewResult = _evaluateVerificationSubStage(state, config, VERIFICATION_STAGES.REVIEW);
  if (reviewResult) return reviewResult;

  if (cur.review.status === STAGE_STATUS.FAILED) {
    // Short-circuit: skip regression, go straight to fix.
    _markVerificationSkipped(cur, [VERIFICATION_STAGES.REGRESSION], 'review failed');
    return _afterVerificationFailure(state, config);
  }

  // review PASSED/WARN → regression
  var regResult = _evaluateVerificationSubStage(state, config, VERIFICATION_STAGES.REGRESSION);
  if (regResult) return regResult;

  if (cur.regression.status === STAGE_STATUS.PASSED || cur.regression.status === STAGE_STATUS.WARN) {
    // fix 无需运行：显式标记 SKIPPED（回归/新特性通过，无修复轮）。
    _markVerificationSkipped(cur, [VERIFICATION_STAGES.FIX],
      cur.regression.status === STAGE_STATUS.PASSED ? 'regression passed' : 'regression warn');
    stateLib.recomputeVerificationStatus(state);
    return null;
  }

  if (cur.regression.status === STAGE_STATUS.FAILED) {
    return _afterVerificationFailure(state, config);
  }

  // No dispatch possible — loop in progress
  return { action: 'wait', reason: 'Verification loop in progress' };
}

/**
 * Handle a verification sub-stage failure (skip marking is done by the
 * caller). Dispatches fix, or terminates on max retries — enforced uniformly
 * regardless of which sub-stage failed.
 *
 * @returns {object|null} Instruction or null
 */
function _afterVerificationFailure(state, config) {
  var ver = stateLib.getVerificationStage(state);
  var maxRetries = (typeof ver.max_retries === 'number') ? ver.max_retries : 2;
  var fixRounds = ver.rounds.length - 1;
  if (fixRounds >= maxRetries) {
    ver.status = STAGE_STATUS.FAILED;
    // 重试耗尽：本轮 fix 显式 SKIPPED（无修复预算）。
    _markVerificationSkipped(stateLib.getCurrentRound(ver), [VERIFICATION_STAGES.FIX], 'retries exhausted');
    return { action: 'fail', reason: 'Verification FAILED after max retries (' + maxRetries + ')' };
  }
  return _evaluateVerificationFix(state, config);
}

/**
 * Mark sub-stages SKIPPED (with a reason) when an earlier sub-stage FAILed.
 *
 * @param {object} round - The current round
 * @param {string[]} subStageNames - Sub-stages to mark SKIPPED
 * @param {string} reason - Why they were skipped
 */
function _markVerificationSkipped(round, subStageNames, reason) {
  for (var i = 0; i < subStageNames.length; i++) {
    var sub = round[subStageNames[i]];
    if (sub && sub.status === STAGE_STATUS.PENDING) {
      sub.status = STAGE_STATUS.SKIPPED;
      sub.skip_reason = reason;
    }
  }
}

/**
 * Evaluate the fix sub-stage (reached when testing/review/regression FAILED).
 *
 * - fix PENDING → dispatch fixer
 * - fix WARN    → composite WARN (soft pass, non-code failure)
 * - fix PASSED  → reset loop + re-run from testing
 * - fix FAILED  → reset loop + re-run from testing (bounded by attempt_count)
 *
 * @returns {object|null} Instruction or null
 */
function _evaluateVerificationFix(state, config) {
  var ver = stateLib.getVerificationStage(state);
  var cur = stateLib.getCurrentRound(ver);

  var fixResult = _evaluateVerificationSubStage(state, config, VERIFICATION_STAGES.FIX);
  if (fixResult) return fixResult;

  if (cur.fix.status === STAGE_STATUS.WARN) {
    stateLib.recomputeVerificationStatus(state);
    return null;
  }

  if (cur.fix.status === STAGE_STATUS.FAILED || cur.fix.status === STAGE_STATUS.PASSED) {
    // Both restart the loop from testing. The cap is enforced when the next
    // failure occurs (`rounds.length - 1 >= max_retries` in
    // _afterVerificationFailure), so every fix round is bounded.
    stateLib.startNextVerificationRound(state);
    return _buildVerificationDispatch(state, config, VERIFICATION_STAGES.TESTING);
  }

  return { action: 'wait', reason: 'Verification fix in progress' };
}

/**
 * Evaluate a single verification sub-stage (PENDING → dispatch; IN_PROGRESS →
 * wait/stale retry). Terminal sub-stage statuses are handled by the caller.
 *
 * @returns {object|null} Instruction or null
 */
function _evaluateVerificationSubStage(state, config, subName) {
  var ver = stateLib.getVerificationStage(state);
  if (!ver) return null;
  var cur = stateLib.getCurrentRound(ver);
  if (!cur || !cur[subName]) return null;
  var sub = cur[subName];

  switch (sub.status) {
    case STAGE_STATUS.PENDING:
      return _buildVerificationDispatch(state, config, subName);

    case STAGE_STATUS.IN_PROGRESS:
      var staleCheck = _checkStaleRuns(sub);
      if (staleCheck.isStale) {
        var subMax = config.retry_policy ? config.retry_policy.global_max_retries : 2;
        if (sub.attempt_count < subMax) {
          sub.attempt_count += 1;
          return _buildVerificationRetry(state, config, subName, 'stale_run: ' + staleCheck.reason);
        }
        // Retries exhausted -> FAILED, so the caller routes to fix (not infinite retry).
        sub.status = STAGE_STATUS.FAILED;
        sub.completed_at = new Date().toISOString();
        return null;
      }
      return { action: 'wait', reason: 'Verification ' + subName + ' in progress' };

    default:
      return null;
  }
}

/**
 * Build a dispatch instruction for a verification sub-stage.
 *
 * Marks the sub-stage IN_PROGRESS before returning (streaming safety), so
 * re-calling the scheduler does not re-dispatch the same sub-stage while its
 * Task is in flight.
 */
function _buildVerificationDispatch(state, config, subName) {
  var ver = stateLib.getVerificationStage(state);
  var cur = stateLib.getCurrentRound(ver);
  var sub = cur[subName];
  var agent = VERIFICATION_TO_AGENT[subName];
  var now = new Date().toISOString();
  sub.status = STAGE_STATUS.IN_PROGRESS;
  sub.started_at = now;
  // 子阶段任一非 PENDING ⇒ verification.status 立即适配（IN_PROGRESS / PASSED /
  // FAILED / WARN）。派发 testing/review/fix 后主行显示 ▸verification 而非 ·verification。
  // recomputeVerificationStatus 的 IN_PROGRESS 分支不碰 started_at，这里仍要手动打点。
  if (!ver.started_at) ver.started_at = now;
  stateLib.recomputeVerificationStatus(state);
  return {
    action: 'dispatch',
    scope: 'verification',
    ts: state.ts || null,
    stage: GLOBAL_STAGES.VERIFICATION,
    sub_stage: subName,
    agent: agent,
    description: dispatchScope.encode(state.ts, { scope: 'verification', subStage: subName }),
    prompt_hint: _buildVerificationPromptHint(state, config, subName)
  };
}

/**
 * Build a retry instruction for a verification sub-stage.
 */
function _buildVerificationRetry(state, config, subName, reason) {
  var dispatch = _buildVerificationDispatch(state, config, subName);
  dispatch.action = 'retry';
  dispatch.reason = reason;
  return dispatch;
}

/**
 * Collect ready coding dispatches across the flat job DAG.
 *
 * A job's coding is ready when:
 *   - coding status is PENDING (or FAILED with retries left, or stale IN_PROGRESS)
 *   - all of the job's depends_on deps have coding PASSED (or WARN/SKIPPED)
 *
 * @param {object} state - Pipeline state
 * @param {object} config - Harness config
 * @returns {object|null} Instruction (dispatch/dispatch_batch/fail) or null
 */
function _collectReadyCodingJobs(state, config) {
  var jobs = stateLib.getJobs(state);
  var jobIds = Object.keys(jobs);
  var readyPairs = []; // [{ instruction, job }] — collected before cap
  var inFlight = 0; // count of non-stale IN_PROGRESS jobs (bounded by the cap)

  for (var i = 0; i < jobIds.length; i++) {
    var job = jobs[jobIds[i]];
    if (!job || !job.coding) continue;

    var codingStage = job.coding;

    switch (codingStage.status) {
      case STAGE_STATUS.PENDING:
        // Check depends_on — all deps must have coding PASSED
        if (stateLib.jobDepsCodingPassed(state, job.id)) {
          readyPairs.push({ instruction: _buildJobDispatch(state, job), job: job });
        } else {
          // Check if any dep is terminally FAILED — fail fast
          var failedDep = stateLib.jobHasFailedDep(state, job.id);
          if (failedDep) {
            return {
              action: 'fail',
              job_id: job.id,
              reason: 'Job ' + job.id + ' depends on FAILED job ' + failedDep
            };
          }
          // Deps not ready yet — waiting
        }
        break;

      case STAGE_STATUS.IN_PROGRESS:
        var staleCheck = _checkStaleRuns(codingStage);
        if (staleCheck.isStale) {
          if (job.attempt_count < job.max_retries) {
            stateLib.resetJobCodingStage(state, job.id);
            readyPairs.push({ instruction: _buildJobRetry(state, job, 'stale_run: ' + staleCheck.reason), job: job });
          } else {
            stateLib.setJobCodingStage(state, job.id, STAGE_STATUS.FAILED);
          }
        } else {
          inFlight += 1;
        }
        break;

      case STAGE_STATUS.FAILED:
        if (job.attempt_count < job.max_retries) {
          stateLib.resetJobCodingStage(state, job.id);
          readyPairs.push({ instruction: _buildJobRetry(state, job, 'previous attempt FAILED'), job: job });
        } else {
          job.status = JOB_STATUS.FAILED;
        }
        break;

      default:
        break;
    }
  }

  // Concurrency cap: dispatch at most (cap - inFlight) ready jobs. Jobs beyond
  // the cap stay PENDING and are picked up by the next streaming re-call once a
  // slot frees up. cap = Infinity when the policy is 0 (unlimited).
  var cap = configLib.getMaxConcurrency(config);
  var available = cap - inFlight;
  var toDispatch = available > 0 ? readyPairs.slice(0, available) : [];

  if (toDispatch.length > 0) {
    // Mark dispatched jobs as IN_PROGRESS so the next scheduler call (streaming
    // update) does not re-dispatch them while their Tasks are in flight.
    var now = new Date().toISOString();
    var dispatches = [];
    for (var k = 0; k < toDispatch.length; k++) {
      toDispatch[k].job.coding.status = STAGE_STATUS.IN_PROGRESS;
      toDispatch[k].job.coding.started_at = now;
      dispatches.push(toDispatch[k].instruction);
    }

    if (dispatches.length === 1) return dispatches[0];
    return {
      action: 'dispatch_batch',
      scope: 'job',
      dispatches: dispatches,
      count: dispatches.length,
      summary: 'Dispatch ' + dispatches.length + ' coding jobs in parallel'
    };
  }

  if (inFlight > 0) {
    return null; // Coding in progress — caller will wait
  }

  return null;
}

// ---- Helpers ----

/**
 * Check if a global stage's upstream requirements are met.
 */
function _checkGlobalUpstream(state, config, stageName) {
  var reqs = configLib.getStageRequirements(config, stageName);
  if (!reqs || !Array.isArray(reqs.upstream_stages) || reqs.upstream_stages.length === 0) {
    return { ok: true };
  }

  for (var i = 0; i < reqs.upstream_stages.length; i++) {
    var upstream = reqs.upstream_stages[i];
    var upStage = state.stages[upstream];
    // WARN is a soft pass — accept it as upstream satisfaction (e.g. the
    // verification stage can reach WARN when the fixer reports a non-code failure).
    if (!upStage || (upStage.status !== STAGE_STATUS.PASSED && upStage.status !== STAGE_STATUS.WARN)) {
      return { ok: false, reason: 'Upstream stage ' + upstream + ' not PASSED/WARN (status: ' + (upStage ? upStage.status : 'missing') + ')' };
    }
  }

  return { ok: true };
}

/**
 * Check if a stage (global, job coding, or verification) has stale IN_PROGRESS runs.
 *
 * Two detection paths:
 * 1. If stage.runs[] contains an IN_PROGRESS entry (when recordXRun is used),
 *    check its started_at against the stale window.
 * 2. Otherwise (streaming dispatch: marks stage.status=IN_PROGRESS +
 *    stage.started_at but does not push a run entry), fall back to
 *    stage.started_at itself. Without this fallback, a Task that hangs or an
 *    orchestrator crash would leave the stage IN_PROGRESS forever because
 *    runs[] is empty and the loop below never executes.
 */
function _checkStaleRuns(stage) {
  if (!stage) return { isStale: false };

  var now = Date.now();
  var attemptStart = stage.started_at ? new Date(stage.started_at).getTime() : 0;

  // Streaming model: the stage is IN_PROGRESS with a started_at timestamp.
  // Use the stage-level timestamp as the staleness signal.
  if (stage.status === STAGE_STATUS.IN_PROGRESS && attemptStart > 0) {
    if ((now - attemptStart) > DEFAULT_STALE_MS) {
      return { isStale: true, reason: 'stage started at ' + stage.started_at + ' is stale (no in-flight run entry)' };
    }
  }

  return { isStale: false };
}

// ---- Description builders ----

/**
 * Build a dispatch instruction for a global stage.
 */
function _buildGlobalDispatch(state, stageName) {
  var agent = GLOBAL_TO_AGENT[stageName];
  var promptHint = _buildGlobalPromptHint(state, stageName);
  // Mark the target stage IN_PROGRESS for streaming safety (mirror
  // _buildVerificationDispatch) so re-calling the scheduler while the agent's
  // Task is in flight does not re-dispatch the same global stage.
  var targetStage = state.stages && state.stages[stageName];
  if (targetStage) {
    targetStage.status = STAGE_STATUS.IN_PROGRESS;
    targetStage.started_at = new Date().toISOString();
    // 1-based attempt_count: first dispatch = 1 (see _evaluateGlobalStage).
    if (!targetStage.attempt_count) targetStage.attempt_count = 1;
  }
  return {
    action: 'dispatch',
    scope: 'global',
    ts: state.ts || null,
    stage: stageName,
    agent: agent,
    description: dispatchScope.encode(state.ts, { scope: 'global', stageName: stageName }),
    prompt_hint: promptHint
  };
}

/**
 * Build a dispatch instruction for a job coding stage.
 */
function _buildJobDispatch(state, job) {
  var promptHint = _buildJobPromptHint(state, job);
  return {
    action: 'dispatch',
    scope: 'job',
    ts: state.ts || null,
    job_id: job.id,
    stage: 'coding',
    agent: 'implementer',
    description: dispatchScope.encode(state.ts, { scope: 'job', jobId: job.id }),
    prompt_hint: promptHint,
    job_details: {
      layer: job.layer,
      files: job.files,
      produces: job.produces,
      depends_on: job.depends_on,
      description: job.description
    }
  };
}

/**
 * Build a retry instruction for a job coding stage.
 */
function _buildJobRetry(state, job, reason) {
  var dispatch = _buildJobDispatch(state, job);
  dispatch.action = 'retry';
  dispatch.attempt = job.attempt_count;
  dispatch.reason = reason;
  return dispatch;
}

/**
 * Build prompt hint for a global-stage dispatch.
 */
function _buildGlobalPromptHint(state, stageName) {
  var ts = state.ts || 'unknown';
  // Append platform shell note to evidence-verify (which runs tests).
  var shellNote = configLib.getPlatformShellNote ? configLib.getPlatformShellNote() : '';
  switch (stageName) {
    case GLOBAL_STAGES.SPEC_CHECK:
      return 'Validate the spec. TS=' + ts + '. Output HANDOFF JSON with decision PASS/FAIL. Write spec.md and spec-check-report.json to specs/' + ts + '/';
    case GLOBAL_STAGES.TASK_DECOMPOSE:
      return 'Decompose the spec into jobs. TS=' + ts + '. Read specs/' + ts + '/spec.md. Write job-manifest.json with a flat jobs[] array (depends_on expresses ordering; it must be acyclic). Output HANDOFF JSON with decision PASS/FAIL and markers.jobs.';
    case GLOBAL_STAGES.BASELINE_REGRESSION:
      return 'Run the BASELINE full regression BEFORE any code is written. TS=' + ts + '. Follow your role definition (regression-runner.md) Baseline workflow in full: run the build, unit tests, and batch regression tests against the unmodified codebase; then deploy the freshly-built binary and, if the project documents a stress test, run it to capture the performance baseline (perf-baseline.json). If build/tests do NOT all pass, the project is broken pre-change — return FAIL with reasons (the pipeline will terminate). Write specs/' + ts + '/baseline-regression-report.md. Output HANDOFF JSON with decision PASS/FAIL.' + shellNote;
    case GLOBAL_STAGES.EVIDENCE_VERIFY:
      return 'Verify all evidence. TS=' + ts + '. Read all artifacts. Run project tests/build. Write verification-report.md. Output HANDOFF JSON with decision PASS/FAIL.' + shellNote;
    default:
      return 'TS=' + ts + ' GLOBAL=' + stageName;
  }
}

/**
 * Build prompt hint for a job coding-stage dispatch.
 */
function _buildJobPromptHint(state, job) {
  var ts = state.ts || 'unknown';
  var base = 'TS=' + ts + ' JOB=' + job.id + ' STAGE=coding. ' + job.description + '. Files: ' + (job.files || []).join(', ') + '.';
  return base + ' Implement the code for this single job ONLY. Do NOT write tests or review — those run at the verification stage after all jobs finish coding. ALSO Write specs/' + ts + '/coding-manifest-' + job.id + '.json describing WHAT you implemented (changed_files[] + symbols[] with signature/description) — this is a required gate; list it in HANDOFF artifacts. Output HANDOFF JSON with artifacts list.';
}

/**
 * Build prompt hint for a verification sub-stage dispatch.
 */
function _buildVerificationPromptHint(state, config, subName) {
  var ts = state.ts || 'unknown';
  var shellNote = configLib.getPlatformShellNote ? configLib.getPlatformShellNote() : '';

  switch (subName) {
    case VERIFICATION_STAGES.TESTING:
      return 'TS=' + ts + ' GLOBAL=verification STAGE=testing. Write and run unit tests covering the WHOLE change set (all jobs). The test suite must compile and run — this implicitly verifies the change set compiles. If the code does not build, report FAIL. ALSO Write specs/' + ts + '/test-manifest.json describing WHAT you tested (test_files[] + acceptance_criteria[] AC-to-test trace + summary) — this is a required gate; list it in HANDOFF artifacts. Output HANDOFF JSON with decision PASS/FAIL and test results.' + shellNote;
    case VERIFICATION_STAGES.REVIEW:
      return 'TS=' + ts + ' GLOBAL=verification STAGE=review. Review ALL code + tests for the whole change set. Check quality, error handling, type contracts, cross-job integration. Write specs/' + ts + '/review-report.md. Output HANDOFF JSON with decision APPROVE/WARN/BLOCK. artifacts must contain ONLY the review report (.md).';
    case VERIFICATION_STAGES.REGRESSION:
      return 'TS=' + ts + ' GLOBAL=verification STAGE=regression. Run the project-level full regression per your role definition (regression-runner.md) Final workflow in full: build, unit tests, and batch regression tests (cross-job integration); then deploy the new binary and, if the project documents a stress test, run it and compare against the baseline. Output HANDOFF JSON with decision PASS/FAIL, failed-tests list, and attribution. Write specs/' + ts + '/regression-conclusion.md on the terminal outcome.' + shellNote;
    case VERIFICATION_STAGES.FIX:
      return 'TS=' + ts + ' GLOBAL=verification STAGE=fix. Address the failures from testing/review/regression. Read the relevant HANDOFF reports. Fix the implementation files only (do NOT modify tests). If the failure is NOT caused by this change set (flaky/environment), return decision WARN with a reason instead of fixing. Output HANDOFF JSON with decision PASS/WARN/FAIL and changed files.' + shellNote;
    default:
      return 'TS=' + ts + ' GLOBAL=verification STAGE=' + subName;
  }
}

// ---- CLI entry point ----

/**
 * List candidate TS dirs under specs/ for recovery output.
 */
function listCandidateTsDirs(projectRoot) {
  const specsDir = path.join(projectRoot, 'specs');
  const candidates = [];
  try {
    const entries = fs.readdirSync(specsDir, { withFileTypes: true });
    const tsRe = /^\d{8}-\d{6}(?:-[a-z0-9]{4})?$/;
    for (const e of entries) {
      if (e.isDirectory() && tsRe.test(e.name)) candidates.push(e.name);
    }
  } catch (_) { /* specs dir missing */ }
  return candidates.sort();
}

function main() {
  try {
    var projectRoot = process.env.PROJECT_DIR || process.cwd();
    var config = configLib.loadConfig(projectRoot);

    // Concurrency cap override: 0 = unlimited, N >= 1 = cap N, invalid = default.
    config.parallelism.max_concurrent_coding_jobs = configLib.parseMaxConcurrency(
      process.env.SPEC_FORGE_MAX_CONCURRENCY,
      config.parallelism.max_concurrent_coding_jobs
    );

    // TS resolution: --ts=<TS> flag > session marker (Claude Code only).
    var ts = null;
    var argv = process.argv.slice(2);
    for (var i = 0; i < argv.length; i++) {
      if (argv[i].startsWith('--ts=')) ts = argv[i].slice('--ts='.length);
      else if (argv[i] === '--ts' && i + 1 < argv.length) ts = argv[++i];
    }
    if (!ts) {
      ts = sessionLib.readSessionActiveTS(projectRoot);
    }
    if (!ts) {
      // No global .active anymore — list candidates so the orchestrator can recover.
      var candidates = listCandidateTsDirs(projectRoot);
      console.log(JSON.stringify({
        action: 'fail',
        reason: 'No TS provided. Pass --ts=<TS> (or rely on the session marker from init).',
        candidates: candidates.length > 0 ? candidates : undefined
      }));
      return;
    }

    var state = stateLib.load(ts, projectRoot);
    if (state.ts !== ts) {
      state.ts = ts;
    }

    var instruction = decideNext(state, config, projectRoot);

    // decideNext may mutate state (recompute, retry resets, job.status=FAILED).
    // Always persist so state.json reflects the scheduler's view.
    stateLib.save(state, ts, projectRoot);

    // Best-effort instrumentation: record the scheduler's resulting instruction
    // to the per-TS events.log so runs can be audited/replayed. Failure to
    // record must not affect the scheduler outcome.
    try {
      if (eventLogger && instruction) {
        const base = {
          event_type: (instruction.action === 'dispatch' ? 'dispatch'
            : instruction.action === 'dispatch_batch' ? 'dispatch_batch'
            : instruction.action === 'retry' ? 'retry'
            : instruction.action === 'fail' ? 'fail'
            : instruction.action === 'done' ? 'complete' : 'info'),
          actor_id: 'scheduler',
          actor_type: 'orchestrator',
          trace_id: state.ts || null,
          timestamp: new Date().toISOString()
        };
        if (instruction.action === 'dispatch') {
          const ev = Object.assign({}, base, {
            task_id: instruction.job_id || ('global-' + instruction.stage),
            payload: { scope: instruction.scope, stage: instruction.stage, agent: instruction.agent, description: instruction.description }
          });
          eventLogger.logEvent(ev, projectRoot, state.ts);
        } else if (instruction.action === 'dispatch_batch') {
          const ev = Object.assign({}, base, {
            task_id: 'batch-' + (state.ts || 'unknown') + '-' + Date.now(),
            payload: { count: instruction.count, dispatches: instruction.dispatches ? instruction.dispatches.map(d => ({ job_id: d.job_id })) : undefined }
          });
          eventLogger.logEvent(ev, projectRoot, state.ts);
        } else {
          const ev = Object.assign({}, base, { task_id: state.ts, payload: { instruction: instruction } });
          eventLogger.logEvent(ev, projectRoot, state.ts);
        }
      }
    } catch (_) { /* swallow instrumentation errors */ }

    console.log(JSON.stringify(instruction, null, 2));
  } catch (e) {
    // Fail-safe: output a fail instruction, never crash
    console.log(JSON.stringify({ action: 'fail', reason: 'scheduler_error: ' + e.message }));
  }
}

// ---- Exports (for testing) ----
module.exports = {
  // Decision logic
  decideNext,
  _evaluateGlobalStage,
  _evaluateImplementation,
  _collectReadyCodingJobs,
  _evaluateVerification,
  _evaluateVerificationSubStage,
  _evaluateVerificationFix,
  _checkGlobalUpstream,
  _checkStaleRuns,
  _buildGlobalDispatch,
  _buildJobDispatch,
  _buildJobRetry,
  _buildVerificationDispatch,
  _buildVerificationRetry,
  _buildGlobalPromptHint,
  _buildJobPromptHint,
  _buildVerificationPromptHint,
  listCandidateTsDirs,
  GLOBAL_TO_AGENT,
  VERIFICATION_TO_AGENT
};

if (require.main === module) {
  main();
}
