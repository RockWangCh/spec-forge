const test = require('node:test');
const assert = require('node:assert').strict;
const fs = require('fs');
const path = require('path');
const logger = require('../scripts/event-logger.cjs');

test('event logger roundtrip', (t) => {
  const tmpTs = 'ut-' + Date.now().toString(36);
  try {
    const ev = {
      task_id: 'task-1',
      actor_id: 'orchestrator-1',
      actor_type: 'orchestrator',
      event_type: 'dispatch',
      payload: { agent: 'implementer', job_id: 'J1' }
    };

    const res = logger.logEvent(ev, process.cwd(), tmpTs);
    assert.ok(res.event_id, 'event_id should be set by logger');
    assert.ok(res.timestamp, 'timestamp should be set by logger');

    const events = logger.readEvents(process.cwd(), tmpTs);
    assert.ok(Array.isArray(events) && events.length >= 1, 'events.log should contain at least one event');

    const first = events[0];
    assert.equal(first.task_id, 'task-1');

    const replay = logger.replayEvents(process.cwd(), tmpTs);
    const found = replay.find(r => r.trace_id === first.trace_id);
    assert.ok(found, 'replay should include the trace for the event');
    assert.ok(Array.isArray(found.events) && found.events.length >= 1, 'trace events should be present');
  } finally {
    // cleanup
    const dir = path.join(process.cwd(), 'specs', tmpTs);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
