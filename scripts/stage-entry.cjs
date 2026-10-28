/**
 * spec-forge — StageEntry 状态机（deep module）
 *
 * 收敛所有 stage-like 入口（global stage / job coding stage / wave stage）的
 * 状态转换与重算逻辑，把以下不变量集中在一处（locality）：
 *   - 时间戳管理（started_at / completed_at）
 *   - attempt_count 递增与重试时清空 markers/artifacts
 *   - PASSED 不降级
 *   - PENDING 重置
 *   - 30 分钟 stale 窗口检测
 *   - marker 优先级（marker_outcome 覆盖 runs 判定）
 *   - allPassed 窗口聚合
 *
 * 两个语义不同的写回被明确分开：
 *   - `transition(entry, status)` —— 命令式转移（派发/重试/重置），携带
 *     attempt 生命周期副作用（started_at 打点、attempt_count 递增）。
 *   - `recompute(entry)` —— 派生式重算（从 runs/markers 推导），只更新
 *     status + terminal 回填 completed_at，**不**伪造 attempt 生命周期。
 *
 * 调用方负责「定位 entry」与「尾部动作」（如 recomputeVerificationStatus /
 * recomputeJobStatus），本模块只操作 entry 对象本身。
 */

'use strict';

const { STAGE_STATUS, DEFAULT_STALE_MS } = require('./config.cjs');

const TERMINAL_STATUSES = [
  STAGE_STATUS.PASSED,
  STAGE_STATUS.FAILED,
  STAGE_STATUS.BLOCKED,
  STAGE_STATUS.SKIPPED
];

/**
 * 判断单个 run 是否 stale：缺失 started_at（异常）或超出 stale 窗口。
 *
 * @param {object} run - run entry（含 started_at）
 * @param {number} staleMs - stale 窗口（毫秒）
 * @param {number} nowMs - 当前时间（毫秒，可注入便于测试）
 * @returns {boolean}
 */
function isStaleRun(run, staleMs, nowMs) {
  if (!run) return false;
  var rStartMs = run.started_at ? new Date(run.started_at).getTime() : 0;
  // 缺失有效 started_at 视为 stale，防止永久 IN_PROGRESS。
  if (rStartMs <= 0) return true;
  return (nowMs - rStartMs) > staleMs;
}

/**
 * 命令式状态转移。收敛 setGlobalStage / setWaveStage / setJobCodingStage 的
 * 时间戳 + attempt 生命周期 + PASSED 不降级 + PENDING 重置。
 *
 * @param {object} entry - StageEntry 对象（就地变更）
 * @param {string} status - 目标状态
 * @returns {object} entry
 */
function transition(entry, status) {
  if (!entry) return entry;

  var oldStatus = entry.status;

  // No-downgrade guard：PASSED 是终态（除非显式转 PASSED/SKIPPED）。
  if (oldStatus === STAGE_STATUS.PASSED && status !== STAGE_STATUS.PASSED && status !== STAGE_STATUS.SKIPPED) {
    return entry;
  }

  entry.status = status;
  var now = new Date().toISOString();

  if (status === STAGE_STATUS.IN_PROGRESS && oldStatus !== STAGE_STATUS.IN_PROGRESS) {
    entry.started_at = now;
    // 重试（attempt_count > 0）时清空上一轮的标记与产物。
    if (entry.attempt_count > 0) {
      entry.markers = {};
      entry.artifacts = [];
    }
    entry.attempt_count += 1;
  }

  if (TERMINAL_STATUSES.indexOf(status) !== -1) {
    entry.completed_at = now;
  }

  if (status === STAGE_STATUS.PENDING) {
    entry.started_at = null;
    entry.completed_at = null;
  }

  return entry;
}

/**
 * 从 runs + markers 派生下一个状态（纯判定，不含写回）。
 * 收敛 recomputeGlobalStageStatus / recomputeJobCodingStatus 的
 * stale 检测 + marker 优先级 + allPassed 窗口。
 *
 * 副作用：把 stale 的 IN_PROGRESS run 标记为 FAILED（与旧 recompute 一致）。
 *
 * @param {object} entry - StageEntry 对象（就地变更 stale run）
 * @param {object} [opts] - { staleMs, now }，缺省取 DEFAULT_STALE_MS / Date.now()
 * @returns {string} 目标状态
 */
function computeStatus(entry, opts) {
  opts = opts || {};
  var staleMs = (typeof opts.staleMs === 'number') ? opts.staleMs : DEFAULT_STALE_MS;
  var nowMs = (typeof opts.now === 'number') ? opts.now : Date.now();

  var runs = Array.isArray(entry.runs) ? entry.runs : [];
  var attemptStart = entry.started_at ? new Date(entry.started_at).getTime() : 0;
  var anyInProgress = false;
  var anyFailed = false;
  var inWindowCount = 0;

  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    var rStartMs = r.started_at ? new Date(r.started_at).getTime() : 0;
    // 排除当前 attempt 之前的旧 run（按 stage.started_at 划窗口）。
    if (attemptStart > 0 && rStartMs > 0 && rStartMs < attemptStart) continue;
    inWindowCount++;
    if (r.outcome === STAGE_STATUS.IN_PROGRESS) {
      if (isStaleRun(r, staleMs, nowMs)) {
        r.outcome = STAGE_STATUS.FAILED;
        r.stopped_at = new Date().toISOString();
        r.exit_status = 'stale';
        anyFailed = true;
      } else {
        anyInProgress = true;
      }
    } else if (r.outcome === STAGE_STATUS.FAILED || r.outcome === STAGE_STATUS.BLOCKED) {
      anyFailed = true;
    }
  }
  var allPassed = inWindowCount > 0 && !anyInProgress && !anyFailed;

  var markerOutcome = (entry.markers && entry.markers.marker_outcome) || null;

  if (inWindowCount === 0 && !markerOutcome) return entry.status;

  if (markerOutcome) {
    if (markerOutcome === 'PASSED') return STAGE_STATUS.PASSED;
    if (markerOutcome === 'SKIPPED') return STAGE_STATUS.SKIPPED;
    // FAILED marker —— 不降级已 PASSED 的 stage。
    if (entry.status === STAGE_STATUS.PASSED) return STAGE_STATUS.PASSED;
    return STAGE_STATUS.FAILED;
  }

  if (!anyInProgress && allPassed) return STAGE_STATUS.PASSED;
  if (!anyInProgress && anyFailed) {
    if (entry.status === STAGE_STATUS.PASSED) return STAGE_STATUS.PASSED;
    return STAGE_STATUS.FAILED;
  }
  if (entry.status === STAGE_STATUS.PASSED) return STAGE_STATUS.PASSED;
  return STAGE_STATUS.IN_PROGRESS;
}

/**
 * 派生式写回：只改 status + terminal 回填 completed_at，不碰 started_at /
 * attempt_count（派生不该伪造派发的 attempt 生命周期）。
 */
function applyDerived(entry, status) {
  if (TERMINAL_STATUSES.indexOf(status) !== -1) {
    entry.status = status;
    entry.completed_at = new Date().toISOString();
  } else if (status === STAGE_STATUS.IN_PROGRESS) {
    entry.status = STAGE_STATUS.IN_PROGRESS;
  } else {
    entry.status = status; // PENDING 或「不变」
  }
}

/**
 * 派生式重算：computeStatus + applyDerived。
 *
 * @param {object} entry - StageEntry 对象（就地变更）
 * @param {object} [opts] - 透传 computeStatus 的 { staleMs, now }
 * @returns {string} 新状态
 */
function recompute(entry, opts) {
  if (!entry) return undefined;
  if (!Array.isArray(entry.runs)) entry.runs = [];
  var status = computeStatus(entry, opts);
  applyDerived(entry, status);
  return status;
}

module.exports = {
  transition,
  computeStatus,
  recompute,
  isStaleRun
};
