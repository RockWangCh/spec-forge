/**
 * spec-forge — HANDOFF marker parsing
 * Parses the HANDOFF_BEGIN … HANDOFF_END JSON block from agent output.
 */

'use strict';

/**
 * Parse the HANDOFF_BEGIN … HANDOFF_END JSON block from agent output.
 * Returns null when no valid HANDOFF block is found.
 * @param {string|null|undefined} text
 * @returns {object|null}
 */
function parseHandoff(text) {
  if (!text || typeof text !== 'string') return null;
  const startMarker = 'HANDOFF_BEGIN';
  const endMarker = 'HANDOFF_END';
  const startIdx = text.lastIndexOf(startMarker);
  if (startIdx === -1) return null;
  const jsonStart = startIdx + startMarker.length;
  const endIdx = text.indexOf(endMarker, jsonStart);
  if (endIdx === -1) return null;
  const jsonStr = text.substring(jsonStart, endIdx).trim();
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed.artifacts)) parsed.artifacts = [];
    if (!parsed.markers || typeof parsed.markers !== 'object') parsed.markers = {};
    if (!parsed.decision || typeof parsed.decision !== 'string') parsed.decision = null;
    parsed.artifacts = parsed.artifacts
      .filter(function (a) { return a && typeof a === 'object' && typeof a.path === 'string'; })
      .map(function (a) { return { path: a.path }; });
    return parsed;
  } catch (_) {
    return null;
  }
}

module.exports = { parseHandoff };
