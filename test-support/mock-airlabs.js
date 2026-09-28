'use strict';

/**
 * TEST-ONLY stand-in for the AirLabs API, used by the automated tests.
 * The real app never talks to this server: live mode always calls
 * https://airlabs.co unless AIRLABS_BASE_URL is overridden.
 *
 * It serves an EY416 AUH→HKT scenario relative to "now":
 *   - yesterday's instance (landed)
 *   - today's instance (airborne, with an ADS-B position)
 *   - tomorrow's instance (scheduled)
 * plus a few flight numbers that trigger AirLabs-style errors.
 *
 * Run standalone:  node test-support/mock-airlabs.js 4010
 */

const http = require('http');

const KEY = 'test-key-123456';
const MIN = 60e3;
const HOUR = 60 * MIN;

const AUH = { iata: 'AUH', icao: 'OMAA', lat: 24.433, lng: 54.6511, off: 4 * 60, name: 'Zayed International Airport', city: 'Abu Dhabi', tz: 'Asia/Dubai' };
const HKT = { iata: 'HKT', icao: 'VTSP', lat: 8.1132, lng: 98.3169, off: 7 * 60, name: 'Phuket International Airport', city: 'Phuket', tz: 'Asia/Bangkok' };

const pad = (n) => String(n).padStart(2, '0');
function wall(ms, offMin) {
  const d = new Date(ms + offMin * MIN);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function timeFields(prefix, kind, ms, ap) {
  if (ms == null) return {};
  return {
    [`${prefix}_${kind}`]: wall(ms, ap.off),
    [`${prefix}_${kind}_utc`]: wall(ms, 0),
    [`${prefix}_${kind}_ts`]: Math.floor(ms / 1000),
  };
}

function slerp(a, b, f) {
  const r = Math.PI / 180;
  const φ1 = a.lat * r, λ1 = a.lng * r, φ2 = b.lat * r, λ2 = b.lng * r;
  const δ = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) / r, lng: Math.atan2(y, x) / r };
}

function scenario(now, opts = {}) {
  const todayDep = Math.floor((now - 4 * HOUR) / MIN) * MIN;
  const duration = 6.5 * HOUR;
  const base = {
    airline_iata: 'EY',
    airline_icao: 'ETD',
    flight_iata: 'EY416',
    flight_icao: 'ETD416',
    flight_number: '416',
    dep_iata: 'AUH',
    dep_icao: 'OMAA',
    arr_iata: 'HKT',
    arr_icao: 'VTSP',
    aircraft_icao: 'A21N',
    duration: 390,
  };
  const yesterday = {
    ...base,
    ...timeFields('dep', 'time', todayDep - 24 * HOUR, AUH),
    ...timeFields('dep', 'actual', todayDep - 24 * HOUR + 6 * MIN, AUH),
    ...timeFields('arr', 'time', todayDep - 24 * HOUR + duration, HKT),
    ...timeFields('arr', 'actual', todayDep - 24 * HOUR + duration - 4 * MIN, HKT),
    dep_terminal: 'A',
    dep_gate: 'A9',
    status: 'landed',
  };
  const arrEstimate = todayDep + duration + (opts.etaShiftMin || 0) * MIN;
  const f = (now - todayDep) / (arrEstimate - todayDep);
  const pos = slerp(AUH, HKT, f);
  const today = {
    ...base,
    ...timeFields('dep', 'time', todayDep, AUH),
    ...timeFields('dep', 'estimated', todayDep + 7 * MIN, AUH),
    ...timeFields('dep', 'actual', todayDep + 7 * MIN, AUH),
    ...timeFields('arr', 'time', todayDep + duration, HKT),
    ...timeFields('arr', 'estimated', arrEstimate, HKT),
    dep_terminal: 'A',
    dep_gate: 'A6',
    arr_terminal: null,
    arr_gate: '',
    dep_delayed: 7,
    status: 'en-route',
  };
  const liveFields = {
    hex: '896451',
    reg_number: 'A6-AEF',
    flag: 'AE',
    lat: Number(pos.lat.toFixed(4)),
    lng: Number(pos.lng.toFixed(4)),
    alt: 11278,
    dir: 118,
    speed: 842,
    v_speed: 0,
    squawk: '4312',
    updated: Math.floor((now - 20e3) / 1000),
  };
  const tomorrow = {
    ...base,
    ...timeFields('dep', 'time', todayDep + 24 * HOUR, AUH),
    ...timeFields('arr', 'time', todayDep + 24 * HOUR + duration, HKT),
    dep_terminal: 'A',
    status: 'scheduled',
  };
  return {
    flight: {
      ...today,
      ...liveFields,
      airline_name: 'Etihad Airways',
      model: 'Airbus A321neo',
      manufacturer: 'AIRBUS',
      dep_name: 'Zayed International Airport',
      dep_city: 'Abu Dhabi',
      arr_name: 'Phuket International Airport',
      arr_city: 'Phuket',
    },
    live: { ...liveFields, flight_iata: 'EY416', flight_icao: 'ETD416', flight_number: '416', dep_iata: 'AUH', arr_iata: 'HKT', airline_iata: 'EY', aircraft_icao: 'A21N', status: 'en-route' },
    schedules: [yesterday, today, tomorrow],
  };
}

function airportRow(a) {
  return { name: a.name, iata_code: a.iata, icao_code: a.icao, lat: a.lat, lng: a.lng, country_code: a.iata === 'AUH' ? 'AE' : 'TH', city: a.city, timezone: a.tz };
}

function createMockAirLabs({ opts = {} } = {}) {
  const stats = { total: 0, byEndpoint: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const endpoint = url.pathname.replace(/^\/+/, '');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (endpoint === '__stats') return send(stats);
    stats.total++;
    stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1;

    if (url.searchParams.get('api_key') !== KEY) {
      return send({ error: { message: 'Unknown API key', code: 'unknown_api_key' } });
    }
    const flight = url.searchParams.get('flight_iata') || url.searchParams.get('flight_icao') || '';
    if (flight === 'RL1') return send({ error: { message: 'Minute limit exceeded', code: 'minute_limit_exceeded' } });
    if (flight === 'QT1') return send({ error: { message: 'Month limit exceeded', code: 'month_limit_exceeded' } });

    const s = scenario(Date.now(), opts);
    const isEY = flight === 'EY416' || flight === 'ETD416';

    switch (endpoint) {
      case 'flight':
        return isEY ? send({ response: s.flight }) : send({ error: { message: 'Flight not found', code: 'not_found' } });
      case 'flights':
        return send({ response: isEY ? [s.live] : [] });
      case 'schedules':
        return send({ response: isEY ? s.schedules.filter((r) => r.dep_iata === url.searchParams.get('dep_iata')) : [] });
      case 'airports': {
        const code = url.searchParams.get('iata_code');
        const a = code === 'AUH' ? AUH : code === 'HKT' ? HKT : null;
        return send({ response: a ? [airportRow(a)] : [] });
      }
      case 'airlines':
        return send({ response: [{ name: 'Etihad Airways', iata_code: 'EY', icao_code: 'ETD' }] });
      default:
        return send({ error: { message: 'Unknown method', code: 'unknown_method' } }, 404);
    }
  });
  return { server, stats, KEY };
}

module.exports = { createMockAirLabs, MOCK_KEY: KEY, scenario };

if (require.main === module) {
  const port = Number(process.argv[2]) || 4010;
  const { server } = createMockAirLabs();
  server.listen(port, () => console.log(`mock AirLabs on http://localhost:${port} (key ${KEY})`));
}
