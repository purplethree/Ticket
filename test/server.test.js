'use strict';

/**
 * End-to-end tests of the backend against a local AirLabs stand-in
 * (test-support/mock-airlabs.js). Verifies instance selection, error
 * handling, and that the API key never leaves the server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockAirLabs, MOCK_KEY } = require('../test-support/mock-airlabs');
const { AirLabsProvider } = require('../providers/airlabs');
const { createApp } = require('../server');

const quietLogger = { warn() {}, error() {}, log() {} };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

let mock;
let mockPort;
let appServer;
let base;

async function startApp(apiKey) {
  const provider = new AirLabsProvider({ apiKey, baseUrl: `http://127.0.0.1:${mockPort}`, logger: quietLogger });
  const srv = createApp({ provider }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}`, provider };
}

test.before(async () => {
  mock = createMockAirLabs();
  mockPort = await listen(mock.server);
  const app = await startApp(MOCK_KEY);
  appServer = app.srv;
  base = app.base;
});

test.after(() => {
  appServer.close();
  mock.server.close();
});

async function get(path, b = base) {
  const res = await fetch(b + path);
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

test('config reports live availability without exposing the key', async () => {
  const r = await get('/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.liveAvailable, true);
  assert.ok(!r.text.includes(MOCK_KEY));
});

test('search picks the airborne EY416, not yesterday\'s or tomorrow\'s', async () => {
  const r = await get('/api/search?flight=ey%20416');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(MOCK_KEY), 'API key must never reach the browser');
  assert.equal(r.json.reason, 'airborne');
  assert.equal(r.json.candidates.length, 3);
  const sel = r.json.candidates.find((c) => c.id === r.json.selectedId);
  assert.equal(sel.status.code, 'airborne');
  assert.equal(sel.departure.iata, 'AUH');
  assert.equal(sel.arrival.iata, 'HKT');
  assert.equal(sel.departure.gate, 'A6');
  assert.equal(sel.departure.terminal, 'A');
  assert.equal(sel.arrival.gate, null, 'empty gate stays null, never invented');
  assert.equal(sel.arrival.terminal, null);
  assert.equal(sel.aircraft.registration, 'A6-AEF');
  assert.equal(sel.aircraft.name, 'Airbus A321neo');
  assert.equal(sel.departure.utcOffsetMin, 240);
  assert.equal(sel.arrival.utcOffsetMin, 420);
  assert.ok(Number.isFinite(sel.departure.lat) && Number.isFinite(sel.arrival.lng), 'airport coordinates enriched');
  assert.ok(sel.position && Number.isFinite(sel.position.lat), 'live position attached');
  assert.equal(sel.position.altitudeM, 11278);
  assert.equal(sel.flight.airlineName, 'Etihad Airways');
  const tiers = r.json.candidates.map((c) => c.tier);
  assert.equal(tiers[0], 'airborne');
  assert.ok(tiers.includes('completed'), 'yesterday is listed as completed');
  // Tomorrow's instance departs in 20 h: "today" or "future" depending on the local clock at AUH.
  assert.ok(tiers.includes('future') || tiers.includes('today'));
});

test('search with a date for tomorrow selects tomorrow\'s instance', async () => {
  const first = await get('/api/search?flight=EY416');
  const tomorrow = first.json.candidates.find((c) => c.status.code === 'scheduled');
  const r = await get(`/api/search?flight=EY416&date=${tomorrow.localDate}`);
  assert.equal(r.json.selectedId, tomorrow.id);
  assert.equal(r.json.reason, 'date');
});

test('search with a date that has no flight asks the user to choose', async () => {
  const r = await get('/api/search?flight=EY416&date=2031-01-01');
  assert.equal(r.status, 200);
  assert.equal(r.json.selectedId, null);
  assert.equal(r.json.reason, 'date_mismatch');
  assert.match(r.json.message, /Choose another flight instance below/);
});

test('refresh returns the same instance with updated data', async () => {
  const s = await get('/api/search?flight=EY416');
  const sel = s.json.candidates.find((c) => c.id === s.json.selectedId);
  const r = await get(`/api/flight?flight=EY416&dep=AUH&arr=HKT&sched=${sel.departure.scheduled}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.instance.id, sel.id);
  assert.ok(r.json.instance.position);
  assert.ok(!r.text.includes(MOCK_KEY));
});

test('refresh of yesterday\'s instance falls back to the schedule', async () => {
  const s = await get('/api/search?flight=EY416');
  const past = s.json.candidates.find((c) => c.tier === 'completed');
  const r = await get(`/api/flight?flight=EY416&dep=AUH&sched=${past.departure.scheduled}`);
  assert.equal(r.json.instance.id, past.id);
  assert.equal(r.json.instance.status.code, 'landed');
});

test('invalid flight numbers are rejected before any API call', async () => {
  const before = mock.stats.total;
  const r = await get('/api/search?flight=hello!!');
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INVALID_FLIGHT');
  assert.equal(mock.stats.total, before);
});

test('unknown flight gives a clean 404 message', async () => {
  const r = await get('/api/search?flight=XX999');
  assert.equal(r.status, 404);
  assert.match(r.json.error.message, /Couldn't find a flight XX999/);
  assert.ok(!/not_found|airlabs/i.test(r.json.error.message), 'no raw upstream error text');
});

test('rate limit and quota errors are mapped to friendly 429s', async () => {
  const a = await get('/api/search?flight=RL1');
  assert.equal(a.status, 429);
  assert.equal(a.json.error.code, 'RATE_LIMIT');
  const b = await get('/api/search?flight=QT1');
  assert.equal(b.status, 429);
  assert.equal(b.json.error.code, 'QUOTA_EXCEEDED');
});

test('a wrong API key is reported without leaking it', async () => {
  const app = await startApp('wrong-key-987654');
  try {
    const r = await get('/api/search?flight=EY416', app.base);
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'INVALID_API_KEY');
    assert.ok(!r.text.includes('wrong-key-987654'));
  } finally {
    app.srv.close();
  }
});

test('a missing API key is reported as not configured', async () => {
  const app = await startApp('');
  try {
    const cfg = await get('/api/config', app.base);
    assert.equal(cfg.json.liveAvailable, false);
    const r = await get('/api/search?flight=EY416', app.base);
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'NO_API_KEY');
  } finally {
    app.srv.close();
  }
});

test('network failure to the provider is a clean 502', async () => {
  const provider = new AirLabsProvider({ apiKey: MOCK_KEY, baseUrl: 'http://127.0.0.1:9', logger: quietLogger });
  const srv = createApp({ provider }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const r = await get('/api/search?flight=EY416', `http://127.0.0.1:${srv.address().port}`);
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'NETWORK');
  } finally {
    srv.close();
  }
});

test('repeated identical requests are served from cache (no duplicate API calls)', async () => {
  await get('/api/search?flight=EY416');
  const before = { ...mock.stats.byEndpoint };
  await get('/api/search?flight=EY416');
  await get('/api/search?flight=EY416');
  assert.deepEqual(mock.stats.byEndpoint, before);
});
