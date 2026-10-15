#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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

function logEvent(event, projectRoot = process.cwd(), ts) {
  if (!event) throw new Error('event is required');
  if (!event.event_id) event.event_id = genId('evt');
  if (!event.timestamp) event.timestamp = new Date().toISOString();
  if (!event.trace_id) event.trace_id = event.task_id || genId('trace');
  if (!event.task_id) event.task_id = event.trace_id;
  const usedTs = ts || (event.ts ? String(event.ts) : new Date().toISOString().replace(/[:.]/g, '-'));
  const dir = ensureSpecsDir(projectRoot, usedTs);
  const file = path.join(dir, 'events.log');
  fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  return Object.assign({}, event, { _log_path: file });
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
    result.push({ trace_id: traceId, events: traceEvents, dag: traceEvents.map((event) => ({ id: event.event_id, label: event.event_type, parent: event.parent_event_id || null })) });
  }
  return result;
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

module.exports = { logEvent, readEvents, replayEvents, genId, ensureSpecsDir };
