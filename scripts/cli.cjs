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
// Event logger for observability (non-fatal if missing/fails)
let eventLogger = null;
try {
  eventLogger = require(path.join(SCRIPTS_DIR, 'event-logger.cjs'));
} catch (e) {
  // best-effort: keep CLI functional even if event logger not present
  eventLogger = null;
}

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
    // Emit init event (best-effort)
    try {
      if (eventLogger && result && result.ts) {
        eventLogger.logEvent({
          event_type: 'init',
          actor_id: 'cli',
          actor_type: 'orchestrator',
          task_id: 'init-' + result.ts,
          trace_id: result.ts,
          timestamp: new Date().toISOString(),
          payload: { action: 'init', auto_commit: !!result.auto_commit }
        }, PROJECT_ROOT, result.ts);
      }
    } catch (_) { /* ignore event logging errors */ }

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

  // best-effort event log for pipeline creation
  try {
    if (eventLogger) {
      eventLogger.logEvent({
        event_type: 'init',
        actor_id: 'cli',
        actor_type: 'orchestrator',
        task_id: sessionId,
        trace_id: ts,
        timestamp: state.ts_created_at,
        payload: { action: 'createPipeline', ts: ts }
      }, PROJECT_ROOT, ts);
    }
  } catch (_) { /* ignore */ }

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

  // resume event (best-effort)
  try {
    if (eventLogger) {
      eventLogger.logEvent({
        event_type: 'resume',
        actor_id: 'cli',
        actor_type: 'orchestrator',
        task_id: 'resume-' + ts,
        trace_id: ts,
        timestamp: new Date().toISOString(),
        payload: { action: 'resume', ts: ts }
      }, PROJECT_ROOT, ts);
    }
  } catch (_) { /* ignore */ }

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

  // Emit update-received event (best-effort)
  try {
    if (eventLogger) {
      eventLogger.logEvent({
        event_type: 'update_received',
        actor_id: 'cli',
        actor_type: 'orchestrator',
        task_id: parsed.agent + '-' + Date.now(),
        trace_id: ts,
        timestamp: new Date().toISOString(),
        payload: { agent: parsed.agent, description: parsed.description }
      }, PROJECT_ROOT, ts);
    }
  } catch (_) { /* ignore */ }

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

  // Emit update-persisted event (best-effort)
  try {
    if (eventLogger) {
      eventLogger.logEvent({
        event_type: 'update_persisted',
        actor_id: 'cli',
        actor_type: 'orchestrator',
        task_id: parsed.agent + '-' + Date.now(),
        trace_id: ts,
        timestamp: new Date().toISOString(),
        payload: { agent: parsed.agent, stage: (dispatchInfo.scope === 'job' ? 'coding' : dispatchInfo.stageName), marker_outcome: (targetStage && targetStage.markers ? targetStage.markers.marker_outcome : null) }
      }, PROJECT_ROOT, ts);
    }
  } catch (_) { /* ignore */ }

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

// ... rest of file unchanged ...

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
