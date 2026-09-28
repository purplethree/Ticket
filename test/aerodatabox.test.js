'use strict';

/**
 * Backend tests with the AeroDataBox provider against a local stand-in
 * (test-support/mock-aerodatabox.js): instance selection, unit usage,
 * error messages, and that the API key never leaves the server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockAeroDataBox, MOCK_ADB_KEY } = require('../test-support/mock-aerodatabox');
const { AeroDataBoxProvider, _internal } = require('../providers/aerodatabox');
const { createProvider } = require('../providers');
const { createApp } = require('../server');

const quietLogger = { warn() {}, error() {}, log() {} };
let mock;
let mockPort;

test.before(async () => {
  mock = createMockAeroDataBox();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  mockPort = mock.server.address().port;
});
test.after(() => mock.server.close());

async function withApp(apiKey, fn) {
  const provider = new AeroDataBoxProvider({ apiKey, baseUrl: `http://127.0.0.1:${mockPort}`, logger: quietLogger });
  const srv = createApp({ provider, sitePassword: '' }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  try {
    await fn(get);
  } finally {
    srv.close();
  }
}

const calls = () => mock.stats.total;

test('search picks the airborne EY416 with one API unit and parses everything', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const before = calls();
    const r = await get('/api/search?flight=EY416');
    assert.equal(r.status, 200);
    assert.equal(calls() - before, 1, 'only the "nearest" lookup was needed');
    assert.ok(!r.text.includes(MOCK_ADB_KEY), 'API key never reaches the browser');
    assert.equal(r.json.reason, 'airborne');
    const f = r.json.candidates.find((c) => c.id === r.json.selectedId);
    assert.equal(f.provider, 'aerodatabox');
    assert.equal(f.status.code, 'airborne');
    assert.equal(f.flight.iata, 'EY416');
    assert.equal(f.flight.number, '416');
    assert.equal(f.flight.airlineName, 'Etihad');
    assert.equal(f.departure.iata, 'AUH');
    assert.equal(f.arrival.iata, 'HKT');
    assert.equal(f.departure.utcOffsetMin, 240);
    assert.equal(f.arrival.utcOffsetMin, 420);
    assert.equal(f.departure.timezone, 'Asia/Dubai');
    assert.equal(f.departure.lat, 24.433);
    assert.equal(f.arrival.lng, 98.3169);
    assert.equal(f.departure.gate, 'A6');
    assert.equal(f.departure.terminal, 'A');
    assert.equal(f.arrival.gate, null, 'missing gate stays null');
    assert.ok(f.departure.actual > f.departure.scheduled, 'take-off (runway) time is the actual departure');
    assert.ok(f.arrival.estimated > f.arrival.scheduled, 'revised arrival is the estimate');
    assert.equal(f.arrival.actual, null);
    assert.equal(f.aircraft.registration, 'A6-AEF');
    assert.equal(f.aircraft.name, 'Airbus A321 NEO');
    assert.ok(f.position, 'live position attached');
    assert.equal(f.position.altitudeM, 11278);
    assert.equal(f.position.speedKmh, 842);
    assert.equal(f.position.heading, 118);
    assert.ok(f.position.updated > Date.now() - 5 * 60e3);
  });
});

test('ICAO call sign search works too', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const r = await get('/api/search?flight=ETD416');
    assert.equal(r.status, 200);
    assert.equal(r.json.reason, 'airborne');
    assert.ok(mock.stats.paths.includes('/flights/callsign/ETD416'));
  });
});

test('search with a date queries that day and selects its instance', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const first = await get('/api/search?flight=EY416');
    const sel = first.json.candidates.find((c) => c.id === first.json.selectedId);
    const tomorrow = new Date(sel.departure.scheduled + 24 * 3600e3 + 240 * 60e3).toISOString().slice(0, 10);
    const r = await get(`/api/search?flight=EY416&date=${tomorrow}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.reason, 'date');
    const f = r.json.candidates.find((c) => c.id === r.json.selectedId);
    assert.equal(f.status.code, 'scheduled');
    assert.equal(f.localDate, tomorrow);
  });
});

test('refresh by departure date returns the same instance for one unit', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const s = await get('/api/search?flight=EY416');
    const sel = s.json.candidates.find((c) => c.id === s.json.selectedId);
    const before = calls();
    const r = await get(`/api/flight?flight=EY416&dep=AUH&arr=HKT&sched=${sel.departure.scheduled}&date=${sel.localDate}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.instance.id, sel.id);
    assert.ok(r.json.instance.position);
    assert.equal(calls() - before, 1);
  });
});

test('when nothing is active, the neighbouring day is fetched and the user picks', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const before = calls();
    const r = await get('/api/search?flight=LD1');
    assert.equal(r.status, 200);
    assert.equal(r.json.selectedId, null);
    assert.equal(r.json.reason, 'no_active');
    assert.match(r.json.message, /Couldn't find an active LD1\. Choose another flight instance below\./);
    assert.equal(r.json.candidates.length, 2);
    assert.equal(calls() - before, 2);
  });
});

test('boarding status comes from the data', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const r = await get('/api/search?flight=BD1');
    const f = r.json.candidates.find((c) => c.id === r.json.selectedId);
    assert.equal(f.status.code, 'scheduled');
    assert.equal(f.status.detail, 'boarding');
  });
});

test('errors become friendly messages naming AeroDataBox', async () => {
  await withApp(MOCK_ADB_KEY, async (get) => {
    const nf = await get('/api/search?flight=XX999');
    assert.equal(nf.status, 404);
    assert.match(nf.json.error.message, /Couldn't find a flight XX999/);

    const rl = await get('/api/search?flight=RL1');
    assert.equal(rl.status, 429);
    assert.equal(rl.json.error.code, 'RATE_LIMIT');

    const qt = await get('/api/search?flight=QT1');
    assert.equal(qt.status, 429);
    assert.equal(qt.json.error.code, 'QUOTA_EXCEEDED');
    assert.match(qt.json.error.message, /Your AeroDataBox plan's monthly allowance has run out/);

    const ns = await get('/api/search?flight=NS1');
    assert.equal(ns.json.error.code, 'NOT_SUBSCRIBED');
    assert.match(ns.json.error.message, /subscribe to the free Basic plan/);
  });
  await withApp('wrong-key-zzzzzzzz', async (get) => {
    const r = await get('/api/search?flight=EY416');
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'INVALID_API_KEY');
    assert.match(r.json.error.message, /AeroDataBox rejected the API key\. Check AERODATABOX_API_KEY/);
    assert.ok(!r.text.includes('wrong-key-zzzzzzzz'));
  });
  await withApp('', async (get) => {
    const cfg = await get('/api/config');
    assert.equal(cfg.json.liveAvailable, false);
    assert.equal(cfg.json.keyEnv, 'AERODATABOX_API_KEY');
    const r = await get('/api/search?flight=EY416');
    assert.equal(r.json.error.code, 'NO_API_KEY');
    assert.match(r.json.error.message, /AERODATABOX_API_KEY/);
  });
});

test('provider is chosen from the settings', () => {
  assert.equal(createProvider({}).name, 'aerodatabox');
  assert.equal(createProvider({ AERODATABOX_API_KEY: 'k' }).name, 'aerodatabox');
  assert.equal(createProvider({ AIRLABS_API_KEY: 'k' }).name, 'airlabs');
  assert.equal(createProvider({ AERODATABOX_API_KEY: 'k', FLIGHT_PROVIDER: 'airlabs' }).name, 'airlabs');
});

test('AeroDataBox field parsing', () => {
  assert.equal(_internal.parseUtc('2026-09-28 00:15Z'), Date.UTC(2026, 8, 28, 0, 15));
  assert.equal(_internal.parseUtc('2026-09-28 00:15'), Date.UTC(2026, 8, 28, 0, 15));
  assert.equal(_internal.parseUtc(''), null);
  assert.equal(_internal.offsetOf({ local: '2026-09-28 04:15+04:00' }), 240);
  assert.equal(_internal.offsetOf({ local: '2026-09-28 04:15-03:30' }), -210);
  assert.deepEqual(_internal.splitNumber('EY 416'), { iata: 'EY416', number: '416' });
  assert.deepEqual(_internal.splitNumber('9W 0123'), { iata: '9W123', number: '123' });
  assert.equal(_internal.normalizeStatus('EnRoute').code, 'airborne');
  assert.equal(_internal.normalizeStatus('Approaching').detail, 'approaching');
  assert.equal(_internal.normalizeStatus('Arrived').code, 'landed');
  assert.equal(_internal.normalizeStatus('CanceledUncertain').code, 'cancelled');
  assert.equal(_internal.normalizeStatus('SomethingNew').code, 'unknown');
});
