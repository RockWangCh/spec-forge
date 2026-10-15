/**
 * spec-forge — Logger
 * Structured logging to stderr + optional pipeline.log file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sessionLib = require('./session.cjs');

const logger = (function () {
  let prefix = '[harness]';
  let logFilePath = null;
  const VALID_LEVELS = new Set(['ERROR', 'WARN', 'INFO', 'DEBUG']);

  function readSessionTsForLog() {
    // No global .active anymore — fall back to the session marker (Claude Code
    // only). Explicit setLogPath(ts) from init/update takes precedence.
    try {
      const projectRoot = process.env.PROJECT_DIR || process.cwd();
      const ts = sessionLib.readSessionActiveTS(projectRoot);
      if (ts && /^\d{8}-\d{6}(?:-[a-z0-9]{4})?$/.test(ts)) return ts;
    } catch (_) { /* fail-open */ }
    return null;
  }

  function ensureLogFile() {
    if (logFilePath) return;
    const projectRoot = process.env.PROJECT_DIR || process.cwd();
    const ts = readSessionTsForLog();
    if (ts) {
      const tsDir = path.join(projectRoot,  'specs', ts);
      try {
        if (!fs.existsSync(tsDir)) fs.mkdirSync(tsDir, { recursive: true });
        logFilePath = path.join(tsDir, 'pipeline.log');
        return;
      } catch (_) { /* fall through */ }
    }
    const logsDir = path.join(projectRoot,  'logs');
    try {
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      logFilePath = path.join(logsDir, 'pipeline.log');
    } catch (_) {
      logFilePath = null;
    }
  }

  function appendToLogFile(line) {
    if (!logFilePath) return;
    try {
      const ts = new Date().toISOString();
      fs.appendFileSync(logFilePath, ts + ' ' + line + '\n', 'utf8');
    } catch (_) { /* ignore */ }
  }

  function normalizeLevel(level) {
    const upper = String(level || '').toUpperCase();
    return VALID_LEVELS.has(upper) ? upper : 'INFO';
  }

  function log(level, message, data) {
    ensureLogFile();
    const normalizedLevel = normalizeLevel(level);
    let line = prefix + ' [' + normalizedLevel + '] ' + message;
    if (data !== undefined && data !== null) {
      try { line += ' ' + JSON.stringify(data); }
      catch (_) { line += ' [unserializable]'; }
    }
    process.stderr.write(line + '\n');
    appendToLogFile(line);
  }

  return {
    log: log,
    info: function (m, d) { log('INFO', m, d); },
    warn: function (m, d) { log('WARN', m, d); },
    error: function (m, d) { log('ERROR', m, d); },
    debug: function (m, d) { log('DEBUG', m, d); },
    setPrefix: function (p) { prefix = String(p); },
    setLogPath: function (ts) {
      if (!ts) return;
      const projectRoot = process.env.PROJECT_DIR || process.cwd();
      const tsDir = path.join(projectRoot,  'specs', ts);
      try {
        if (!fs.existsSync(tsDir)) fs.mkdirSync(tsDir, { recursive: true });
        logFilePath = path.join(tsDir, 'pipeline.log');
      } catch (_) { /* keep current */ }
    },
    resetLogPath: function () { logFilePath = null; }
  };
})();

module.exports = { logger };
