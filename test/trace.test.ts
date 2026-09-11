import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionContext, buildTraceId, traceparentHeader } from '../src/trace';

test('same session_id + spanId always produces the identical traceparent', () => {
  const a = buildSessionContext('sess-1', 'span-1');
  const b = buildSessionContext('sess-1', 'span-1');
  assert.equal(a.traceId, b.traceId);
  assert.equal(a.spanId, b.spanId);
  assert.equal(traceparentHeader(a.traceId, a.spanId), traceparentHeader(b.traceId, b.spanId));
});

test('same session, different spanId (turn): same traceId (session), different spanId', () => {
  const turn1 = buildSessionContext('sess-1', 'span-1');
  const turn2 = buildSessionContext('sess-1', 'span-2');
  assert.equal(turn1.traceId, turn2.traceId);
  assert.notEqual(turn1.spanId, turn2.spanId);
});

test('different session_id produces a different traceId', () => {
  assert.notEqual(buildTraceId('sess-1'), buildTraceId('sess-2'));
});

test('buildTraceId is deterministic', () => {
  assert.equal(buildTraceId('sess-1'), buildTraceId('sess-1'));
});

test('session.id defaults to sessionId, or uses the explicit id if given', () => {
  const noId = buildSessionContext('sess-1', 'span-1');
  assert.equal(noId.id, 'sess-1');
  const withId = buildSessionContext('sess-1', 'span-1', 'prompt-xyz');
  assert.equal(withId.id, 'prompt-xyz');
});
