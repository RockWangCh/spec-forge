const test = require('node:test');
const assert = require('node:assert').strict;
const fs = require('fs');
const path = require('path');
const logger = require('../scripts/event-logger.cjs');

test('event logger async queue + flush + sanitize payload', async () => {
  const projectRoot = process.cwd();
  const tmpTs = 'ut-' + Date.now().toString(36);
  const dir = path.join(projectRoot, 'specs', tmpTs);

  try {
    const count = 50;
    for (let i = 0; i < count; i++) {
      logger.logEvent({
        event_type: 'test',
        actor_id: 'unit',
        payload: {
          i,
          secretToken: 'secret-' + i,
          safe: 'ok'
        }
      }, projectRoot, tmpTs);
    }

    await logger.flush(projectRoot, tmpTs, 3000);

    const events = logger.readEvents(projectRoot, tmpTs);
    assert.equal(Array.isArray(events), true, 'events should be array');
    assert.equal(events.length, count, 'should flush all queued writes');

    for (const ev of events) {
      assert.ok(ev.event_id, 'event_id present');
      assert.equal(ev.event_schema, 'eventlog.v1', 'schema present');
      assert.ok(ev.trace_id, 'trace_id present');
      if (ev.payload && Object.prototype.hasOwnProperty.call(ev.payload, 'secretToken')) {
        assert.equal(ev.payload.secretToken, '[REDACTED]');
      }
    }

    const m = logger.metrics();
    assert.ok(m.written >= count, 'write count should be at least event count');
  } finally {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
