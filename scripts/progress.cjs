#!/usr/bin/env node
/**
 * spec-forge — Progress Bar（flow-light）
 *
 * 渲染「流程灯」进度条：读「本 session 的活跃 TS 标记」specs/session-active/
 * <CLAUDE_CODE_SESSION_ID> → specs/{TS}/state.json，输出一行 6 阶段 strip +
 * 至多两行细节（implementation 的 job 灯 / verification 的 round 子阶段灯）。
 * 不做百分比 —— 只反映 state.json 的真实流程。
 *
 * session 门控：只渲染本 session 自己 init 的 run。全新 session 没有自己的
 * 标记 → 不输出任何内容（statusline 不可见）；fail-closed（拿不到
 * CLAUDE_CODE_SESSION_ID）同样不显示 —— 宁可空白，不泄漏上一 run 的进度。
 *
 * 设计约束（Claude Code statusline 的硬规则）：
 *   - 永不非零退出（statusline 非零退出 → 整条状态栏空白）
 *   - 未启用 session 不输出（statusline 隐藏）；启用但读失败退化成兜底行
 *   - 默认 ANSI 上色（statusline 捕获 stdout 也透传 ANSI）；--no-color 关闭
 *   - 读文件无副作用（不走 store.load —— 那会在 corrupt 时写 .corrupt.* 备份）
 *
 * Usage:
 *   node progress.cjs [--project-root=<path>] [--no-color]
 *
 * Output (statusline 多行支持，每行一个 row；三行共用同一 token 折行器 wrapTokens，宽度一致):
 *   主行   sf ✓spec-check 3m12s → ✓task-decompose 1m04s
 *            → ✓baseline-regression 2m50s → ▸implementation 5m    （续行缩进 3 = 'sf ' 宽）
 *          （stage 耗时：终态 = completed_at − started_at；IN_PROGRESS = now − started_at，
 *            实时走秒；缺 started_at（PENDING/旧数据）不显示。
 *            折行发生在 ` → ` 之间、不拆单个 stage；宽度口径：每行 ≤ width（含前缀/缩进）。
 *            两个文档化例外：单 token 超行宽独占一行溢出；[fail] 追加末行、不预留空间。）
 *   细节   jobs: ✓J0-1 3m12s ▸J1-2 5m ·J2-3            （续行缩进 6 = 'jobs: ' 宽；空格间折行）
 *            ·J3-4 ·J4-5 ·J5-6
 *          verification r2: ✓testing 1m04s → ▸review 2m10s   （续行缩进 = 前缀宽）
 *                            → ·regression → ·fix
 *          （jobs / verification 细节行至多折 2 行，仍溢出 → 末行 ' …' 截断；各自阶段
 *            开始后常驻，不随活跃阶段后移消失）
 *
 * 状态标记：PASSED/WARN→✓ IN_PROGRESS→▸ PENDING→· FAILED→✗ SKIPPED→⊘ BLOCKED→⚠
 *           （未知状态兜底 ·；DEFERRED_RELEASE 是 AC 状态，不在 stage 状态里）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const configLib = require('./config.cjs');
const storeLib = require('./store.cjs');
const sessionLib = require('./session.cjs');

const { GLOBAL_STAGE_ORDER, VERIFICATION_STAGE_ORDER, STAGE_STATUS } = configLib;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// 阶段/子阶段一律用 config 的全称（`spec-check` / `task-decompose` / `testing` …），
// 不做简写 —— 用户明确要求全称。

// 状态 → 标记 + 颜色。PASSED/WARN 都算绿勾（WARN 是软通过）。
const MARK_BY_STATUS = Object.freeze({
  [STAGE_STATUS.PASSED]: { mark: '✓', color: 'green' },
  [STAGE_STATUS.WARN]: { mark: '✓', color: 'green' },
  [STAGE_STATUS.IN_PROGRESS]: { mark: '▸', color: 'cyan' },
  [STAGE_STATUS.PENDING]: { mark: '·', color: 'gray' },
  [STAGE_STATUS.FAILED]: { mark: '✗', color: 'red' },
  [STAGE_STATUS.BLOCKED]: { mark: '⚠', color: 'yellow' },
  [STAGE_STATUS.SKIPPED]: { mark: '⊘', color: 'gray' }
});

const FALLBACK_MARK = Object.freeze({ mark: '·', color: 'gray' });

const ANSI = Object.freeze({
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  reset: '\x1b[0m'
});

const DEFAULT_MAX_DETAIL_LEN = 80;

// ---------------------------------------------------------------------------
// Pure render helpers（可测：opts.color=false 时输出纯文本，无 ANSI）
// ---------------------------------------------------------------------------

function colorize(text, color, enabled) {
  if (!enabled || !ANSI[color]) return text;
  return ANSI[color] + text + ANSI.reset;
}

/**
 * status → { mark, color }。未知/缺失状态兜底为中性灰点。
 *
 * @param {string|null|undefined} status - STAGE_STATUS 值
 * @returns {{mark: string, color: string}}
 */
function markForStatus(status) {
  return MARK_BY_STATUS[status] || FALLBACK_MARK;
}

function normalizeOpts(opts) {
  const o = opts || {};
  const width = (typeof o.width === 'number' && o.width > 0) ? o.width : null;
  const explicitDetail = (typeof o.maxDetailLen === 'number' && o.maxDetailLen > 0)
    ? o.maxDetailLen
    : null;
  // 细节行每行宽度：默认 = width（与主行一致）；显式 maxDetailLen 只许调窄、不超 width。
  let detailWidth;
  if (width !== null) {
    detailWidth = (explicitDetail !== null) ? Math.min(explicitDetail, width) : width;
  } else {
    detailWidth = (explicitDetail !== null) ? explicitDetail : DEFAULT_MAX_DETAIL_LEN;
  }
  return {
    color: !!o.color,
    detailWidth: detailWidth,
    now: (typeof o.now === 'number') ? o.now : Date.now(),
    width: width
  };
}

/**
 * 紧凑耗时格式：45s / 3m12s / 1m04s / 32m。无效输入返回 null。
 *
 * @param {number} ms
 * @returns {string|null}
 */
function fmtDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return totalSec + 's';
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + 'm' + (s === 0 ? '' : (s < 10 ? '0' + s : s) + 's');
}

/**
 * stage 耗时（毫秒）。
 *
 * - 终态（有 completed_at）：completed_at − started_at。
 * - IN_PROGRESS（有 started_at，无 completed_at）：now − started_at（实时走秒）。
 * - 缺 started_at（PENDING / 旧数据）或时间戳倒挂：返回 null（不显示）。
 *
 * @param {object|null} stage - StageEntry
 * @param {number} nowMs - 当前时间（毫秒，可注入便于测试）
 * @returns {number|null}
 */
function stageDurationMs(stage, nowMs) {
  if (!stage) return null;
  const startMs = stage.started_at ? new Date(stage.started_at).getTime() : 0;
  if (!startMs || startMs <= 0) return null;

  if (stage.completed_at) {
    const endMs = new Date(stage.completed_at).getTime();
    if (endMs && endMs >= startMs) return endMs - startMs;
    return null;
  }

  const elapsed = (typeof nowMs === 'number' ? nowMs : Date.now()) - startMs;
  return elapsed < 0 ? null : elapsed;
}

/**
 * 任一全局阶段处于 FAILED/BLOCKED → 行尾 [fail]。
 *
 * @param {object} state
 * @returns {boolean}
 */
function hasFailedStage(state) {
  if (!state || !state.stages) return false;
  for (let i = 0; i < GLOBAL_STAGE_ORDER.length; i++) {
    const s = state.stages[GLOBAL_STAGE_ORDER[i]];
    if (s && (s.status === STAGE_STATUS.FAILED || s.status === STAGE_STATUS.BLOCKED)) {
      return true;
    }
  }
  return false;
}

/**
 * token 感知折行 + 可选行数截断 —— 主行 / jobs / verification 三行共用的统一折行器。
 *
 * 规则（与「宽度一致」设计一致）：
 *   - 首行带 prefix，续行缩进 indentLen 个空格（默认 = prefix 长度 → 内容对齐内容列）。
 *   - 只在 sep 之间折行，不拆单个 token；单 token 超行宽时独占一行溢出（token 完整性例外，
 *     不显示 ' …'）。
 *   - maxLines 设限时：贪心折满后行数仍超限 → 末行截断 + ' …'；不超限则永不截断。
 *   - 量宽一律用 plain（无 ANSI），输出 colored —— colored 含 ANSI 会高估宽度。
 *
 * @param {Array<{plain: string, colored: string}>} tokens
 * @param {object} opts
 * @param {number} opts.width - 整行宽预算（含 prefix / 缩进）
 * @param {string} opts.prefix - 首行前缀
 * @param {string} [opts.sep=' '] - token 分隔符（jobs 用空格，stage 类用 ' → '）
 * @param {number} [opts.maxLines=null] - 行数上限；null = 不设限
 * @param {number} [opts.indentLen] - 续行缩进（默认 = prefix.length）
 * @returns {string} 多行文本（显式 \n，每行一个 statusline row）
 */
function wrapTokens(tokens, opts) {
  const width = opts.width;
  const prefix = opts.prefix || '';
  const sep = (opts.sep === undefined) ? ' ' : opts.sep;
  const maxLines = (typeof opts.maxLines === 'number' && opts.maxLines > 0) ? opts.maxLines : null;
  const indentLen = (typeof opts.indentLen === 'number' && opts.indentLen >= 0) ? opts.indentLen : prefix.length;
  const indent = ' '.repeat(indentLen);
  const firstBudget = width - prefix.length;
  const contBudget = width - indentLen;

  if (tokens.length === 0) return prefix;
  // 无宽度（未注入 COLUMNS）或单 token → 单行；单 token 超宽按 token 完整性例外溢出。
  if (typeof width !== 'number' || !(width > 0) || tokens.length === 1) {
    return prefix + tokens.map(function (t) { return t.colored; }).join(sep);
  }

  // 贪心折行：首行预算扣 prefix，续行预算扣缩进（默认 indent=prefix，两者相等）。
  const lines = [];
  const plains = tokens.map(function (t) { return t.plain; });
  let cur = [];
  let curLen = 0;
  let lineNo = 0;
  for (let i = 0; i < tokens.length; i++) {
    const budget = (lineNo === 0) ? firstBudget : contBudget;
    const tLen = plains[i].length;
    const add = (cur.length > 0 ? sep.length : 0) + tLen;
    if (cur.length > 0 && curLen + add > budget) {
      lines.push(cur);
      cur = [i];
      curLen = tLen;
      lineNo++;
    } else {
      cur.push(i);
      curLen += add;
    }
  }
  if (cur.length > 0) lines.push(cur);

  // 行数超 maxLines → 保留前 maxLines-1 行，末行截断到放得下 ' …'（至少留 1 token）。
  let truncated = false;
  if (maxLines !== null && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    const last = lines[maxLines - 1].slice();
    const lbudget = (kept.length === 0) ? firstBudget : contBudget;
    let lastLen = 0;
    for (let j = 0; j < last.length; j++) {
      if (j > 0) lastLen += sep.length;
      lastLen += plains[last[j]].length;
    }
    while (last.length > 1 && lastLen + ' …'.length > lbudget) {
      lastLen -= (sep.length + plains[last[last.length - 1]].length);
      last.pop();
    }
    lines.length = 0;
    for (let k = 0; k < kept.length; k++) lines.push(kept[k]);
    lines.push(last);
    truncated = true;
  }

  const out = [];
  for (let li = 0; li < lines.length; li++) {
    const idxs = lines[li];
    const head = (li === 0) ? prefix : indent;
    let line = head + idxs.map(function (i) { return tokens[i].colored; }).join(sep);
    if (truncated && li === lines.length - 1) line += ' …';
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 主行 strip：sf <stage 灯> → …。三行共用 wrapTokens：首行 `sf ` 计入宽度预算，
 * 续行缩进 3（= 'sf ' 宽），折行在 ` → ` 之间、不拆单个 stage；无行数上限
 * （6 个 stage 在极窄终端下最坏各占一行）。
 *
 * @param {object} state
 * @param {{color: boolean, now: number, width: number|null}} opts
 * @returns {string} 单行或多行（显式 \n，每行一个 statusline row）
 */
function renderMainRow(state, opts) {
  const tokens = [];
  for (let i = 0; i < GLOBAL_STAGE_ORDER.length; i++) {
    const name = GLOBAL_STAGE_ORDER[i];
    const stage = state.stages[name];
    const { mark, color } = markForStatus(stage && stage.status);
    const durMs = stageDurationMs(stage, opts.now);
    const durText = durMs !== null ? ' ' + fmtDuration(durMs) : '';
    tokens.push({
      plain: mark + name + durText,
      colored: colorize(mark + name, color, opts.color) + (durText ? colorize(durText, 'gray', opts.color) : '')
    });
  }

  let out = wrapTokens(tokens, {
    width: opts.width,
    prefix: 'sf ',
    sep: ' → ',
    maxLines: null
  });
  if (hasFailedStage(state)) {
    // [fail] 追加在主行末行末尾、不预留空间 —— 宽度口径的文档化例外之一。
    const lines = out.split('\n');
    lines[lines.length - 1] += ' ' + colorize('[fail]', 'red', opts.color);
    out = lines.join('\n');
  }
  return out;
}

/**
 * implementation 细节行：jobs: <mark>J<id> [<耗时>] …（逐 job 打灯 + coding 耗时，
 * 符号统一在前，job 多时按宽度折行至多 2 行，仍溢出末行 ' …'）。空 jobs 返回 ''
 * （不输出细节行）。
 *
 * @param {object} state
 * @param {{color: boolean, detailWidth: number, now: number}} opts
 * @returns {string}
 */
function renderJobDetail(state, opts) {
  const impl = state.stages && state.stages.implementation;
  const jobs = (impl && Array.isArray(impl.jobs)) ? impl.jobs : [];
  if (jobs.length === 0) return '';

  const tokens = jobs.map(function (job) {
    const coding = (job && job.coding) || null;
    const status = (coding && coding.status) || STAGE_STATUS.PENDING;
    const { mark, color } = markForStatus(status);
    // job id 已带 J 前缀（如 J0-1）；token 形如 `✓J0-1 3m12s`（符号在前，与主行统一）。
    const id = (job && job.id) || '?';
    const durMs = stageDurationMs(coding, opts.now);
    const durText = durMs !== null ? ' ' + fmtDuration(durMs) : '';
    return {
      plain: mark + id + durText,
      colored: colorize(mark + id, color, opts.color) + (durText ? colorize(durText, 'gray', opts.color) : '')
    };
  });
  return wrapTokens(tokens, {
    width: opts.detailWidth,
    prefix: 'jobs: ',
    sep: ' ',
    maxLines: 2
  });
}

/**
 * verification 细节行：verification r<roundN>: <mark><子阶段> [<耗时>] → …
 * 展示当前轮（rounds 末元素）的 4 个子阶段 + 各子阶段耗时；轮次 = rounds.length（1-based）。
 * 续行缩进 = 前缀宽（内容对齐内容列；r9 → r10 前缀 +1 字符 → 续行右移 1 列，接受抖动）。
 * 符号统一在前（`✓testing 1m04s`），与主行一致。
 *
 * @param {object} state
 * @param {{color: boolean, detailWidth: number, now: number}} opts
 * @returns {string}
 */
function renderVerificationDetail(state, opts) {
  const ver = state.stages && state.stages.verification;
  if (!ver) return '';

  const rounds = Array.isArray(ver.rounds) ? ver.rounds : null;
  const round = (rounds && rounds.length > 0) ? rounds[rounds.length - 1] : null;
  const roundNum = (rounds && rounds.length > 0) ? rounds.length : 1;

  const tokens = VERIFICATION_STAGE_ORDER.map(function (name) {
    const sub = (round && round[name]) || null;
    const status = (sub && sub.status) || STAGE_STATUS.PENDING;
    const { mark, color } = markForStatus(status);
    const durMs = stageDurationMs(sub, opts.now);
    const durText = durMs !== null ? ' ' + fmtDuration(durMs) : '';
    return {
      plain: mark + name + durText,
      colored: colorize(mark + name, color, opts.color) + (durText ? colorize(durText, 'gray', opts.color) : '')
    };
  });
  const prefix = 'verification r' + roundNum + ': ';
  return wrapTokens(tokens, {
    width: opts.detailWidth,
    prefix: prefix,
    sep: ' → ',
    maxLines: 2
  });
}

/**
 * jobs 细节行是否显示：implementation 一旦持有 jobs 就**常驻**（task-decompose
 * 之后直到 pipeline 结束都不消失），不因当前活跃阶段后移而消失。空 jobs（尚未
 * decompose）不显示。
 *
 * @param {object} state
 * @returns {boolean}
 */
function jobsDetailVisible(state) {
  const impl = state.stages && state.stages.implementation;
  return !!(impl && Array.isArray(impl.jobs) && impl.jobs.length > 0);
}

/**
 * verification 细节行是否显示：verification 一旦开始就**常驻**（status 非 PENDING，
 * 或任一 round 的任一子阶段非 PENDING），不因当前活跃阶段后移而消失。
 *
 * @param {object} state
 * @returns {boolean}
 */
function verificationDetailVisible(state) {
  const ver = state.stages && state.stages.verification;
  if (!ver) return false;
  if (ver.status && ver.status !== STAGE_STATUS.PENDING) return true;
  const rounds = Array.isArray(ver.rounds) ? ver.rounds : [];
  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r];
    for (let s = 0; s < VERIFICATION_STAGE_ORDER.length; s++) {
      const sub = round && round[VERIFICATION_STAGE_ORDER[s]];
      if (sub && sub.status && sub.status !== STAGE_STATUS.PENDING) return true;
    }
  }
  return false;
}

/**
 * 渲染完整进度（主行 + 常驻细节行）。
 *
 * jobs / verification 细节行在各自阶段开始后**常驻**（不复原为"仅当前活跃阶段"），
 * 分别由 jobsDetailVisible / verificationDetailVisible 决定是否显示。
 *
 * @param {object} state - Pipeline state
 * @param {{color?: boolean, maxDetailLen?: number, width?: number, now?: number}} [opts]
 * @returns {string} 多行文本（statusline 每行一个 row）
 */
function renderProgress(state, opts) {
  const o = normalizeOpts(opts);
  if (!state || !state.stages) return 'sf …';

  const lines = [renderMainRow(state, o)];
  if (jobsDetailVisible(state)) {
    const jobDetail = renderJobDetail(state, o);
    if (jobDetail) lines.push(jobDetail);
  }
  if (verificationDetailVisible(state)) {
    lines.push(renderVerificationDetail(state, o));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// State loading（无副作用，只读）
// ---------------------------------------------------------------------------

/**
 * 定位含「本 session 活跃 TS 标记」的项目根（specs/session-active/<CLAUDE_CODE_SESSION_ID>）。
 *
 * - `opts.searchUp` 为 true（自动跟随）：从解析出的根（`--project-root` 未给时
 *   为 PROJECT_DIR → cwd）**向上**找最近的含本 session 标记的目录 —— 从项目子目录
 *   启动 claude 也能命中，状态栏配置无需写死项目根。是否向上搜索只看 `searchUp`，
 *   与是否传了显式路径无关。
 * - `searchUp=false`：视为「就在这里」，不做向上搜索。
 * - 无 CLAUDE_CODE_SESSION_ID（非 Claude Code 环境）→ found=false（fail-closed）。
 *
 * @param {string} [projectRoot] - 显式覆盖
 * @param {{searchUp?: boolean}} [opts]
 * @returns {{root: string, found: boolean}} found=false 表示本 session 未启用
 */
function findProjectRootForSession(projectRoot, opts) {
  const searchUp = !!(opts && opts.searchUp);
  const resolved = storeLib.resolveProjectRoot(projectRoot);

  if (!sessionLib.getSessionId()) {
    return { root: resolved, found: false };
  }

  if (!searchUp) {
    return { root: resolved, found: sessionLib.hasSessionActiveTS(resolved) };
  }

  let dir = path.resolve(resolved);
  let last = null;
  while (dir !== last) {
    if (sessionLib.hasSessionActiveTS(dir)) {
      return { root: dir, found: true };
    }
    last = dir;
    dir = path.dirname(dir);
  }
  return { root: resolved, found: false };
}

/**
 * 解析本 session 标记 → specs/{TS}/state.json。
 *
 * 返回：
 *   { status: 'idle'  }  本 session 未启用（无 session id / 无标记）→ statusline 不显示
 *   { status: 'error' }  标记存在但 state.json 缺失/损坏/不可解析 → sf …
 *   { status: 'ok', state } 正常
 *
 * @param {string} [projectRoot] - 显式覆盖；默认 env PROJECT_DIR → cwd
 * @param {{searchUp?: boolean}} [opts] - searchUp=true 时从解析根向上找本 session 标记
 * @returns {{status: string, state?: object}}
 */
function loadStateForBar(projectRoot, opts) {
  try {
    const { root, found } = findProjectRootForSession(projectRoot, opts);
    if (!found) return { status: 'idle' };

    const ts = sessionLib.readSessionActiveTS(root);
    if (!ts) return { status: 'idle' };

    const stateFile = storeLib.resolveStateFile(ts, root);
    if (!fs.existsSync(stateFile)) return { status: 'error' };

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state || typeof state !== 'object') return { status: 'error' };
    return { status: 'ok', state };
  } catch (_) {
    return { status: 'error' };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  let projectRoot;
  let explicitRoot = false;
  let color = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.indexOf('--project-root=') === 0) {
      projectRoot = arg.slice('--project-root='.length);
      explicitRoot = true;
    } else if (arg === '--no-color') {
      color = false;
    } else if (arg === '--color') {
      color = true;
    }
  }
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    color = false;
  }

  // 主行按终端宽度折行：CLAUDE Code 注入 COLUMNS（v2.1.153+）；缺省 80。
  let width = 80;
  const cols = parseInt(process.env.COLUMNS, 10);
  if (cols > 0) width = cols;

  let out;
  try {
    // 未显式给 --project-root 时向上搜索最近含「本 session 标记」的项目根（自动跟随）。
    const res = loadStateForBar(projectRoot, { searchUp: !explicitRoot });
    if (res.status === 'idle') {
      // 本 session 未启用 spec-forge → 不输出任何内容，statusline 不可见。
      // fail-closed：全新 session / 非 Claude Code 环境一律空白，不泄漏他处 run 进度。
      process.exit(0);
    }
    out = (res.status === 'error') ? 'sf …' : renderProgress(res.state, { color: color, width: width });
  } catch (_) {
    out = 'sf …';
  }

  process.stdout.write(out + '\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  markForStatus,
  renderMainRow,
  renderJobDetail,
  renderVerificationDetail,
  hasFailedStage,
  wrapTokens,
  jobsDetailVisible,
  verificationDetailVisible,
  renderProgress,
  loadStateForBar,
  findProjectRootForSession,
  fmtDuration,
  stageDurationMs
};
