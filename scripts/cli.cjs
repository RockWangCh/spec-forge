#!/usr/bin/env node
/**
 * spec-forge — Unified CLI (cross-IDE, no hooks)
 *
 * Subcommands: init, resume, update, report, verify, perf-compare, commit.
 * All commands emit JSON to stdout on success and exit 0; errors go to stderr
 * with exit code 1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const SCRIPTS_DIR = __dirname;

const stateLib = require(path.join(SCRIPTS_DIR, 'state.cjs'));
const configLib = require(path.join(SCRIPTS_DIR, 'config.cjs'));
const sessionLib = require(path.join(SCRIPTS_DIR, 'session.cjs'));
const subagentStop = require(path.join(SCRIPTS_DIR, 'subagent-handler.cjs'));
const loggerModule = require(path.join(SCRIPTS_DIR, 'logger.cjs'));
const dispatchScope = require(path.join(SCRIPTS_DIR, 'dispatch-scope.cjs'));
const perfLib = require(path.join(SCRIPTS_DIR, 'perf.cjs'));
const diffLib = require(path.join(SCRIPTS_DIR, 'diff.cjs'));

const logger = loggerModule.logger;

// ============================================================
// Command: init
// ============================================================

function generateTs() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = [
    now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
    '-', pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())
  ].join('');
  const rand = Math.random().toString(36).substring(2, 6);
  return base + '-' + rand;
}

function cmdInit(args) {
  logger.setPrefix('[init]');
  // --ts=<TS>       → create a NEW pipeline with an explicit TS (must not already exist)
  // --auto-commit   → opt into auto-commit at pipeline completion
  // no --ts         → create a fresh pipeline (auto-generated TS)
  let explicitTs = null;
  let autoCommit = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--ts=')) explicitTs = args[i].slice('--ts='.length);
    else if (args[i] === '--ts' && i + 1 < args.length) explicitTs = args[++i];
    else if (args[i] === '--auto-commit') autoCommit = true;
  }

  try {
    const result = createPipeline(explicitTs, autoCommit);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write('ERROR: ' + e.message + '\n');
    process.exit(1);
  }
}

function createPipeline(explicitTs, autoCommit) {
  const ts = explicitTs || generateTs();
  const tsDir = stateLib.resolveTSDir(ts, PROJECT_ROOT);
  if (fs.existsSync(tsDir)) {
    throw new Error('TS already exists: ' + ts + ' (' + tsDir + '). Use `cli.cjs resume --ts=' + ts + '` to resume it.');
  }
  const specsDir = path.join(PROJECT_ROOT, 'specs');
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(tsDir, { recursive: true });

  const sessionId = 'pipeline-' + ts;
  const state = stateLib.defaultState(sessionId, ts);
  state.ts = ts;
  state.session_id = sessionId;
  state.turn_started_at = new Date().toISOString();
  state.ts_created_at = new Date().toISOString();
  state.ts_lifecycle = 'active';
  state.auto_commit = !!autoCommit;
  stateLib.save(state, ts, PROJECT_ROOT);

  sessionLib.writeSessionActiveTS(ts, PROJECT_ROOT);

  logger.setLogPath(ts);
  const logFile = path.join(tsDir, 'pipeline.log');
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile,
      new Date().toISOString() + ' [init] [INFO] Pipeline initialized {ts:"' + ts + '"}\n',
      'utf8');
  }
  return { ok: true, ts: ts, mode: 'created', auto_commit: state.auto_commit };
}

function resumePipeline(ts, autoCommit) {
  const tsDir = stateLib.resolveTSDir(ts, PROJECT_ROOT);
  if (!fs.existsSync(tsDir)) throw new Error('TS directory not found: ' + tsDir);
  const stateFile = path.join(tsDir, 'state.json');
  if (!fs.existsSync(stateFile)) throw new Error('state.json not found in TS dir: ' + tsDir);
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (e) { throw new Error('state.json corrupt: ' + e.message); }
  if (state.ts !== ts) throw new Error('TS mismatch: state.ts=' + state.ts + ' but requested=' + ts);
  if (autoCommit && state.auto_commit !== true) {
    state.auto_commit = true;
    stateLib.save(state, ts, PROJECT_ROOT);
  }
  sessionLib.writeSessionActiveTS(ts, PROJECT_ROOT);
  logger.setLogPath(ts);
  logger.info('Pipeline resumed', { ts: ts });
  return { ok: true, ts: ts, mode: 'resumed', auto_commit: !!state.auto_commit };
}

// ============================================================
// Command: resume
// ============================================================

function cmdResume(args) {
  logger.setPrefix('[resume]');
  // --ts=<TS>       → resume a specific pipeline (state.json must exist)
  // --latest        → resume the newest TS dir by mtime (crash recovery)
  // --auto-commit   → opt into / upgrade auto-commit
  // TS resolution: --ts flag > --latest > session marker (Claude Code only).
  let tsArg = null, latest = false, autoCommit = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--ts=')) tsArg = args[i].slice('--ts='.length);
    else if (args[i] === '--ts' && i + 1 < args.length) tsArg = args[++i];
    else if (args[i] === '--latest') latest = true;
    else if (args[i] === '--auto-commit') autoCommit = true;
  }
  const ts = tsArg || (latest ? findLatestTs(PROJECT_ROOT) : null) || sessionLib.readSessionActiveTS(PROJECT_ROOT);
  if (!ts) {
    process.stderr.write('ERROR: no TS. Pass --ts=<TS>, --latest, or run `cli.cjs init` first.\n');
    process.exit(1);
    return;
  }
  try {
    const result = resumePipeline(ts, autoCommit);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write('ERROR: ' + e.message + '\n');
    process.exit(1);
  }
}

// ============================================================
// Command: update
// ============================================================

function parseUpdateArgs(argv) {
  const args = { _: [], ts: null, agent: null, description: '', outputFile: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--ts=')) args.ts = a.slice('--ts='.length);
    else if (a.startsWith('--agent=')) args.agent = a.slice('--agent='.length);
    else if (a.startsWith('--description=')) args.description = a.slice('--description='.length);
    else if (a.startsWith('--output-file=')) args.outputFile = a.slice('--output-file='.length);
    else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
    else if (a === '--ts' && i + 1 < argv.length) args.ts = argv[++i];
    else if (a === '--agent' && i + 1 < argv.length) args.agent = argv[++i];
    else if (a === '--description' && i + 1 < argv.length) args.description = argv[++i];
    else if (a === '--output-file' && i + 1 < argv.length) args.outputFile = argv[++i];
    else if (a === '--output' && i + 1 < argv.length) args.output = argv[++i];
    else args._.push(a);
  }
  return args;
}

function readAgentOutput(args, stdinData) {
  if (args.output != null) return args.output;
  if (args.outputFile) {
    const abs = path.isAbsolute(args.outputFile)
      ? args.outputFile : path.resolve(PROJECT_ROOT, args.outputFile);
    if (!fs.existsSync(abs)) throw new Error('Output file not found: ' + abs);
    return fs.readFileSync(abs, 'utf8');
  }
  if (stdinData && stdinData.trim()) return stdinData;
  return '';
}

function normalizeHandoffText(text) {
  if (!text || typeof text !== 'string') return text || '';
  if (text.indexOf('HANDOFF_BEGIN') !== -1) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && (obj.decision || obj.artifacts || obj.markers)) {
      return 'HANDOFF_BEGIN\n' + trimmed + '\nHANDOFF_END';
    }
  } catch (_) { /* not JSON */ }
  return text;
}

function cmdUpdate(args) {
  logger.setPrefix('[update-state]');
  const parsed = parseUpdateArgs(args);
  if (!parsed.agent) {
    process.stderr.write('ERROR: --agent is required\n');
    process.stderr.write('Usage: cli.cjs update --agent=<type> --description="TS=... GLOBAL=..." [--output-file=<path> | --output=<text>]\n');
    process.exit(1);
    return;
  }

  let stdinData = '';
  if (!parsed.output && !parsed.outputFile && !process.stdin.isTTY) {
    try { stdinData = fs.readFileSync(0, 'utf8'); } catch (_) { /* ignore */ }
  }

  let output;
  try {
    output = readAgentOutput(parsed, stdinData);
    output = normalizeHandoffText(output);
  } catch (e) {
    process.stderr.write('ERROR: ' + e.message + '\n');
    process.exit(1);
    return;
  }

  // TS resolution: --ts flag > description "TS=…" > session marker (Claude Code only).
  // --ts 与 description 同时给出时交叉校验，mismatch 直接 fail-fast（不再有静默获胜方）。
  const tsFromArg = parsed.ts;
  const tsFromDesc = dispatchScope.extractTs(parsed.description);
  if (tsFromArg && tsFromDesc && tsFromArg !== tsFromDesc) {
    process.stderr.write('ERROR: TS mismatch -- --ts="' + tsFromArg + '" vs description TS="' + tsFromDesc + '". Copy the TS verbatim from init output / instruction.\n');
    process.exit(1);
    return;
  }
  let ts = tsFromArg || tsFromDesc || sessionLib.readSessionActiveTS(PROJECT_ROOT);
  if (!ts) {
    process.stderr.write('ERROR: no TS provided. Pass --ts=<TS> (or TS=… in --description), or run `cli.cjs init` first.\n');
    process.exit(1);
    return;
  }
  logger.setLogPath(ts);

  let state;
  try { state = stateLib.load(ts, PROJECT_ROOT); }
  catch (e) {
    process.stderr.write('ERROR: failed to load state.json: ' + e.message + '\n');
    process.exit(1);
    return;
  }
  stateLib.ensureTsLifecycle(state);
  if (state.ts !== ts) state.ts = ts;

  const dispatchInfo = dispatchScope.decode(parsed.description);
  if (dispatchInfo.scope === 'unknown') {
    const globalMap = configLib.AGENT_TO_GLOBAL_STAGE;
    if (globalMap[parsed.agent]) {
      dispatchInfo.scope = 'global';
      dispatchInfo.stageName = globalMap[parsed.agent];
    } else {
      process.stderr.write('ERROR: cannot resolve dispatch scope from description. Include JOB=<id> STAGE=coding for job-level agents.\n');
      process.stderr.write('Description was: ' + parsed.description + '\n');
      process.exit(1);
      return;
    }
  }

  // Call the handler — updates markers, artifacts, recomputes stage status.
  subagentStop.handleSubagentStop(state, dispatchInfo, parsed.agent, output, 'completed');

  // Sweep for unprocessed handoff files.
  subagentStop.reconcileHandoffFiles(state, ts, PROJECT_ROOT);

  // Complete the most recent IN_PROGRESS run for this stage.
  const targetStage = subagentStop.getTargetStage(state, dispatchInfo);
  let runCompleted = false;
  if (targetStage && Array.isArray(targetStage.runs)) {
    const now = new Date().toISOString();
    for (let i = targetStage.runs.length - 1; i >= 0; i--) {
      if (targetStage.runs[i].outcome === 'IN_PROGRESS') {
        targetStage.runs[i].outcome = (targetStage.markers && targetStage.markers.marker_outcome) || 'PASSED';
        targetStage.runs[i].stopped_at = now;
        targetStage.runs[i].exit_status = 'completed';
        runCompleted = true;
        break;
      }
    }
  }
  if (!runCompleted && targetStage && Array.isArray(targetStage.runs)) {
    const outcome = (targetStage.markers && targetStage.markers.marker_outcome) || 'PASSED';
    // Fall back to the stage's started_at, then the completion timestamp.
    const runStartedAt = targetStage.started_at || new Date().toISOString();
    targetStage.runs.push({
      agent_type: parsed.agent,
      agent_id: 'cli-' + Date.now(),
      outcome: outcome,
      started_at: runStartedAt,
      stopped_at: new Date().toISOString(),
      exit_status: 'completed',
      source: 'update-state'
    });
  }

  // If all mandatory stages have PASSED or WARN, mark the TS as completed.
  if (stateLib.allMandatoryStagesPassedOrWarned(state) && state.ts_lifecycle !== 'completed') {
    stateLib.markTsCompleted(state);
  }

  try { stateLib.save(state, ts, PROJECT_ROOT); }
  catch (e) {
    process.stderr.write('ERROR: failed to save state.json: ' + e.message + '\n');
    process.exit(1);
    return;
  }

  // Auto-commit: if the pipeline just completed and the user opted in via
  // `--auto-commit`, commit now — no manual epilogue needed. Best-effort:
  // a skipped/failed commit never fails this update. `already-committed`
  // makes manual `cli.cjs commit` retries idempotent.
  let autoCommit = null;
  if (state.ts_lifecycle === 'completed' && state.auto_commit) {
    try {
      autoCommit = performCommit(state, ts, null, PROJECT_ROOT);
      if (autoCommit.error) {
        process.stderr.write('[auto-commit] WARNING: ' + autoCommit.error + '\n');
      }
    } catch (e) {
      autoCommit = { ok: true, committed: false, error: String(e && e.message ? e.message : e) };
      process.stderr.write('[auto-commit] WARNING: ' + autoCommit.error + '\n');
    }
  }

  const summary = {
    ok: true,
    ts: ts,
    scope: dispatchInfo.scope,
    stage: (dispatchInfo.scope === 'global' || dispatchInfo.scope === 'verification')
      ? dispatchInfo.stageName
      : (dispatchInfo.scope === 'job' ? 'coding' : null),
    sub_stage: dispatchInfo.scope === 'verification' ? dispatchInfo.subStage : null,
    job_id: dispatchInfo.scope === 'job' ? dispatchInfo.jobId : null,
    agent: parsed.agent,
    status: targetStage ? targetStage.status : null,
    marker_outcome: targetStage && targetStage.markers ? targetStage.markers.marker_outcome : null,
    artifacts: targetStage ? targetStage.artifacts : [],
    commit: autoCommit
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

// ============================================================
// Command: report
// ============================================================

function fmtStage(name, st) {
  const lines = [];
  lines.push('  [' + (st.status || 'UNKNOWN') + '] ' + name);
  if (st.attempt_count) lines.push('    attempts: ' + st.attempt_count);
  if (st.started_at) lines.push('    started: ' + st.started_at);
  if (st.completed_at) lines.push('    completed: ' + st.completed_at);
  if (st.markers && Object.keys(st.markers).length > 0) {
    lines.push('    markers:');
    for (const k of Object.keys(st.markers)) {
      const v = st.markers[k];
      const vs = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      lines.push('      ' + k + ': ' + vs);
    }
  }
  if (st.artifacts && st.artifacts.length > 0) {
    lines.push('    artifacts:');
    for (const a of st.artifacts) lines.push('      - ' + a);
  }
  if (st.runs && st.runs.length > 0) {
    lines.push('    runs:');
    for (const r of st.runs) {
      lines.push('      - agent=' + (r.agent_type || '?') +
                  ' outcome=' + (r.outcome || '?') +
                  ' stopped=' + (r.stopped_at || '?'));
    }
  }
  return lines.join('\n');
}

function fmtJob(jobId, job) {
  const lines = [];
  lines.push('  [' + (job.status || 'UNKNOWN') + '] ' + jobId + (job.layer ? ' (layer=' + job.layer + ')' : ''));
  if (job.description) lines.push('    desc: ' + job.description);
  if (job.files && job.files.length) lines.push('    files: ' + job.files.join(', '));
  if (job.produces && job.produces.length) lines.push('    produces: ' + job.produces.join(', '));
  if (job.depends_on && job.depends_on.length) lines.push('    depends_on: ' + job.depends_on.join(', '));
  if (job.coding) {
    const c = job.coding;
    lines.push('    [' + (c.status || 'UNKNOWN') + '] coding');
    if (c.markers && c.markers.marker_outcome) lines.push('      outcome: ' + c.markers.marker_outcome);
    if (c.artifacts && c.artifacts.length) {
      lines.push('      artifacts:');
      for (const a of c.artifacts) lines.push('        - ' + a);
    }
  }
  return lines.join('\n');
}

/**
 * Find the most recently modified TS directory under specs/.
 *
 * 崩溃/上下文压缩后的恢复通道：`.active` 移除后没有全局指针，主 agent 若忘了
 * TS，用 `--latest` 按 mtime 找回最新 pipeline。
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
function findLatestTs(projectRoot) {
  const specsDir = path.join(projectRoot, 'specs');
  if (!fs.existsSync(specsDir)) return null;
  const tsRe = /^\d{8}-\d{6}(?:-[a-z0-9]{4})?$/;
  let best = null;
  let bestMtime = -1;
  let entries;
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !tsRe.test(e.name)) continue;
    try {
      const st = fs.statSync(path.join(specsDir, e.name));
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = e.name;
      }
    } catch (_) { /* skip unreadable dir */ }
  }
  return best;
}

function cmdReport(args) {
  logger.setPrefix('[report]');
  let tsArg = null, jsonOnly = false, latest = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--ts=')) tsArg = args[i].slice('--ts='.length);
    else if (args[i] === '--ts' && i + 1 < args.length) tsArg = args[++i];
    else if (args[i] === '--json') jsonOnly = true;
    else if (args[i] === '--latest') latest = true;
  }

  // TS resolution: --ts flag > --latest (newest TS dir by mtime) > session marker.
  const ts = tsArg || (latest ? findLatestTs(PROJECT_ROOT) : null) || sessionLib.readSessionActiveTS(PROJECT_ROOT);
  if (!ts) {
    process.stderr.write('ERROR: no TS. Pass --ts=<TS>, --latest, or run `cli.cjs init` first.\n');
    process.exit(1);
    return;
  }

  let pipeState;
  try { pipeState = stateLib.load(ts, PROJECT_ROOT); }
  catch (e) {
    process.stderr.write('ERROR: failed to load state.json: ' + e.message + '\n');
    process.exit(1);
    return;
  }

  if (jsonOnly) {
    process.stdout.write(JSON.stringify({
      ts: ts,
      pipeline_status: (function () {
        const gs = pipeState.stages || {};
        const order = stateLib.GLOBAL_STAGE_ORDER;
        let allPassed = true, anyFailed = false;
        for (const n of order) {
          const s = gs[n];
          if (!s) { allPassed = false; continue; }
          if (s.status !== 'PASSED' && s.status !== 'WARN') allPassed = false;
          if (s.status === 'FAILED') anyFailed = true;
        }
        if (allPassed) return 'COMPLETE';
        if (anyFailed) return 'FAILED';
        return 'IN_PROGRESS';
      })(),
      completion_blocked: pipeState.completion_blocked,
      completion_block_reason: pipeState.completion_block_reason,
      auto_commit: !!pipeState.auto_commit,
      commit: pipeState.commit || null,
      stages: pipeState.stages,
      jobs: stateLib.getJobs(pipeState)
    }, null, 2) + '\n');
    process.exit(0);
    return;
  }

  const out = [];
  out.push('=== PIPELINE REPORT ===');
  out.push('TS: ' + ts);
  out.push('');
  out.push('=== GLOBAL STAGES ===');
  const gs = pipeState.stages || {};
  for (const n of stateLib.GLOBAL_STAGE_ORDER) {
    const s = gs[n];
    if (!s) { out.push('  [MISSING] ' + n); continue; }
    out.push(fmtStage(n, s));
  }
  out.push('');
  out.push('=== JOBS ===');
  const jobsMap = stateLib.getJobs(pipeState);
  const jobIds = Object.keys(jobsMap);
  if (jobIds.length > 0) {
    for (let j = 0; j < jobIds.length; j++) {
      out.push(fmtJob(jobIds[j], jobsMap[jobIds[j]]));
    }
  } else {
    out.push('  (none)');
  }
  out.push('');
  out.push('=== COMPLETION GATE ===');
  if (pipeState.completion_blocked) out.push('  BLOCKED: ' + (pipeState.completion_block_reason || '(no reason)'));
  else out.push('  Not blocked');
  out.push('');
  out.push('=== COMMIT ===');
  if (pipeState.auto_commit) {
    const c = pipeState.commit;
    if (c && c.status === 'committed') out.push('  committed: ' + (c.hash || '(no hash)'));
    else if (c && c.status === 'failed') out.push('  commit failed: ' + c.reason);
    else if (c && c.status === 'skipped') out.push('  commit skipped: ' + c.reason);
    else out.push('  enabled, not yet attempted');
  } else {
    out.push('  auto-commit not enabled');
  }
  out.push('');

  const order = stateLib.GLOBAL_STAGE_ORDER;
  let allPassed = true, anyFailed = false, firstFailed = null;
  for (const n of order) {
    const s = gs[n];
    if (!s || (s.status !== 'PASSED' && s.status !== 'WARN')) allPassed = false;
    if (s && s.status === 'FAILED' && !firstFailed) firstFailed = n;
  }
  out.push('=== OVERALL ===');
  if (allPassed) out.push('  Status: COMPLETE');
  else if (firstFailed) out.push('  Status: FAILED (first failed stage: ' + firstFailed + ')');
  else out.push('  Status: IN_PROGRESS');

  process.stdout.write(out.join('\n') + '\n');
  process.exit(allPassed && !pipeState.completion_blocked ? 0 : 1);
}

// ============================================================
// Command: verify
// ============================================================

function resolveAbs(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function verifyPaths(paths) {
  const missing = [];
  for (const p of paths) {
    const abs = resolveAbs(p);
    if (!abs) continue;
    if (!fs.existsSync(abs)) missing.push(abs);
  }
  return { ok: missing.length === 0, checked: paths.length, missing: missing };
}

function cmdVerify(args) {
  logger.setPrefix('[verify]');
  let paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--handoff=')) {
      const handoffPath = a.slice('--handoff='.length);
      const abs = resolveAbs(handoffPath);
      if (!fs.existsSync(abs)) {
        process.stderr.write('ERROR: handoff file not found: ' + abs + '\n');
        process.exit(1);
        return;
      }
      try {
        const handoff = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (Array.isArray(handoff.artifacts)) {
          for (const art of handoff.artifacts) {
            if (art && typeof art.path === 'string') paths.push(art.path);
          }
        }
      } catch (e) {
        process.stderr.write('ERROR: failed to parse handoff JSON: ' + e.message + '\n');
        process.exit(1);
        return;
      }
    } else if (a === '--handoff' && i + 1 < args.length) {
      args[i + 1] = '--handoff=' + args[i + 1]; // normalize
    } else if (!a.startsWith('-')) {
      paths.push(a);
    }
  }

  if (paths.length === 0) {
    process.stderr.write('Usage: cli.cjs verify <path1> <path2> ... | --handoff=<path>\n');
    process.exit(1);
    return;
  }

  const result = verifyPaths(paths);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

// ============================================================
// Command: perf-compare
// ============================================================

function cmdPerfCompare(args) {
  logger.setPrefix('[perf-compare]');
  let baselinePath = null, finalPath = null, thresholdsJson = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--baseline=')) baselinePath = a.slice('--baseline='.length);
    else if (a === '--baseline' && i + 1 < args.length) baselinePath = args[++i];
    else if (a.startsWith('--final=')) finalPath = a.slice('--final='.length);
    else if (a === '--final' && i + 1 < args.length) finalPath = args[++i];
    else if (a.startsWith('--thresholds=')) thresholdsJson = a.slice('--thresholds='.length);
    else if (a === '--thresholds' && i + 1 < args.length) thresholdsJson = args[++i];
  }

  if (!baselinePath || !finalPath) {
    process.stderr.write('Usage: cli.cjs perf-compare --baseline=<path> --final=<path> [--thresholds=<json>]\n');
    process.exit(1);
    return;
  }

  let thresholds = null;
  if (thresholdsJson) {
    try { thresholds = JSON.parse(thresholdsJson); }
    catch (e) {
      process.stderr.write('ERROR: invalid --thresholds JSON: ' + e.message + '\n');
      process.exit(1);
      return;
    }
  }

  const baseline = perfLib.readStatisticsFile(resolveAbs(baselinePath));
  if (!baseline) {
    process.stderr.write('ERROR: could not read/parse baseline statistics: ' + baselinePath + '\n');
    process.exit(1);
    return;
  }
  const final = perfLib.readStatisticsFile(resolveAbs(finalPath));
  if (!final) {
    process.stderr.write('ERROR: could not read/parse final statistics: ' + finalPath + '\n');
    process.exit(1);
    return;
  }

  const result = perfLib.comparePerf(baseline, final, thresholds);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  // WARN is a soft pass, not a hard error — exit 0 on any successful comparison.
  process.exit(0);
}

// ============================================================
// Command: commit (auto-commit core — shared with the automatic trigger in
// cmdUpdate; the CLI command is a manual retry channel)
// ============================================================

const GIT_AUTHOR_NAME = 'spec-forge';
const GIT_AUTHOR_EMAIL = 'noreply@spec-forge';

function gitConfig(key, cwd) {
  try { return execFileSync('git', ['config', key], { stdio: 'pipe', encoding: 'utf8', cwd: cwd }).trim(); }
  catch (_) { return ''; }
}

function isSpecsPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  return norm === 'specs' || norm.startsWith('specs/');
}

function readSpecTitle(state, projectRoot) {
  // Deterministic fallback subject — read `### Title` from specs/{TS}/spec.md.
  const specMd = path.join(stateLib.resolveTSDir(state.ts, projectRoot), 'spec.md');
  try {
    const raw = fs.readFileSync(specMd, 'utf8');
    const m = raw.match(/^###\s*Title\s*\n+\s*(.+?)\s*$/m);
    if (m && m[1]) return m[1].trim();
  } catch (_) { /* no spec.md */ }
  return '';
}

function buildFallbackMessage(state, projectRoot) {
  const title = readSpecTitle(state, projectRoot);
  return title ? (title + '\n') : 'chore: spec-forge changes\n';
}

// Auto-commit core — shared by `commit` command and the automatic trigger in
// cmdUpdate (pipeline completion). Best-effort: NEVER throws, never exits the
// process, and never flips a PASSED pipeline to FAILED. Returns a result object.
function performCommit(state, ts, message, projectRoot) {
  const result = { ok: true, committed: false };
  if (!state.auto_commit) {
    result.skipped = 'auto-commit-not-enabled';
    return result;
  }
  if (state.commit && state.commit.status === 'committed') {
    result.skipped = 'already-committed';
    result.hash = state.commit.hash;
    return result;
  }
  if (!diffLib.isGitRepo(projectRoot)) {
    state.commit = { status: 'skipped', reason: 'not-a-git-repo', attempted_at: new Date().toISOString() };
    try { stateLib.save(state, ts, projectRoot); } catch (_) { /* best-effort */ }
    result.skipped = 'not-a-git-repo';
    return result;
  }

  const changed = (diffLib.changedFiles(projectRoot) || [])
    .filter(function (p) { return !isSpecsPath(p); });

  if (changed.length === 0) {
    state.commit = { status: 'skipped', reason: 'nothing-to-commit', attempted_at: new Date().toISOString() };
    try { stateLib.save(state, ts, projectRoot); } catch (_) { /* best-effort */ }
    result.skipped = 'nothing-to-commit';
    return result;
  }

  const body = message || buildFallbackMessage(state, projectRoot);
  const fullMessage = body.replace(/\s+$/, '') + '\n\nGenerated-by: spec-forge';

  try {
    execFileSync('git', ['add', '--'].concat(changed), { stdio: 'pipe', cwd: projectRoot });

    const identityArgs = [];
    if (!gitConfig('user.name', projectRoot)) identityArgs.push('-c', 'user.name=' + GIT_AUTHOR_NAME);
    if (!gitConfig('user.email', projectRoot)) identityArgs.push('-c', 'user.email=' + GIT_AUTHOR_EMAIL);

    execFileSync('git', identityArgs.concat(['commit', '-m', fullMessage]), { stdio: 'pipe', cwd: projectRoot });

    let hash = '';
    try { hash = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8', cwd: projectRoot }).trim(); } catch (_) { /* hash optional */ }

    state.commit = { status: 'committed', hash: hash, message: fullMessage, committed_at: new Date().toISOString() };
    try { stateLib.save(state, ts, projectRoot); } catch (_) { /* best-effort */ }
    result.committed = true;
    result.hash = hash;
    return result;
  } catch (e) {
    state.commit = { status: 'failed', reason: String(e && e.message ? e.message : e), attempted_at: new Date().toISOString() };
    try { stateLib.save(state, ts, projectRoot); } catch (_) { /* best-effort */ }
    result.error = String(e && e.message ? e.message : e);
    return result;
  }
}

function cmdCommit(args) {
  logger.setPrefix('[commit]');
  let message = null, checkOnly = false, tsArg = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--message=')) message = a.slice('--message='.length);
    else if (a === '--message' && i + 1 < args.length) message = args[++i];
    else if (a === '--check') checkOnly = true;
    else if (a.startsWith('--ts=')) tsArg = a.slice('--ts='.length);
    else if (a === '--ts' && i + 1 < args.length) tsArg = args[++i];
  }

  // TS resolution: --ts flag > session marker (Claude Code only).
  const ts = tsArg || sessionLib.readSessionActiveTS(PROJECT_ROOT);
  if (!ts) {
    process.stderr.write('ERROR: no TS. Pass --ts=<TS>, or run `cli.cjs init` first.\n');
    process.exit(1);
    return;
  }

  let state;
  try { state = stateLib.load(ts, PROJECT_ROOT); }
  catch (e) {
    process.stderr.write('ERROR: failed to load state.json: ' + e.message + '\n');
    process.exit(1);
    return;
  }

  if (checkOnly) {
    process.stdout.write(JSON.stringify({
      enabled: !!state.auto_commit,
      completed: state.ts_lifecycle === 'completed'
    }) + '\n');
    process.exit(0);
    return;
  }

  // Best-effort epilogue — a skipped/failed commit never exits non-zero.
  const result = performCommit(state, ts, message, PROJECT_ROOT);
  if (result.error) {
    process.stderr.write('[commit] WARNING: auto-commit failed: ' + result.error + '\n');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

// ============================================================
// Main dispatcher
// ============================================================

function printUsage() {
  const msg = [
    'spec-forge CLI — unified entry point',
    '',
    'Usage:',
    '  cli.cjs init [--ts=<TS>] [--auto-commit]  Create a NEW pipeline (--ts = explicit TS; errors if it already exists)',
    '  cli.cjs resume --ts=<TS> [--latest] [--auto-commit]  Resume an existing pipeline (--latest = newest TS dir by mtime; fallback session marker)',
    '  cli.cjs update --agent=<type> --description="TS=... GLOBAL=..." [--ts=<TS>] [--output-file=<path> | --output=<text>]',
    '                                            Persist agent outcome → state.json (--ts optional; falls back to description TS=)',
    '  cli.cjs report [--ts=<TS>] [--latest] [--json]   Show pipeline report (--latest = newest TS dir by mtime)',
    '  cli.cjs verify <path1> <path2> ...         Verify artifact paths exist',
    '  cli.cjs verify --handoff=<path>            Verify artifacts listed in a handoff JSON',
    '  cli.cjs perf-compare --baseline=<path> --final=<path> [--thresholds=<json>]',
    '                                            Compare two statistics.json snapshots',
    '  cli.cjs commit [--message=<text>] [--check] [--ts=<TS>]',
    '                                            Auto-commit pipeline changes (best-effort; triggered automatically',
    '                                            on completion when --auto-commit was set — this is a manual retry)',
    '',
    'Exit codes: 0 on success, 1 on error.'
  ];
  process.stderr.write(msg.join('\n') + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsage();
    process.exit(1);
    return;
  }
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case 'init':    cmdInit(rest); break;
    case 'resume':  cmdResume(rest); break;
    case 'update':  cmdUpdate(rest); break;
    case 'report':  cmdReport(rest); break;
    case 'verify':  cmdVerify(rest); break;
    case 'perf-compare': cmdPerfCompare(rest); break;
    case 'commit': cmdCommit(rest); break;
    case '--help':
    case '-h':
    case 'help':
      printUsage();
      process.exit(0);
      break;
    default:
      process.stderr.write('ERROR: unknown command "' + command + '"\n\n');
      printUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// Exports for module use / testing
module.exports = {
  // init
  generateTs: generateTs,
  createPipeline: createPipeline,
  resumePipeline: resumePipeline,
  cmdResume: cmdResume,
  // update
  parseUpdateArgs: parseUpdateArgs,
  readAgentOutput: readAgentOutput,
  normalizeHandoffText: normalizeHandoffText,
  // report
  fmtStage: fmtStage,
  fmtJob: fmtJob,
  findLatestTs: findLatestTs,
  // verify
  verifyPaths: verifyPaths,
  resolveAbs: resolveAbs,
  // perf-compare
  cmdPerfCompare: cmdPerfCompare,
  // commit
  cmdCommit: cmdCommit,
  performCommit: performCommit,
  buildFallbackMessage: buildFallbackMessage,
  isSpecsPath: isSpecsPath,
  readSpecTitle: readSpecTitle
};
