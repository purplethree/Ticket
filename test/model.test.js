'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MIN = 60e3;
const HOUR = 60 * MIN;

let FlightTracker;
let geo;
let DemoClock;
let DemoFlight;
test.before(async () => {
  ({ FlightTracker } = await import('../public/js/model.js'));
  geo = await import('../public/js/geo.js');
  ({ DemoClock, DemoFlight } = await import('../public/js/demo.js'));
});

const AUH = { iata: 'AUH', lat: 24.433, lng: 54.6511, utcOffsetMin: 240 };
const HKT = { iata: 'HKT', lat: 8.1132, lng: 98.3169, utcOffsetMin: 420 };

function flight(now, overrides = {}) {
  const dep = now - 4 * HOUR;
  const arr = now + 2.5 * HOUR;
  return {
    id: 'X',
    flight: { iata: 'EY416' },
    status: { code: 'airborne', raw: 'en-route' },
    departure: { ...AUH, scheduled: dep, estimated: dep, actual: dep },
    arrival: { ...HKT, scheduled: arr, estimated: arr, actual: null },
    aircraft: {},
    position: null,
    ...overrides,
  };
}

function fixedClock(t) {
  return { t, now() { return this.t; } };
}

test('time-based fallback: progress = elapsed / total, countdown = ETA − now', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const tr = new FlightTracker(clock);
  tr.setFlight(flight(now), { fresh: true, receivedAt: now });
  const s = tr.snapshot();
  assert.equal(s.mode, 'time');
  assert.ok(Math.abs(s.progress - 4 / 6.5) < 1e-9);
  assert.equal(s.remainingMs, 2.5 * HOUR);
  assert.equal(s.status.label, 'IN FLIGHT');
});

test('live position drives progress and the plane keeps moving between refreshes', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const p = geo.intermediatePoint(AUH, HKT, 0.7);
  const tr = new FlightTracker(clock);
  tr.setFlight(flight(now, { position: { ...p, speedKmh: 840, altitudeM: 11000, updated: now } }), { fresh: true, receivedAt: now });
  const s1 = tr.snapshot();
  assert.equal(s1.mode, 'live');
  assert.ok(Math.abs(s1.progress - 0.7) < 1e-6, `got ${s1.progress}`);
  clock.t = now + 10 * MIN;
  const s2 = tr.snapshot();
  assert.ok(s2.progress > s1.progress, 'extrapolates forward');
  assert.ok(s2.progress < 1);
});

test('stale position falls back to ETA-based progress', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const p = geo.intermediatePoint(AUH, HKT, 0.3);
  const tr = new FlightTracker(clock);
  tr.setFlight(flight(now, { position: { ...p, updated: now - 40 * MIN } }), { fresh: true, receivedAt: now });
  assert.equal(tr.snapshot().mode, 'time');
});

test('refresh with a different answer does not jump (blended), and ETA changes glide', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const tr = new FlightTracker(clock);
  tr.setFlight(flight(now), { fresh: true, receivedAt: now });
  const before = tr.snapshot();
  const p = geo.intermediatePoint(AUH, HKT, 0.8);
  const later = flight(now, { position: { ...p, updated: now } });
  later.arrival = { ...later.arrival, estimated: now + 2.5 * HOUR + 10 * MIN };
  tr.setFlight(later, { receivedAt: now });
  const after = tr.snapshot();
  assert.ok(Math.abs(after.progress - before.progress) < 1e-6, 'no instant jump in progress');
  assert.ok(Math.abs(after.remainingMs - before.remainingMs) < 1000, 'no instant jump in countdown');
});

test('landed flights show 100 % and LANDED; countdown never negative', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const tr = new FlightTracker(clock);
  const f = flight(now);
  f.status = { code: 'landed', raw: 'landed' };
  f.arrival = { ...f.arrival, actual: now - 5 * MIN };
  tr.setFlight(f, { fresh: true, receivedAt: now });
  const s = tr.snapshot();
  assert.equal(s.progress, 1);
  assert.equal(s.remainingMs, 0);
  assert.ok(s.timerLanded && s.landedConfirmed);
  assert.equal(s.status.label, 'LANDED');
});

test('countdown reaching zero shows LANDED on the timer but never negative', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const tr = new FlightTracker(clock);
  tr.setFlight(flight(now), { fresh: true, receivedAt: now });
  clock.t = now + 3 * HOUR;
  const s = tr.snapshot();
  assert.equal(s.remainingMs, 0);
  assert.equal(s.timerLanded, true);
  assert.equal(s.landedConfirmed, false);
  assert.equal(s.progress, 1);
});

test('scheduled flight: 0 %, DELAYED when departure slips ≥ 15 min, BOARDING from manual boarding time', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const tr = new FlightTracker(clock);
  const f = flight(now);
  f.status = { code: 'scheduled', raw: 'scheduled' };
  f.departure = { ...AUH, scheduled: now + 30 * MIN, estimated: now + 55 * MIN, actual: null, delayMin: 25 };
  f.arrival = { ...HKT, scheduled: now + 7 * HOUR, estimated: null, actual: null };
  tr.setFlight(f, { fresh: true, receivedAt: now });
  let s = tr.snapshot();
  assert.equal(s.mode, 'scheduled');
  assert.equal(s.progress, 0);
  assert.equal(s.status.label, 'DELAYED');
  s = tr.snapshot({ boardingTime: now - 5 * MIN });
  assert.equal(s.status.label, 'BOARDING');
});

test('missing ETA and times never produce NaN', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const tr = new FlightTracker(fixedClock(now));
  const f = flight(now);
  f.departure = { iata: 'AUH', scheduled: null, estimated: null, actual: null };
  f.arrival = { iata: 'HKT', scheduled: null, estimated: null, actual: null };
  f.status = { code: 'unknown', raw: null };
  tr.setFlight(f, { fresh: true, receivedAt: now });
  const s = tr.snapshot();
  assert.equal(s.remainingMs, null);
  assert.ok(Number.isFinite(s.progress));
  assert.equal(s.remainingKm, null);
});

test('descending is derived only from real data near the end of the flight', () => {
  const now = Date.UTC(2026, 8, 28, 8, 0);
  const clock = fixedClock(now);
  const f = flight(now);
  f.arrival = { ...f.arrival, estimated: now + 25 * MIN, scheduled: now + 25 * MIN };
  const p = geo.intermediatePoint(AUH, HKT, 0.95);
  f.position = { ...p, altitudeM: 5000, verticalSpeedKmh: -30, updated: now };
  const tr = new FlightTracker(clock);
  tr.setFlight(f, { fresh: true, receivedAt: now });
  assert.equal(tr.snapshot().status.label, 'DESCENDING');
  f.position = { ...p, altitudeM: 11000, verticalSpeedKmh: 0, updated: now };
  tr.setFlight(f, { fresh: true, receivedAt: now });
  assert.equal(tr.snapshot().status.label, 'IN FLIGHT');
});

test('demo flight: 6h30 total with 2h30 remaining, and it can be paused', () => {
  const clock = new DemoClock();
  const demo = new DemoFlight(clock, 'cruise');
  const snap = demo.snapshot();
  assert.equal(snap.provider, 'demo');
  assert.equal(snap.arrival.estimated - snap.departure.actual, 6.5 * HOUR);
  const remaining = snap.arrival.estimated - clock.now();
  assert.ok(Math.abs(remaining - 2.5 * HOUR) < MIN);
  clock.pause();
  const t = clock.now();
  const until = Date.now() + 30;
  while (Date.now() < until) {
    /* spin */
  }
  assert.equal(clock.now(), t);
});
