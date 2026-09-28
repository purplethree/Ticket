'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectInstance, classify } = require('../lib/select');
const { parseFlightCode, parseDateParam } = require('../lib/flight-code');
const { _internal } = require('../providers/airlabs');

const MIN = 60e3;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 28, 8, 0);

function inst(id, status, depOffsetH, durH = 6.5, extra = {}) {
  const dep = NOW + depOffsetH * HOUR;
  return {
    id,
    status: { code: status, raw: status },
    departure: { iata: 'AUH', scheduled: dep, estimated: null, actual: status === 'scheduled' ? null : dep, utcOffsetMin: 240 },
    arrival: { iata: 'HKT', scheduled: dep + durH * HOUR, estimated: null, actual: status === 'landed' ? dep + durH * HOUR : null },
    position: null,
    ...extra,
  };
}

test('flight number parsing', () => {
  assert.deepEqual(
    [parseFlightCode('ey416'), parseFlightCode(' EY 0416 '), parseFlightCode('ETD416'), parseFlightCode('9W123')].map((c) => c && `${c.type}:${c.code}`),
    ['iata:EY416', 'iata:EY416', 'icao:ETD416', 'iata:9W123'],
  );
  assert.equal(parseFlightCode('12345'), null);
  assert.equal(parseFlightCode('hello'), null);
  assert.equal(parseFlightCode(''), null);
  assert.equal(parseDateParam('2026-09-28'), '2026-09-28');
  assert.equal(parseDateParam('2026-02-30'), undefined);
  assert.equal(parseDateParam(''), null);
});

test('prefers the airborne instance over yesterday and tomorrow', () => {
  const r = selectInstance([inst('y', 'landed', -28), inst('t', 'airborne', -4), inst('n', 'scheduled', 20)], { now: NOW });
  assert.equal(r.selectedId, 't');
  assert.equal(r.reason, 'airborne');
});

test('with nothing airborne, picks today\'s upcoming departure', () => {
  const r = selectInstance([inst('y', 'landed', -20), inst('t', 'scheduled', 3)], { now: NOW });
  assert.equal(r.selectedId, 't');
  assert.equal(r.reason, 'upcoming');
});

test('only a completed instance: asks the user instead of silently choosing', () => {
  const r = selectInstance([inst('y', 'landed', -10), inst('n', 'scheduled', 30)], { now: NOW, display: 'EY416' });
  assert.equal(r.selectedId, null);
  assert.equal(r.reason, 'no_active');
  assert.equal(r.message, "Couldn't find an active EY416. Choose another flight instance below.");
  assert.deepEqual(r.candidates.map((c) => c.id), ['y', 'n'], 'most recent completed first');
});

test('two airborne instances of the same number: user chooses', () => {
  const a = inst('a', 'airborne', -2);
  const b = inst('b', 'airborne', -9, 12);
  b.departure.iata = 'SYD';
  const r = selectInstance([a, b], { now: NOW });
  assert.equal(r.selectedId, null);
  assert.equal(r.reason, 'multiple_airborne');
});

test('tomorrow\'s departure is not auto-selected as "today"', () => {
  // NOW is 12:00 in Abu Dhabi; this departs 04:00 tomorrow local (16 h away).
  const r = selectInstance([inst('y', 'landed', -8), inst('n', 'scheduled', 16)], { now: NOW, display: 'EY416' });
  assert.equal(r.selectedId, null);
  assert.equal(r.reason, 'no_active');
  assert.equal(r.candidates.find((c) => c.id === 'n').tier, 'future');
});

test('later today and shortly after midnight both count as the next flight', () => {
  // 11 h from NOW is 23:00 local the same day.
  let r = selectInstance([inst('y', 'landed', -8), inst('n', 'scheduled', 11)], { now: NOW });
  assert.equal(r.selectedId, 'n');
  // At 22:00 local, a 01:30 departure (3.5 h away, next calendar day) is tonight's flight.
  const late = NOW + 10 * HOUR;
  const n2 = inst('n2', 'scheduled', 13.5);
  r = selectInstance([inst('y', 'landed', -8), n2], { now: late });
  assert.equal(r.selectedId, 'n2');
});

test('a fresh live position counts as airborne even if status lags', () => {
  const x = inst('x', 'scheduled', -1);
  x.position = { lat: 20, lng: 60, updated: NOW - 2 * MIN };
  assert.equal(classify(x, NOW), 'airborne');
});

test('date filter uses the departure airport local date', () => {
  // 22:30 UTC on 27 Sep is 02:30 on 28 Sep in Abu Dhabi (UTC+4)
  const late = inst('late', 'scheduled', -9.5);
  const r = selectInstance([late], { now: NOW, date: '2026-09-28' });
  assert.equal(r.selectedId, 'late');
});

test('AirLabs record normalization keeps missing values null', () => {
  const rec = {
    flight_iata: 'EY416',
    dep_iata: 'AUH',
    arr_iata: 'HKT',
    dep_time: '2026-09-28 04:15',
    dep_time_utc: '2026-09-28 00:15',
    dep_time_ts: Date.UTC(2026, 8, 28, 0, 15) / 1000,
    arr_time: '2026-09-28 13:45',
    arr_time_utc: '2026-09-28 06:45',
    arr_estimated_utc: '2026-09-28 07:18',
    dep_gate: '',
    dep_terminal: 'null',
    status: 'scheduled',
    lat: 25,
    lng: 55,
  };
  const n = _internal.normalizeRecord(rec, 'flight', parseFlightCode('EY416'));
  assert.equal(n.departure.utcOffsetMin, 240);
  assert.equal(n.arrival.utcOffsetMin, 420);
  assert.equal(n.departure.gate, null);
  assert.equal(n.departure.terminal, null);
  assert.equal(n.arrival.estimated, Date.UTC(2026, 8, 28, 7, 18));
  assert.equal(n.arrival.actual, null);
  assert.equal(n.position, null, 'position ignored for a scheduled flight (could be the previous leg)');
  assert.equal(n.aircraft.registration, null);
});

test('AirLabs error codes map to friendly categories', () => {
  const m = (code) => _internal.mapApiError('flight', { code }, 200).code;
  assert.equal(m('unknown_api_key'), 'INVALID_API_KEY');
  assert.equal(m('expired_api_key'), 'INVALID_API_KEY');
  assert.equal(m('minute_limit_exceeded'), 'RATE_LIMIT');
  assert.equal(m('month_limit_exceeded'), 'QUOTA_EXCEEDED');
  assert.equal(m('not_found'), 'NOT_FOUND');
  assert.equal(m('internal_error'), 'UPSTREAM');
});
