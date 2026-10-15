/**
 * spec-forge — Performance Comparison Library
 *
 * Deterministic before/after performance comparison. The regression-runner
 * agent captures two JMeter `statistics.json` snapshots (baseline before
 * coding, final after coding) and this module compares them against
 * configurable thresholds.
 *
 * Compared metrics (from statistics.json's `Total` aggregate):
 *   - throughput    relative change (%), lower is worse
 *   - pct3ResTime   relative change (%), higher is worse (p99 latency)
 *   - errorPct      absolute change in percentage points, higher is worse
 *
 * A metric is NOT applicable (and never breaches) when its baseline is
 * missing or zero — that comparison is skipped, not failed.
 */

'use strict';

const fs = require('fs');

// Default thresholds: how much degradation is tolerated before WARN.
//   throughputPct   minimum allowed relative change (%) in throughput.
//                   -10 means throughput may drop up to 10% before WARN.
//   pct3ResTimePct  maximum allowed relative increase (%) in p99 latency.
//                   +20 means p99 may rise up to 20% before WARN.
//   errorPctPoints  maximum allowed absolute increase in error rate
//                   (percentage points). 0 means ANY error-rate increase WARNs.
const DEFAULT_THRESHOLDS = Object.freeze({
  throughputPct: -10,
  pct3ResTimePct: 20,
  errorPctPoints: 0
});

function isFiniteNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

function round(v, digits) {
  var factor = Math.pow(10, digits || 2);
  return Math.round(v * factor) / factor;
}

/**
 * Merge user overrides onto the default thresholds.
 *
 * @param {object} [overrides] - Partial thresholds object
 * @returns {object} Resolved thresholds
 */
function loadThresholds(overrides) {
  var t = {
    throughputPct: DEFAULT_THRESHOLDS.throughputPct,
    pct3ResTimePct: DEFAULT_THRESHOLDS.pct3ResTimePct,
    errorPctPoints: DEFAULT_THRESHOLDS.errorPctPoints
  };
  if (overrides && typeof overrides === 'object') {
    if (isFiniteNumber(overrides.throughputPct)) t.throughputPct = overrides.throughputPct;
    if (isFiniteNumber(overrides.pct3ResTimePct)) t.pct3ResTimePct = overrides.pct3ResTimePct;
    if (isFiniteNumber(overrides.errorPctPoints)) t.errorPctPoints = overrides.errorPctPoints;
  }
  return t;
}

/**
 * Extract comparable metrics from a parsed statistics.json object.
 *
 * Prefers the `Total` aggregate; falls back to the first non-Total
 * transaction when `Total` is absent (single-endpoint plans omit it).
 *
 * @param {object} statistics - Parsed statistics.json
 * @returns {object|null} Flat metrics object, or null if unusable
 */
function extractMetrics(statistics) {
  if (!statistics || typeof statistics !== 'object') return null;
  var keys = Object.keys(statistics);
  if (keys.length === 0) return null;

  var entry = statistics['Total'];
  if (!entry || typeof entry !== 'object') {
    for (var i = 0; i < keys.length; i++) {
      var candidate = statistics[keys[i]];
      if (candidate && typeof candidate === 'object' && candidate.transaction) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry || typeof entry !== 'object') return null;

  return {
    transaction: entry.transaction || 'Total',
    sampleCount: entry.sampleCount,
    errorCount: entry.errorCount,
    errorPct: entry.errorPct,
    meanResTime: entry.meanResTime,
    medianResTime: entry.medianResTime,
    pct1ResTime: entry.pct1ResTime,
    pct2ResTime: entry.pct2ResTime,
    pct3ResTime: entry.pct3ResTime,
    minResTime: entry.minResTime,
    maxResTime: entry.maxResTime,
    throughput: entry.throughput
  };
}

/**
 * Read and parse a statistics.json snapshot file.
 *
 * @param {string} filePath - Absolute path to a statistics.json (or snapshot)
 * @returns {object|null} Flat metrics object, or null on read/parse failure
 */
function readStatisticsFile(filePath) {
  if (!filePath) return null;
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    return extractMetrics(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

/**
 * Compare a relative (percentage) metric. Returns a non-applicable result
 * (never breaches) when the baseline is missing or zero.
 */
function _compareRelative(name, baseline, final, threshold, worseWhen) {
  if (!isFiniteNumber(baseline) || !isFiniteNumber(final) || baseline === 0) {
    return {
      name: name,
      baseline: baseline,
      final: final,
      deltaPct: null,
      thresholdPct: threshold,
      breached: false,
      notApplicable: true
    };
  }
  var deltaPct = (final - baseline) / baseline * 100;
  var breached = (worseWhen === 'lower')
    ? (deltaPct < threshold)
    : (deltaPct > threshold);
  return {
    name: name,
    baseline: baseline,
    final: final,
    deltaPct: round(deltaPct),
    thresholdPct: threshold,
    breached: breached,
    notApplicable: false
  };
}

/**
 * Compare an absolute metric (percentage-point delta). Used for errorPct,
 * where a relative change is meaningless (baseline errorPct is often 0).
 */
function _compareAbsolute(name, baseline, final, thresholdPoints) {
  if (!isFiniteNumber(baseline) || !isFiniteNumber(final)) {
    return {
      name: name,
      baseline: baseline,
      final: final,
      deltaPoints: null,
      thresholdPoints: thresholdPoints,
      breached: false,
      notApplicable: true
    };
  }
  var deltaPoints = final - baseline;
  return {
    name: name,
    baseline: baseline,
    final: final,
    deltaPoints: round(deltaPoints, 4),
    thresholdPoints: thresholdPoints,
    breached: deltaPoints > thresholdPoints,
    notApplicable: false
  };
}

/**
 * Compare baseline vs final metrics and return a PASS/WARN verdict.
 *
 * @param {object} baselineMetrics - From extractMetrics (or null)
 * @param {object} finalMetrics - From extractMetrics (or null)
 * @param {object} [thresholds] - Threshold overrides
 * @returns {object} { verdict, thresholds, baseline, final, metrics[] }
 */
function comparePerf(baselineMetrics, finalMetrics, thresholds) {
  var t = loadThresholds(thresholds);

  var b = baselineMetrics || null;
  var f = finalMetrics || null;

  var metrics = [
    _compareRelative('throughput', b && b.throughput, f && f.throughput, t.throughputPct, 'lower'),
    _compareRelative('pct3ResTime', b && b.pct3ResTime, f && f.pct3ResTime, t.pct3ResTimePct, 'higher'),
    _compareAbsolute('errorPct', b && b.errorPct, f && f.errorPct, t.errorPctPoints)
  ];

  var breached = metrics.some(function (m) { return m.breached; });

  return {
    verdict: breached ? 'WARN' : 'PASS',
    thresholds: t,
    baseline: b,
    final: f,
    metrics: metrics
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  loadThresholds,
  extractMetrics,
  readStatisticsFile,
  comparePerf
};
