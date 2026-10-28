/**
 * spec-forge — State Store（持久化 seam）
 *
 * state.json 的读写、TS 生命周期、路径解析。这是从
 * state.cjs 拆出的「持久化」职责：只关心 state 落盘与生命周期，不关心
 * state 的 schema（default 工厂）或状态机（stage-entry）。
 *
 * load() 在「无有效 state」（ts 无效 / 文件不存在 / 文件损坏）时返回 null，
 * 由调用方（state.cjs 门面）兜底 defaultState() —— 避免本模块反向依赖 model。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---- Path constants ----
const SPECS_DIR = 'specs';
const STATE_FILE = 'state.json';

// TS format: YYYYMMDD-HHMMSS or YYYYMMDD-HHMMSS-xxxx (4-char suffix)
const TS_LIKE_RE = /^\d{8}-\d{6}(?:-[a-z0-9]{4})?$/;

// ---- Path resolvers ----

function resolveProjectRoot(projectRoot) {
  return projectRoot || process.env.PROJECT_DIR || process.cwd();
}

function resolveSpecsDir(projectRoot) {
  return path.join(resolveProjectRoot(projectRoot), SPECS_DIR);
}

function resolveTSDir(ts, projectRoot) {
  const tsVal = ts || 'unknown';
  return path.join(resolveSpecsDir(projectRoot), tsVal);
}

function resolveStateFile(ts, projectRoot) {
  return path.join(resolveTSDir(ts, projectRoot), STATE_FILE);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---- TS Lifecycle Management ----

function ensureTsLifecycle(state) {
  if (!state) return;
  if (!state.ts_lifecycle) {
    state.ts_lifecycle = 'active';
    state.ts_created_at = state.ts_created_at || new Date().toISOString();
  }
  if (state.ts_completed_at === undefined) {
    state.ts_completed_at = null;
  }
}

function markTsCompleted(state) {
  ensureTsLifecycle(state);
  state.ts_lifecycle = 'completed';
  state.ts_completed_at = new Date().toISOString();
}

// ---- State file I/O ----

/**
 * Read state from specs/{TS}/state.json.
 *
 * Returns null when there is no valid state (invalid TS, missing file, or
 * corrupt file — the latter is backed up first). The caller is responsible
 * for the defaultState() fallback.
 *
 * @param {string} ts - TS version suffix
 * @param {string} [projectRoot]
 * @returns {object|null} Pipeline state, or null
 */
function load(ts, projectRoot) {
  if (!ts || !TS_LIKE_RE.test(ts)) {
    return null;
  }

  const stateFile = resolveStateFile(ts, projectRoot);

  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    var state = JSON.parse(raw);

    // Ensure TS lifecycle fields exist
    ensureTsLifecycle(state);

    return state;
  } catch (e) {
    // Back up corrupt file before returning null
    try {
      const corruptPath = stateFile + '.corrupt.' + ts + '.' + Date.now();
      fs.copyFileSync(stateFile, corruptPath);
      console.error('[harness:state] state.json corrupt — backed up to ' + corruptPath + ' : ' + e.message);
    } catch (backupErr) {
      console.error('[harness:state] state.json corrupt AND backup failed: ' + backupErr.message + ' (orig: ' + e.message + ')');
    }
    return null;
  }
}

function save(state, ts, projectRoot) {
  if (!state) {
    console.error('[harness:state] save() called without state');
    return;
  }
  if (!ts) {
    console.error('[harness:state] save() called without TS');
    return;
  }

  const stateDir = resolveTSDir(ts, projectRoot);
  ensureDir(stateDir);

  const pid = process.pid;
  const rand = Math.random().toString(36).substring(2, 10);
  const tmpFile = path.join(stateDir, `state.json.tmp.${pid}.${rand}`);
  const finalFile = path.join(stateDir, STATE_FILE);

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpFile, finalFile);
  } catch (e) {
    console.error('[harness:state] state save failed', { ts, error: e.message });
    // Cleanup tmp file
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch (_) { /* ignore cleanup errors */ }
    // Re-throw error so caller can handle it
    throw e;
  }
}

module.exports = {
  resolveProjectRoot,
  resolveSpecsDir,
  resolveTSDir,
  resolveStateFile,
  ensureDir,
  ensureTsLifecycle,
  markTsCompleted,
  load,
  save
};
