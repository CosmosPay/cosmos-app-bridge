// Bridge tests: fully offline. A hand-rolled fake window stands in for the
// browser, which also makes the security assertions exact: every postMessage is
// recorded with the targetOrigin it was actually called with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppBridge, createHostBridge, READY } from '../dist/index.js';

const ADMIN = 'https://admin.cosmospay.lat';
const APP = 'https://apps.cosmospay.lat';
const ENVELOPE = '__cosmos_bridge__';

/**
 * Installs a fake `window` and returns the controls to drive it.
 *
 * `sent` records every postMessage as { data, targetOrigin }, which is what
 * lets a test assert that a wildcard was never used.
 */
function fakeWindow({ inFrame = true } = {}) {
  const listeners = new Set();
  const sent = [];

  const parentWindow = {
    postMessage: (data, targetOrigin) => sent.push({ data, targetOrigin }),
  };

  const win = {
    addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
    removeEventListener: (type, fn) => type === 'message' && listeners.delete(fn),
    location: { href: ADMIN + '/' },
  };
  win.parent = inFrame ? parentWindow : win;

  globalThis.window = win;

  return {
    sent,
    listenerCount: () => listeners.size,
    /** Simulates a message arriving from `origin`. */
    deliver(data, origin) {
      for (const fn of [...listeners]) fn({ data, origin });
    },
  };
}

/** An envelope as the other end would really send it. */
function envelope(type, payload, clientId = 'demo-app', correlationId) {
  return { [ENVELOPE]: true, type, payload, clientId, correlationId };
}

function cleanup() {
  delete globalThis.window;
}

// ── The origin gate ──────────────────────────────────────────────────────────

test('a message from an untrusted origin never reaches a handler', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  let called = 0;
  const rejected = [];
  bridge.subscribe('store:info', () => { called += 1; });

  w.deliver(envelope('store:info', { id: 1 }), 'https://evil.example');

  assert.equal(called, 0, 'the handler must not run');
  bridge.destroy();
  cleanup();
});

test('a message from the trusted origin does reach the handler', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  let got = null;
  bridge.subscribe('store:info', (payload) => { got = payload; });

  w.deliver(envelope('store:info', { id: 7 }), ADMIN);

  assert.deepEqual(got, { id: 7 });
  bridge.destroy();
  cleanup();
});

test('rejection reasons are reported, not swallowed', () => {
  const w = fakeWindow();
  const reasons = [];
  const bridge = createAppBridge({
    clientId: 'demo-app',
    allowedOrigins: ADMIN,
    onRejected: (reason) => reasons.push(reason),
  });

  w.deliver(envelope('x'), 'https://evil.example');       // untrusted-origin
  w.deliver({ type: 'x' }, ADMIN);                        // not-a-bridge-message
  w.deliver(envelope('x', null, 'other-app'), ADMIN);     // other-client

  assert.deepEqual(reasons, [
    'untrusted-origin',
    'not-a-bridge-message',
    'other-client',
  ]);
  bridge.destroy();
  cleanup();
});

test('an allowlist of several origins accepts each of them', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({
    clientId: 'demo-app',
    allowedOrigins: [ADMIN, 'https://staging.cosmospay.lat'],
  });

  let count = 0;
  bridge.subscribe('ping', () => { count += 1; });

  w.deliver(envelope('ping'), ADMIN);
  w.deliver(envelope('ping'), 'https://staging.cosmospay.lat');
  w.deliver(envelope('ping'), 'https://elsewhere.example');

  assert.equal(count, 2);
  bridge.destroy();
  cleanup();
});

// ── The wildcard, which is the whole point ───────────────────────────────────

test('nothing is ever sent with a wildcard target origin', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  bridge.send('one', { a: 1 });
  bridge.send('two');
  bridge.request('three').catch(() => {});

  assert.ok(w.sent.length >= 3, 'messages were sent');
  for (const { targetOrigin } of w.sent) {
    assert.notEqual(targetOrigin, '*', 'a wildcard target origin was used');
    assert.equal(targetOrigin, ADMIN);
  }
  bridge.destroy();
  cleanup();
});

test('a policy that names no concrete origin is refused at construction', () => {
  fakeWindow();
  assert.throws(
    () => createAppBridge({
      clientId: 'demo-app',
      allowedOrigins: (o) => o.endsWith('.cosmospay.lat'),
    }),
    /at least one concrete origin/,
  );
  cleanup();
});

test('creating the app side outside a frame fails loudly', () => {
  fakeWindow({ inFrame: false });
  assert.throws(
    () => createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN }),
    /inside a frame/,
  );
  cleanup();
});

// ── request / respond ────────────────────────────────────────────────────────

test('request resolves with the answer that carries its correlation id', async () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  const pending = bridge.request('auth:sessionToken');

  const asked = w.sent.find((m) => m.data.type === 'auth:sessionToken');
  assert.ok(asked.data.correlationId, 'the request carries a correlation id');

  w.deliver(
    envelope('auth:sessionToken', { token: 'abc' }, 'demo-app', asked.data.correlationId),
    ADMIN,
  );

  assert.deepEqual(await pending, { token: 'abc' });
  bridge.destroy();
  cleanup();
});

test('an answer with the wrong correlation id does not resolve the request', async () => {
  const w = fakeWindow();
  const bridge = createAppBridge({
    clientId: 'demo-app',
    allowedOrigins: ADMIN,
    timeoutMs: 60,
  });

  const pending = bridge.request('auth:sessionToken');
  w.deliver(envelope('auth:sessionToken', { token: 'wrong' }, 'demo-app', 'not-mine'), ADMIN);

  await assert.rejects(pending, /did not answer/);
  bridge.destroy();
  cleanup();
});

test('two concurrent requests of the same type do not cross answers', async () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  const uno = bridge.request('echo', 1);
  const dos = bridge.request('echo', 2);

  const enviados = w.sent.filter((m) => m.data.type === 'echo');
  assert.equal(enviados.length, 2);

  // Answered out of order on purpose.
  w.deliver(envelope('echo', 'second', 'demo-app', enviados[1].data.correlationId), ADMIN);
  w.deliver(envelope('echo', 'first', 'demo-app', enviados[0].data.correlationId), ADMIN);

  assert.equal(await uno, 'first');
  assert.equal(await dos, 'second');
  bridge.destroy();
  cleanup();
});

test('request rejects when the host stays silent', async () => {
  fakeWindow();
  const bridge = createAppBridge({
    clientId: 'demo-app',
    allowedOrigins: ADMIN,
    timeoutMs: 40,
  });

  await assert.rejects(bridge.request('nobody:home'), /within 40ms/);
  bridge.destroy();
  cleanup();
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('ready resolves when the host answers the greeting', async () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  assert.ok(w.sent.some((m) => m.data.type === READY), 'the frame greets on creation');

  w.deliver(envelope(READY, undefined, 'demo-app'), ADMIN);
  await bridge.ready();

  bridge.destroy();
  cleanup();
});

test('unsubscribing twice is harmless and stops delivery once', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  let count = 0;
  const off = bridge.subscribe('tick', () => { count += 1; });

  w.deliver(envelope('tick'), ADMIN);
  off();
  off();
  w.deliver(envelope('tick'), ADMIN);

  assert.equal(count, 1);
  bridge.destroy();
  cleanup();
});

test('a handler can unsubscribe itself while being called', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  let count = 0;
  const off = bridge.subscribe('once', () => { count += 1; off(); });

  w.deliver(envelope('once'), ADMIN);
  w.deliver(envelope('once'), ADMIN);

  assert.equal(count, 1);
  bridge.destroy();
  cleanup();
});

test('destroy removes the window listener', () => {
  const w = fakeWindow();
  const bridge = createAppBridge({ clientId: 'demo-app', allowedOrigins: ADMIN });

  assert.equal(w.listenerCount(), 1);
  bridge.destroy();
  assert.equal(w.listenerCount(), 0);
  cleanup();
});

// ── The host side ────────────────────────────────────────────────────────────

test('the host answers a request and never uses a wildcard', async () => {
  const w = fakeWindow();
  const enviados = [];
  const frame = {
    src: APP + '/index.html',
    contentWindow: {
      postMessage: (data, targetOrigin) => enviados.push({ data, targetOrigin }),
    },
  };

  const host = createHostBridge({
    clientId: 'demo-app',
    allowedOrigins: APP,
    frame,
  });

  host.respond('auth:sessionToken', () => ({ token: 'minted' }));
  w.deliver(envelope('auth:sessionToken', undefined, 'demo-app', 'cid-1'), APP);

  await new Promise((r) => setTimeout(r, 10));

  const respuesta = enviados.find((m) => m.data.correlationId === 'cid-1');
  assert.ok(respuesta, 'the host answered');
  assert.deepEqual(respuesta.data.payload, { token: 'minted' });
  assert.equal(respuesta.targetOrigin, APP);
  assert.notEqual(respuesta.targetOrigin, '*');

  host.destroy();
  cleanup();
});

test('the host does not answer a message that was not a question', async () => {
  const w = fakeWindow();
  const enviados = [];
  const frame = {
    src: APP + '/index.html',
    contentWindow: { postMessage: (data) => enviados.push(data) },
  };

  const host = createHostBridge({ clientId: 'demo-app', allowedOrigins: APP, frame });
  host.respond('auth:sessionToken', () => ({ token: 'minted' }));

  // No correlation id: fire and forget, nobody is waiting.
  w.deliver(envelope('auth:sessionToken', undefined, 'demo-app'), APP);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(enviados.filter((d) => d.payload?.token).length, 0);
  host.destroy();
  cleanup();
});

test('a resolver that throws reports back instead of hanging the app', async () => {
  const w = fakeWindow();
  const enviados = [];
  const frame = {
    src: APP + '/index.html',
    contentWindow: { postMessage: (data) => enviados.push(data) },
  };

  const host = createHostBridge({ clientId: 'demo-app', allowedOrigins: APP, frame });
  host.respond('boom', () => { throw new Error('resolver failed'); });

  w.deliver(envelope('boom', undefined, 'demo-app', 'cid-9'), APP);
  await new Promise((r) => setTimeout(r, 10));

  const err = enviados.find((d) => d.type === 'boom:error');
  assert.ok(err, 'the failure was reported');
  assert.match(String(err.payload), /resolver failed/);
  assert.equal(err.correlationId, 'cid-9');

  host.destroy();
  cleanup();
});

test('the host refuses to send to a frame whose src is not allowed', async () => {
  const w = fakeWindow();
  const enviados = [];
  const frame = {
    src: 'https://evil.example/app.html',
    contentWindow: { postMessage: (data) => enviados.push(data) },
  };

  const host = createHostBridge({ clientId: 'demo-app', allowedOrigins: APP, frame });
  host.send('store:info', { id: 1 });

  assert.equal(enviados.length, 0, 'nothing was sent to an untrusted frame');
  host.destroy();
  cleanup();
});
