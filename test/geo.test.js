'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AUH = { lat: 24.433, lng: 54.6511 };
const HKT = { lat: 8.1132, lng: 98.3169 };

let geo;
test.before(async () => {
  geo = await import('../public/js/geo.js');
});

test('great-circle distance AUH → HKT is about 4,970 km', () => {
  const d = geo.distanceKm(AUH, HKT);
  assert.ok(d > 4940 && d < 5010, `got ${d}`);
});

test('route progress is 0 at origin, 1 at destination, 0.5 at the midpoint', () => {
  assert.equal(geo.routeProgress(AUH, HKT, AUH).fraction, 0);
  assert.ok(Math.abs(geo.routeProgress(AUH, HKT, HKT).fraction - 1) < 1e-9);
  const mid = geo.intermediatePoint(AUH, HKT, 0.5);
  assert.ok(Math.abs(geo.routeProgress(AUH, HKT, mid).fraction - 0.5) < 1e-6);
});

test('projection matches the true fraction along the route', () => {
  for (const f of [0.1, 0.25, 0.68, 0.9]) {
    const p = geo.intermediatePoint(AUH, HKT, f);
    const r = geo.routeProgress(AUH, HKT, p);
    assert.equal(r.method, 'projection');
    assert.ok(Math.abs(r.fraction - f) < 1e-6, `f=${f} got ${r.fraction}`);
  }
});

test('an aircraft slightly off the route projects onto it', () => {
  const on = geo.intermediatePoint(AUH, HKT, 0.4);
  const off = { lat: on.lat + 0.8, lng: on.lng };
  const r = geo.routeProgress(AUH, HKT, off);
  assert.ok(Math.abs(r.fraction - 0.4) < 0.02, `got ${r.fraction}`);
  assert.ok(r.crossTrackKm > 50 && r.crossTrackKm < 120);
});

test('progress is clamped to 0–1 outside the route', () => {
  const behind = { lat: 26.5, lng: 50.0 }; // west of Abu Dhabi
  const beyond = { lat: 4.0, lng: 103.0 }; // past Phuket
  assert.equal(geo.routeProgress(AUH, HKT, behind).fraction, 0);
  assert.equal(geo.routeProgress(AUH, HKT, beyond).fraction, 1);
});

test('far off-route positions fall back to the distance ratio', () => {
  const far = { lat: 40, lng: 76 };
  const r = geo.routeProgress(AUH, HKT, far);
  assert.equal(r.method, 'ratio');
  assert.ok(r.fraction >= 0 && r.fraction <= 1);
});

test('invalid coordinates return null instead of NaN', () => {
  assert.equal(geo.routeProgress(AUH, HKT, { lat: NaN, lng: 1 }), null);
  assert.equal(geo.routeProgress(AUH, AUH, HKT), null);
});
