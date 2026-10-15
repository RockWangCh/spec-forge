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

// best-effort event logger (non-fatal)
let eventLogger = null;
try {
  eventLogger = require('./event-logger.cjs');
} catch (e) {
  eventLogger = null;
}

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

// ... (rest of file unchanged up to main) ...

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
