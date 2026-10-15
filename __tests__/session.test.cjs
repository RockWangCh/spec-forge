/**
 * Session marker tests — per-session active-TS marker.
 *
 * Run: node --test __tests__/session.test.cjs
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionLib = require(path.join(__dirname, '..', 'scripts', 'session.cjs'));

const SID = '2c41db36-d855-45f4-af61-c0085149388f';
const OTHER_SID = 'a6d83924-aaaa-bbbb-cccc-dddddddddddd';

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-session-'));
}

function withSessionId(sid, fn) {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  if (sid === null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = sid;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
}

test('writeSessionActiveTS records the TS, readable back in the same session', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    assert.strictEqual(sessionLib.writeSessionActiveTS(ts, root), true);
    assert.strictEqual(sessionLib.readSessionActiveTS(root), ts);
    // marker lives at specs/session-active/<sid>, content is the plain TS
    const file = path.join(root, 'specs', 'session-active', SID);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), ts);
  });
});

test('readSessionActiveTS returns null when no marker written', () => {
  withSessionId(SID, () => {
    const root = tmpProject();
    assert.strictEqual(sessionLib.readSessionActiveTS(root), null);
    assert.strictEqual(sessionLib.hasSessionActiveTS(root), false);
  });
});

test('fail-closed: no CLAUDE_CODE_SESSION_ID → write is a no-op, read is null', () => {
  withSessionId(null, () => {
    const root = tmpProject();
    const ts = '20260818-165553-2i5b';
    assert.strictEqual(sessionLib.writeSessionActiveTS(ts, root), false);
    assert.strictEqual(sessionLib.readSessionActiveTS(root), null);
    assert.strictEqual(sessionLib.hasSessionActiveTS(root), false);
    // the failed write must not create any specs dir
    assert.strictEqual(fs.existsSync(path.join(root, 'specs')), false);
  });
});

test('sessions are isolated: another session cannot read my marker in the same project', () => {
  const root = tmpProject();
  withSessionId(SID, () => {
    sessionLib.writeSessionActiveTS('20260818-165553-2i5b', root);
  });
  withSessionId(OTHER_SID, () => {
    assert.strictEqual(sessionLib.readSessionActiveTS(root), null);
    assert.strictEqual(sessionLib.hasSessionActiveTS(root), false);
  });
  // and the original session can still read it back
  withSessionId(SID, () => {
    assert.strictEqual(sessionLib.readSessionActiveTS(root), '20260818-165553-2i5b');
  });
});
