#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const writeQueue = [];
let flushRunning = false;
const metricsState = { written: 0, failed: 0, queued: 0 };

function genId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xfffff).toString(16);
  return (prefix ? prefix + '-' : '') + t + '-' + r;
}

function ensureSpecsDir(projectRoot, ts) {
  const dir = path.join(projectRoot, 'specs', ts);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = Array.isArray(payload) ? [] : {};
  const secretKeyRe = /token|secret|password|passwd|apikey|api_key/i;
  for (const k of Object.keys(payload)) {
    try {
      const v = payload[k];
      if (secretKeyRe.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      if (typeof v === 'string') {
        if (v.length > 2000) out[k] = v.slice(0, 2000) + '...[truncated]';
        else out[k] = v;
      } else {
        out[k] = v;
      }
    } catch (_) {
      out[k] = payload[k];
    }
  }
  return out;
}

async function _flushFileAsync(file) {
  if (flushRunning) return;
  flushRunning = true;
  while (writeQueue.length) {
    const item = writeQueue.shift();
    metricsState.queued = writeQueue.length;
    try {
      await fsp.appendFile(item.file, item.line + '\n', 'utf8');
      metricsState.written += 1;
    } catch (_) {
      metricsState.failed += 1;
    }
  }
  flushRunning = false;
}

function _flushFileSync(file) {
  const lines = [];
  for (let i = writeQueue.length - 1; i >= 0; i--) {
    if (writeQueue[i].file === file) {
      lines.push(writeQueue[i].line);
      writeQueue.splice(i, 1);
    }
  }
  metricsState.queued = writeQueue.length;
  while (lines.length) {
    const line = lines.pop();
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
      metricsState.written += 1;
    } catch (_) {
      metricsState.failed += 1;
    }
  }
}

function logEvent(event, projectRoot = process.cwd(), ts) {
  if (!event) throw new Error('event is required');

  if (!event.event_id) {
    try { event.event_id = (crypto.randomUUID && crypto.randomUUID()) || genId('evt'); }
    catch (_) { event.event_id = genId('evt'); }
  }
  if (!event.timestamp) event.timestamp = new Date().toISOString();
  if (!event.trace_id) event.trace_id = event.task_id || genId('trace');
  if (!event.task_id) event.task_id = event.trace_id;
  if (!event.event_schema) event.event_schema = 'eventlog.v1';
  if (event.payload) event.payload = sanitizePayload(event.payload);

  const usedTs = ts || (event.ts ? String(event.ts) : new Date().toISOString().replace(/[:.]/g, '-'));
  const dir = ensureSpecsDir(projectRoot, usedTs);
  const file = path.join(dir, 'events.log');

  const line = JSON.stringify(event);
  writeQueue.push({ file, line });
  metricsState.queued = writeQueue.length;
  _flushFileAsync(file).catch(() => {});

  return Object.assign({}, event, { _log_path: file, _queued: true });
}

function flush(projectRoot = process.cwd(), ts, timeoutMs = 2000) {
  const file = path.join(projectRoot, 'specs', ts, 'events.log');
  const start = Date.now();
  if (!writeQueue.length && !flushRunning) return Promise.resolve();

  return new Promise((resolve) => {
    const check = async () => {
      try { await _flushFileAsync(file); } catch (_) {}
      if (!writeQueue.length && !flushRunning) return resolve();
      if (Date.now() - start > timeoutMs) {
        try { _flushFileSync(file); } catch (_) {}
        return resolve();
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function flushSync(projectRoot = process.cwd(), ts) {
  const file = path.join(projectRoot, 'specs', ts, 'events.log');
  try { _flushFileAsync(file); } catch (_) {}
  try { _flushFileSync(file); } catch (_) {}
}

function readEvents(projectRoot = process.cwd(), ts) {
  const file = path.join(projectRoot, 'specs', ts, 'events.log');
  if (!fs.existsSync(file)) return [];
  const data = fs.readFileSync(file, 'utf8').trim();
  if (!data) return [];
  return data.split('\n').map((line) => JSON.parse(line));
}

function replayEvents(projectRoot = process.cwd(), ts) {
  const events = readEvents(projectRoot, ts);
  const byTrace = new Map();
  for (const event of events) {
    const traceId = event.trace_id || event.task_id || 'root';
    if (!byTrace.has(traceId)) byTrace.set(traceId, []);
    byTrace.get(traceId).push(event);
  }

  const result = [];
  for (const [traceId, traceEvents] of byTrace.entries()) {
    result.push({
      trace_id: traceId,
      events: traceEvents,
      dag: traceEvents.map((event) => ({ id: event.event_id, label: event.event_type, parent: event.parent_event_id || null }))
    });
  }
  return result;
}

function metrics() {
  return { written: metricsState.written, failed: metricsState.failed, queued: metricsState.queued };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'log') {
    const argMap = {};
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      const m = a.match(/^--([^=]+)=?(.*)$/);
      if (m) argMap[m[1]] = m[2] || '';
    }
    const ts = argMap['ts'];
    const json = argMap['json'] || argMap['event'];
    if (!json) {
      console.error('Provide --json=<event-json-string>');
      process.exit(2);
    }
    let ev;
    try { ev = JSON.parse(json); } catch (e) { console.error('invalid json'); process.exit(2); }
    const res = logEvent(ev, process.cwd(), ts);
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }

  if (cmd === 'read') {
    const tsArg = argv[1];
    if (!tsArg) { console.error('Usage: node scripts/event-logger.cjs read <TS>'); process.exit(2); }
    const events = readEvents(process.cwd(), tsArg);
    console.log(JSON.stringify(events, null, 2));
    process.exit(0);
  }

  if (cmd === 'replay') {
    const tsArg = argv[1];
    if (!tsArg) { console.error('Usage: node scripts/event-logger.cjs replay <TS>'); process.exit(2); }
    const replay = replayEvents(process.cwd(), tsArg);
    console.log(JSON.stringify(replay, null, 2));
    process.exit(0);
  }

  console.error('Usage: log | read | replay');
  process.exit(2);
}

module.exports = { logEvent, readEvents, replayEvents, genId, ensureSpecsDir, flush, flushSync, metrics };
