/**
 * spec-forge — Dispatch scope 协议
 *
 * description 字符串（TS=… GLOBAL=… / JOB=… STAGE=…）的编码/解码。
 * 这是调度器（encode）与 update 命令（decode）之间的唯一格式契约——格式字符串
 * 只在本模块出现一次，避免 scheduler 与 subagent-handler 各自维护一份。
 *
 * 格式：
 *   global:       TS={ts} GLOBAL={stageName}
 *   job:          TS={ts} JOB={jobId} STAGE=coding
 *   verification: TS={ts} GLOBAL=verification STAGE={testing|review|regression|fix}
 */

'use strict';

/**
 * Encode a scope into a description string.
 *
 * @param {string|null} ts - TS version suffix（null/undefined 时用 'unknown'）
 * @param {object} scope - 见 decode 的返回值
 * @returns {string} description
 */
function encode(ts, scope) {
  var tsVal = ts || 'unknown';
  switch (scope.scope) {
    case 'global':
      return 'TS=' + tsVal + ' GLOBAL=' + scope.stageName;
    case 'job':
      return 'TS=' + tsVal + ' JOB=' + scope.jobId + ' STAGE=coding';
    case 'verification':
      return 'TS=' + tsVal + ' GLOBAL=verification STAGE=' + scope.subStage;
    default:
      throw new Error('unknown dispatch scope: ' + JSON.stringify(scope));
  }
}

/**
 * Extract the TS from a description string ("TS={ts} …").
 *
 * description 是调度器 encode 的唯一契约；update 命令用它做 --ts 的兜底与
 * 交叉校验。TS 缺失（null/空/garbage）一律返回 null，由调用方决定策略。
 *
 * @param {string|null|undefined} description
 * @returns {string|null}
 */
function extractTs(description) {
  if (!description || typeof description !== 'string') return null;
  var match = description.match(/TS=(\S+)/);
  return match ? match[1] : null;
}

/**
 * Decode a description string into a scope object.
 *
 * @param {string|null|undefined} description
 * @returns {object} { scope: 'global'|'job'|'verification'|'unknown', … }
 */
function decode(description) {
  if (!description || typeof description !== 'string') {
    return { scope: 'unknown' };
  }

  // JOB= 优先。
  var jobMatch = description.match(/JOB=(\S+)/);
  if (jobMatch) {
    return { scope: 'job', jobId: jobMatch[1] };
  }

  var globalMatch = description.match(/GLOBAL=(\S+)/);
  if (globalMatch) {
    var stageName = globalMatch[1];
    // Verification 子阶段派发："TS=xxx GLOBAL=verification STAGE=testing|review|regression|fix"
    var stageMatch = description.match(/STAGE=(\S+)/);
    if (stageName === 'verification' && stageMatch) {
      return { scope: 'verification', stageName: stageName, subStage: stageMatch[1] };
    }
    return { scope: 'global', stageName: stageName };
  }

  return { scope: 'unknown' };
}

module.exports = { encode, decode, extractTs };
