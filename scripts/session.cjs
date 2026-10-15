/**
 * spec-forge — Session-scoped active-TS marker
 *
 * 每个 spec-forge run 有唯一 TS（`specs/{TS}/state.json`）。`init`（create /
 * resume pipeline）时把本 session 的 TS 记入项目内 `specs/session-active/<CLAUDE_CODE_SESSION_ID>`，
 * statusline（progress.cjs）只读**自己 session** 的标记。
 *
 * 这样：
 *   - 全新 session 没有自己的标记 → statusline 不显示（不会泄漏上一 run 的进度）；
 *   - 同时开多个 Claude Code 各写各的标记 → 各渲染各的 run，互不干扰；
 *   - run 结束后标记仍在 → 本 session 继续显示最后状态（Q3-C，无需清理）。
 *
 * fail-closed：拿不到 `CLAUDE_CODE_SESSION_ID`（非 Claude Code 环境 / 独立运行
 * progress.cjs）一律视作未启用 —— 宁可空白，不显示他处 run 的进度。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SPECS_DIR = 'specs';
const SESSION_ACTIVE_DIR = 'session-active';

/**
 * 当前 Claude Code session id。非 Claude Code 环境返回 null（fail-closed）。
 *
 * statusline 进程与 Bash 工具进程拿到同一值（实测 v2.1.243）；缺失时整个
 * session 机制失效 → 一律不显示。
 */
function getSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || null;
}

function resolveSessionActiveDir(projectRoot) {
  return path.join(projectRoot, SPECS_DIR, SESSION_ACTIVE_DIR);
}

function resolveSessionMarkerFile(projectRoot, sessionId) {
  return path.join(resolveSessionActiveDir(projectRoot), sessionId);
}

/**
 * 记录本 session 的活跃 TS。init（create/resume pipeline）时调用。
 *
 * @param {string} ts - 唯一 TS
 * @param {string} projectRoot
 * @returns {boolean} false = 未记录（无 session id 或写失败，调用方忽略即可）
 */
function writeSessionActiveTS(ts, projectRoot) {
  const sid = getSessionId();
  if (!sid) return false;
  try {
    const file = resolveSessionMarkerFile(projectRoot, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(ts), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 读本 session 的活跃 TS。
 *
 * @param {string} projectRoot
 * @returns {string|null} 无 session id / 无标记 → null
 */
function readSessionActiveTS(projectRoot) {
  const sid = getSessionId();
  if (!sid) return null;
  try {
    const file = resolveSessionMarkerFile(projectRoot, sid);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8').trim();
    return content || null;
  } catch (_) {
    return null;
  }
}

/**
 * 本 session 是否在 projectRoot 下启用（标记存在）。
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
function hasSessionActiveTS(projectRoot) {
  const sid = getSessionId();
  if (!sid) return false;
  try {
    return fs.existsSync(resolveSessionMarkerFile(projectRoot, sid));
  } catch (_) {
    return false;
  }
}

module.exports = {
  getSessionId,
  resolveSessionActiveDir,
  resolveSessionMarkerFile,
  writeSessionActiveTS,
  readSessionActiveTS,
  hasSessionActiveTS
};
