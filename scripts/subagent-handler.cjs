/**
 * Pipeline Subagent Handler (cross-IDE library)
 *
 * Core state-mutation logic for the pipeline: stage transitions, marker
 * parsing, evidence persistence, file snapshots, and handoff artifact
 * recording. Imported by cli.cjs (update command).
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const SCRIPTS_DIR = __dirname;
const SPECS_DIR = path.join(PROJECT_ROOT, 'specs');

const stateLib = require(path.join(SCRIPTS_DIR, 'state.cjs'));
const configLib = require(path.join(SCRIPTS_DIR, 'config.cjs'));
const diffLib = require(path.join(SCRIPTS_DIR, 'diff.cjs'));
const markers = require(path.join(SCRIPTS_DIR, 'markers.cjs'));
const loggerModule = require(path.join(SCRIPTS_DIR, 'logger.cjs'));

const logger = loggerModule.logger;

logger.setPrefix('[subagent-handler]');

const { STAGE_STATUS, JOB_STATUS } = stateLib;
const { GLOBAL_STAGES, VERIFICATION_STAGES } = stateLib;

// ---- Target stage resolution ----

function getTargetStage(state, dispatchInfo) {
  if (dispatchInfo.scope === 'global') {
    var stageName = dispatchInfo.stageName;
    if (!state.stages) state.stages = {};
    if (!state.stages[stageName]) {
      state.stages[stageName] = stateLib.defaultStage();
    }
    return state.stages[stageName];
  }

  if (dispatchInfo.scope === 'job') {
    var job = stateLib.getJobs(state)[dispatchInfo.jobId];
    if (!job) return null;
    if (!job.coding) {
      job.coding = stateLib.defaultStage();
    }
    return job.coding;
  }

  if (dispatchInfo.scope === 'verification') {
    var ver = stateLib.getVerificationStage(state);
    if (!ver) return null;
    var cur = stateLib.getCurrentRound(ver);
    if (!cur[dispatchInfo.subStage]) {
      cur[dispatchInfo.subStage] = stateLib.defaultStage();
    }
    return cur[dispatchInfo.subStage];
  }

  return null;
}

// ---- HANDOFF artifact validation ----

/**
 * Normalize an artifact list to a deduped array of path strings.
 * Handoff artifacts may arrive as `{path}` objects (contract) or bare strings;
 * the state stores path strings only. Dedupes so mixed-shape / duplicate input
 * never leaves duplicate entries.
 *
 * @param {Array} artifacts - handoff.artifacts
 * @returns {string[]} deduped path strings
 */
function _normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < artifacts.length; i++) {
    var a = artifacts[i];
    var p = (typeof a === 'string') ? a : (a && a.path);
    if (!p) continue;
    if (seen[p]) continue;
    seen[p] = true;
    out.push(p);
  }
  return out;
}

function validateHandoffArtifacts(stageObj, handoff) {
  if (!handoff || !Array.isArray(handoff.artifacts) || handoff.artifacts.length === 0) {
    return true;
  }

  var missing = [];
  for (var i = 0; i < handoff.artifacts.length; i++) {
    var artifactPath = (typeof handoff.artifacts[i] === 'string')
      ? handoff.artifacts[i]
      : (handoff.artifacts[i] && handoff.artifacts[i].path);
    if (!artifactPath) continue;

    var absolutePath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(PROJECT_ROOT, artifactPath);

    if (!fs.existsSync(absolutePath)) {
      missing.push(artifactPath);
    }
  }

  if (missing.length > 0) {
    stageObj.markers.marker_outcome = 'FAILED';
    stageObj.markers.completed = false;
    if (!Array.isArray(stageObj.markers.validation_errors)) {
      stageObj.markers.validation_errors = [];
    }
    stageObj.markers.validation_errors.push(
      'HANDOFF artifacts not found on disk: ' + missing.join(', ')
    );
    logger.warn('HANDOFF validation failed: artifacts missing on disk', { missing: missing });
    return false;
  }

  return true;
}

// ---- Content-manifest gate ----
//
// coding (job) and wave-testing stages must emit a durable content manifest
// describing WHAT they did (changed files + symbols / AC→test trace), not just
// pass/fail markers. This gate validates only existence + parseable JSON + key
// identity fields; semantic consistency (manifest matches actual code/tests)
// is the review/evidence-verifier's responsibility.

function _validateManifestFile(manifestPath, requiredKeys) {
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'missing manifest ' + path.basename(manifestPath) };
  }
  var data;
  try {
    data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'manifest is not parseable JSON: ' + path.basename(manifestPath) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'manifest is not a JSON object: ' + path.basename(manifestPath) };
  }
  for (var i = 0; i < requiredKeys.length; i++) {
    var k = requiredKeys[i];
    if (data[k] === undefined || data[k] === null || data[k] === '') {
      return { ok: false, reason: 'manifest missing key "' + k + '"' };
    }
  }
  return { ok: true };
}

function _checkManifestGate(state, dispatchInfo) {
  if (!state || !state.ts) return null;
  var specsDir = path.join(SPECS_DIR, state.ts);
  var manifestPath = null;
  var requiredKeys = null;

  if (dispatchInfo.scope === 'job') {
    manifestPath = path.join(specsDir, 'coding-manifest-' + dispatchInfo.jobId + '.json');
    requiredKeys = ['ts', 'job_id', 'agent', 'stage'];
  } else if (dispatchInfo.scope === 'verification' && dispatchInfo.subStage === VERIFICATION_STAGES.TESTING) {
    manifestPath = path.join(specsDir, 'test-manifest.json');
    requiredKeys = ['ts', 'agent', 'stage'];
  } else {
    return null;
  }

  return _validateManifestFile(manifestPath, requiredKeys);
}

// ---- Handoff file reconciliation ----
//
// Scans the active TS specs dir for handoff-{jobId}-coding.json (or
// handoff-{agent}.json for global stages) files and closes any matching
// IN_PROGRESS stage that wasn't closed through a tracked tool_use_id.

var GLOBAL_AGENT_TO_STAGE = {
  'spec-checker': GLOBAL_STAGES.SPEC_CHECK,
  'task-decomposer': GLOBAL_STAGES.TASK_DECOMPOSE,
  'evidence-verifier': GLOBAL_STAGES.EVIDENCE_VERIFY
};

function _outcomeFromHandoff(handoff) {
  var decision = String(handoff.decision || '').toUpperCase();
  var markerOutcome = (handoff.markers && handoff.markers.marker_outcome)
    ? String(handoff.markers.marker_outcome).toUpperCase()
    : null;
  // WARN is a soft pass (code-reviewer semantics): maps to PASSED so the wave
  // can proceed. The WARN signal is preserved in markers.review_decision for
  // evidence-verifier review.
  if (markerOutcome === 'PASSED' || decision === 'PASS' || decision === 'APPROVE' || decision === 'WARN') {
    return 'PASSED';
  }
  if (markerOutcome === 'FAILED' || decision === 'FAIL' || decision === 'REJECT' || decision === 'BLOCK') {
    return 'FAILED';
  }
  return 'PASSED';
}

function _readHandoff(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    logger.warn('Failed to parse handoff file', { file: filePath, error: e.message });
    return null;
  }
}

function reconcileHandoffFiles(state, ts, projectRoot) {
  var specsDir = stateLib.resolveTSDir(ts, projectRoot);
  if (!fs.existsSync(specsDir)) return false;

  var files;
  try {
    files = fs.readdirSync(specsDir);
  } catch (e) {
    return false;
  }

  var anyClosed = false;
  // Job handoffs: handoff-{jobId}-coding.json
  var jobHandoffRe = /^handoff-(.+?)-coding\.json$/;
  // Global-stage handoffs: by agent name (legacy) or stage name (baseline-regression).
  var globalHandoffRe = /^handoff-(spec-checker|task-decomposer|evidence-verifier|baseline-regression)\.json$/;
  // Verification sub-stage handoffs: handoff-verification-{testing|review|regression|fix}.json
  var verificationHandoffRe = /^handoff-verification-(testing|review|regression|fix)\.json$/;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var filePath = path.join(specsDir, file);

    var jobMatch = file.match(jobHandoffRe);
    if (jobMatch) {
      var jobId = jobMatch[1];
      var jobs = stateLib.getJobs(state);
      var job = jobs[jobId];
      if (!job || !job.coding) continue;
      var cs = job.coding;
      if (cs.status !== stateLib.STAGE_STATUS.IN_PROGRESS) continue;

      var handoff = _readHandoff(filePath);
      if (!handoff) continue;
      var outcome = _outcomeFromHandoff(handoff);

      cs.markers = cs.markers || {};
      if (!cs.markers.marker_outcome) cs.markers.marker_outcome = outcome;
      if (!cs.markers.completed) cs.markers.completed = true;
      if (!cs.markers.self_validated) cs.markers.self_validated = true;
      if (handoff.artifacts && handoff.artifacts.length > 0 && cs.artifacts.length === 0) {
        cs.artifacts = _normalizeArtifacts(handoff.artifacts);
      }

      // Content-manifest gate for the fallback (backgrounded) path.
      if (outcome === 'PASSED') {
        var codingManifest = _validateManifestFile(
          path.join(specsDir, 'coding-manifest-' + jobId + '.json'),
          ['ts', 'job_id', 'agent', 'stage']
        );
        if (!codingManifest.ok) {
          outcome = 'FAILED';
          cs.markers.marker_outcome = 'FAILED';
          if (!Array.isArray(cs.markers.validation_errors)) cs.markers.validation_errors = [];
          cs.markers.validation_errors.push(codingManifest.reason);
        }
      }

      stateLib.setJobCodingStage(state, jobId, outcome);
      stateLib.recomputeJobStatus(state, jobId);
      anyClosed = true;
      logger.info('Closed job coding via handoff fallback', {
        jobId: jobId, outcome: outcome, file: file
      });
      continue;
    }

    var globalMatch = file.match(globalHandoffRe);
    if (globalMatch) {
      var agentName = globalMatch[1];
      // 'baseline-regression' is a stage name (not an agent name) — fall back to itself.
      var stageName = GLOBAL_AGENT_TO_STAGE[agentName] || agentName;
      if (!stageName) continue;
      var gs = state.stages && state.stages[stageName];
      if (!gs) continue;
      if (gs.status !== stateLib.STAGE_STATUS.IN_PROGRESS) continue;

      var gHandoff = _readHandoff(filePath);
      if (!gHandoff) continue;
      var gOutcome = _outcomeFromHandoff(gHandoff);

      gs.markers = gs.markers || {};
      if (!gs.markers.marker_outcome) gs.markers.marker_outcome = gOutcome;
      if (!gs.markers.completed) gs.markers.completed = true;
      if (!gs.markers.self_validated) gs.markers.self_validated = true;
      if (gHandoff.artifacts && gHandoff.artifacts.length > 0 && gs.artifacts.length === 0) {
        gs.artifacts = _normalizeArtifacts(gHandoff.artifacts);
      }

      stateLib.setGlobalStage(state, stageName, gOutcome);
      stateLib.recomputeGlobalStageStatus(state, stageName);
      anyClosed = true;
      logger.info('Closed global stage via handoff fallback', {
        stageName: stageName, outcome: gOutcome, file: file
      });
    }

    var verificationMatch = file.match(verificationHandoffRe);
    if (verificationMatch) {
      var subStage = verificationMatch[1];
      var ver = stateLib.getVerificationStage(state);
      if (!ver) continue;
      var cur = stateLib.getCurrentRound(ver);
      if (!cur || !cur[subStage]) continue;
      var sub = cur[subStage];
      if (sub.status !== stateLib.STAGE_STATUS.IN_PROGRESS) continue;

      var rHandoff = _readHandoff(filePath);
      if (!rHandoff) continue;
      var rDecision = String(rHandoff.decision || '').toUpperCase();
      var rOutcome = _outcomeFromHandoff(rHandoff);

      // WARN is a soft pass for the regression sub-stage (perf regression) and
      // the fix sub-stage (non-code failure).
      var isWarnSubStage = (rDecision === 'WARN') &&
        (subStage === 'fix' || subStage === 'regression');

      sub.markers = sub.markers || {};
      if (!sub.markers.marker_outcome) {
        sub.markers.marker_outcome = isWarnSubStage ? 'WARN' : rOutcome;
      }
      if (!sub.markers.completed) sub.markers.completed = true;
      if (!sub.markers.self_validated) sub.markers.self_validated = true;
      if (rHandoff.artifacts && rHandoff.artifacts.length > 0 && sub.artifacts.length === 0) {
        sub.artifacts = _normalizeArtifacts(rHandoff.artifacts);
      }

      // Content-manifest gate for the fallback (backgrounded) path.
      if (subStage === VERIFICATION_STAGES.TESTING && rOutcome === 'PASSED') {
        var testManifest = _validateManifestFile(
          path.join(specsDir, 'test-manifest.json'),
          ['ts', 'agent', 'stage']
        );
        if (!testManifest.ok) {
          rOutcome = 'FAILED';
          sub.markers.marker_outcome = 'FAILED';
          if (!Array.isArray(sub.markers.validation_errors)) sub.markers.validation_errors = [];
          sub.markers.validation_errors.push(testManifest.reason);
        }
      }

      // Verification loop reads sub-stage status directly.
      if (isWarnSubStage) {
        sub.status = stateLib.STAGE_STATUS.WARN;
      } else {
        sub.status = (rOutcome === 'PASSED') ? stateLib.STAGE_STATUS.PASSED : stateLib.STAGE_STATUS.FAILED;
      }
      stateLib.recomputeVerificationStatus(state);
      anyClosed = true;
      logger.info('Closed verification sub-stage via handoff fallback', {
        subStage: subStage, outcome: sub.status, file: file
      });
    }
  }

  return anyClosed;
}

// ---- Unified handler ----

/**
 * Handle a subagent stop event using the unified marker/handoff pattern.
 * Works for both global and job-level dispatches.
 */
function handleSubagentStop(state, dispatchInfo, agentType, output, exitStatus) {
  var targetStage = getTargetStage(state, dispatchInfo);
  if (!targetStage) {
    logger.error('Could not resolve target stage', { dispatchInfo: dispatchInfo });
    return;
  }

  if (!targetStage.markers || typeof targetStage.markers !== 'object') {
    targetStage.markers = {};
  }

  var ts = state.ts || '';

  var handoff = markers.parseHandoff(output);

  if (handoff) {
    if (Array.isArray(handoff.artifacts)) {
      _normalizeArtifacts(handoff.artifacts).forEach(function (p) {
        if (agentType === 'code-reviewer') {
          var lowerPath = p.toLowerCase();
          if (!lowerPath.endsWith('.md')) {
            logger.info('code-reviewer: dropping non-report artifact (not .md)', { path: p });
            return;
          }
        }
        if (targetStage.artifacts.indexOf(p) === -1) {
          targetStage.artifacts.push(p);
        }
      });
    }

    if (!validateHandoffArtifacts(targetStage, handoff)) {
      logger.warn(agentType + ' FAIL: HANDOFF artifacts not found on disk');
      _recomputeAfterStop(state, dispatchInfo);
      return;
    }

    if (handoff.markers) {
      var mk = Object.keys(handoff.markers);
      for (var i = 0; i < mk.length; i++) {
        targetStage.markers[mk[i]] = handoff.markers[mk[i]];
      }
    }

    if (agentType === 'task-decomposer' && targetStage.markers && targetStage.markers.jobs !== undefined) {
      delete targetStage.markers.jobs;
    }

    var decision = (handoff.decision || '').toUpperCase();
    // WARN is a soft pass — treat as PASSED so the wave proceeds. The WARN
    // signal is preserved in markers.review_decision (copied above) for
    // evidence-verifier review.
    var isPass = (decision === 'PASS' || decision === 'APPROVE' || decision === 'WARN');
    var isWarn = (decision === 'WARN');

    // Content-manifest gate: coding + wave testing must describe WHAT they did
    // in a durable manifest, not just pass/fail markers. Enforced only on a
    // PASS decision — a FAIL already failed for its own reason.
    var manifestGate = _checkManifestGate(state, dispatchInfo);
    if (isPass && manifestGate && manifestGate.ok === false) {
      isPass = false;
      isWarn = false;
      if (!Array.isArray(targetStage.markers.validation_errors)) {
        targetStage.markers.validation_errors = [];
      }
      targetStage.markers.validation_errors.push(manifestGate.reason);
      logger.warn(agentType + ' FAIL: content-manifest gate', {
        scope: dispatchInfo.scope, reason: manifestGate.reason
      });
    }

    if (isPass) {
      targetStage.markers.marker_outcome = 'PASSED';
      targetStage.markers.completed = true;
      targetStage.markers.self_validated = true;
      if (isWarn) {
        logger.info(agentType + ' WARN (soft pass) (handoff JSON)', { scope: dispatchInfo.scope });
      } else {
        logger.info(agentType + ' PASS (handoff JSON)', { scope: dispatchInfo.scope });
      }
    } else {
      targetStage.markers.marker_outcome = 'FAILED';
      targetStage.markers.completed = false;
      logger.warn(agentType + ' ' + (decision || 'FAIL') + ' (handoff JSON)', { scope: dispatchInfo.scope });
    }

    // Verification sub-stage: the verification loop reads sub-stage STATUS directly
    // (not markers). fix + WARN is a non-code failure → sub-stage WARN, which
    // recomputeVerificationStatus maps to the node-level WARN (soft pass).
    if (dispatchInfo.scope === 'verification') {
      // WARN is a soft pass for the regression sub-stage (perf regression) and
      // the fix sub-stage (non-code failure). Both map the verification node to
      // WARN via recomputeVerificationStatus. Other sub-stages stay PASS/FAIL.
      var isWarnSubStage = isWarn &&
        (dispatchInfo.subStage === VERIFICATION_STAGES.FIX ||
         dispatchInfo.subStage === VERIFICATION_STAGES.REGRESSION);
      if (isWarnSubStage) {
        targetStage.markers.marker_outcome = 'WARN';
        targetStage.status = STAGE_STATUS.WARN;
      } else if (isPass) {
        targetStage.status = STAGE_STATUS.PASSED;
      } else {
        targetStage.status = STAGE_STATUS.FAILED;
      }
      targetStage.completed_at = new Date().toISOString();
    }

    if (agentType === 'task-decomposer' && isPass) {
      var cycle = _initJobsFromHandoff(state, handoff);
      if (cycle) {
        // Job dependency cycle — override the PASS decision.
        targetStage.markers.marker_outcome = 'FAILED';
        targetStage.markers.completed = false;
        if (!Array.isArray(targetStage.markers.validation_errors)) {
          targetStage.markers.validation_errors = [];
        }
        targetStage.markers.validation_errors.push('Job dependency cycle: ' + cycle.join(' -> '));
        logger.warn('task-decomposer FAIL: job dependency cycle', { cycle: cycle });
      }
    }

    if (agentType === 'evidence-verifier' && isPass) {
      targetStage.changed_files_snapshot = diffLib.changedFiles(PROJECT_ROOT);
      targetStage.reverify_hash = null;

      var hasReport = false;
      for (var ai = 0; ai < targetStage.artifacts.length; ai++) {
        var aiStr = (typeof targetStage.artifacts[ai] === 'string')
          ? targetStage.artifacts[ai]
          : (targetStage.artifacts[ai] && targetStage.artifacts[ai].path) || '';
        if (aiStr.indexOf('verification-report.md') !== -1) {
          hasReport = true;
          break;
        }
      }
      if (!hasReport) {
        targetStage.artifacts.push('specs/' + ts + '/verification-report.md');
      }
    }

    if (agentType === 'code-reviewer' && isPass) {
      var reportFilename = 'review-report.md';
      var reportPath = 'specs/' + ts + '/' + reportFilename;
      var hasReviewReport = false;
      for (var rai = 0; rai < targetStage.artifacts.length; rai++) {
        var raiStr = (typeof targetStage.artifacts[rai] === 'string')
          ? targetStage.artifacts[rai]
          : (targetStage.artifacts[rai] && targetStage.artifacts[rai].path) || '';
        if (raiStr.indexOf(reportFilename) !== -1) {
          hasReviewReport = true;
          break;
        }
      }
      if (!hasReviewReport) {
        targetStage.artifacts.push(reportPath);
      }
    }

    _recomputeAfterStop(state, dispatchInfo);

    return;
  }

  // No HANDOFF JSON — fail-safe
  targetStage.markers.marker_outcome = 'FAILED';
  targetStage.markers.validation_errors = [
    'No HANDOFF JSON block found in agent output — agents must produce HANDOFF_BEGIN...HANDOFF_END'
  ];
  logger.warn(agentType + ' FAIL: no HANDOFF JSON in output', { scope: dispatchInfo.scope });

  _recomputeAfterStop(state, dispatchInfo);
}

/**
 * Initialize jobs from task-decomposer handoff.
 */
function _initJobsFromHandoff(state, handoff) {
  // Returns null on success (or when there is nothing to init), or a cycle
  // array when the manifest's depends_on graph contains a cycle.
  var result = null;

  var jobsData = handoff.markers ? handoff.markers.jobs : null;
  if (Array.isArray(jobsData) && jobsData.length > 0) {
    result = stateLib.initJobsFromManifest(state, { ts: state.ts, jobs: jobsData });
  } else {
    var manifestPath = path.join(SPECS_DIR, state.ts, 'job-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest && Array.isArray(manifest.jobs)) {
          result = stateLib.initJobsFromManifest(state, manifest);
        }
      } catch (e) {
        logger.error('Failed to parse job-manifest.json', { error: e.message });
      }
    }
  }

  if (result && result.ok) {
    logger.info('Jobs initialized from task-decomposer', {
      jobCount: result.count
    });
    return null;
  }
  if (result && result.cycle) {
    return result.cycle;
  }
  return null;
}

/**
 * Recompute the appropriate stage status after a subagent stop.
 */
function _recomputeAfterStop(state, dispatchInfo) {
  if (dispatchInfo.scope === 'global') {
    stateLib.recomputeGlobalStageStatus(state, dispatchInfo.stageName);
  } else if (dispatchInfo.scope === 'job') {
    stateLib.recomputeJobCodingStatus(state, dispatchInfo.jobId);
    stateLib.recomputeJobStatus(state, dispatchInfo.jobId);
  } else if (dispatchInfo.scope === 'verification') {
    stateLib.recomputeVerificationStatus(state);
  }
}

// ---- Exports ----

module.exports = {
  getTargetStage,
  handleSubagentStop,
  reconcileHandoffFiles,
  validateHandoffArtifacts,
  _checkManifestGate,
  _validateManifestFile,
  _initJobsFromHandoff,
  _recomputeAfterStop,
  _outcomeFromHandoff,
  _readHandoff
};
