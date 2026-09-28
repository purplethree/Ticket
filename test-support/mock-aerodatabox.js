'use strict';

/**
 * TEST-ONLY stand-in for AeroDataBox (RapidAPI), used by the automated tests.
 * The real app never talks to this server: live mode always calls
 * https://aerodatabox.p.rapidapi.com unless AERODATABOX_BASE_URL is overridden.
 *
 * Responses follow AeroDataBox's Flight Status format. Scenarios, relative
 * to "now":
 *   EY416  yesterday landed, today airborne (with live position), tomorrow scheduled
 *   LD1    landed an hour ago; the next one departs tomorrow
 *   BD1    boarding now
 *   XX999  no flight (HTTP 204)      RL1  rate limited (429)
 *   QT1    monthly quota used (429)  NS1  key not subscribed (403)
 *
 * Run standalone:  node test-support/mock-aerodatabox.js 4020
 */

const http = require('http');

const KEY = 'rapid-test-key-abcdef123456';
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const AUH = { icao: 'OMAA', iata: 'AUH', name: 'Abu Dhabi Zayed', shortName: 'Zayed', municipalityName: 'Abu Dhabi', location: { lat: 24.433, lon: 54.6511 }, countryCode: 'AE', timeZone: 'Asia/Dubai', off: 240 };
const HKT = { icao: 'VTSP', iata: 'HKT', name: 'Phuket', shortName: 'Phuket', municipalityName: 'Phuket', location: { lat: 8.1132, lon: 98.3169 }, countryCode: 'TH', timeZone: 'Asia/Bangkok', off: 420 };

const pad = (n) => String(n).padStart(2, '0');
function wall(ms, offMin) {
  const d = new Date(ms + offMin * MIN);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const offStr = (off) => `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
const t = (ms, ap) => (ms == null ? undefined : { utc: `${wall(ms, 0)}Z`, local: `${wall(ms, ap.off)}${offStr(ap.off)}` });
const airport = (ap) => {
  const { off, ...rest } = ap; // eslint-disable-line no-unused-vars
  return rest;
};

function slerp(a, b, f) {
  const r = Math.PI / 180;
  const φ1 = a.lat * r, λ1 = a.lon * r, φ2 = b.lat * r, λ2 = b.lon * r;
  const δ = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: Math.atan2(z, Math.hypot(x, y)) / r, lon: Math.atan2(y, x) / r };
}

function flight({ number, callSign, status, dep, arr, depTimes, arrTimes, gate = 'A6', location = null }) {
  return {
    greatCircleDistance: { km: 4974, mile: 3091, nm: 2686 },
    departure: {
      airport: airport(dep),
      scheduledTime: t(depTimes.scheduled, dep),
      revisedTime: t(depTimes.revised, dep),
      runwayTime: t(depTimes.runway, dep),
      terminal: 'A',
      gate,
      quality: ['Basic', 'Live'],
    },
    arrival: {
      airport: airport(arr),
      scheduledTime: t(arrTimes.scheduled, arr),
      revisedTime: t(arrTimes.revised, arr),
      runwayTime: t(arrTimes.runway, arr),
      quality: ['Basic'],
    },
    lastUpdatedUtc: `${wall(Date.now() - 60e3, 0)}Z`,
    number,
    callSign,
    status,
    codeshareStatus: 'IsOperator',
    isCargo: false,
    aircraft: { reg: 'A6-AEF', modeS: '896451', model: 'Airbus A321 NEO' },
    airline: { name: 'Etihad', iata: number.slice(0, 2), icao: 'ETD' },
    ...(location ? { location } : {}),
  };
}

function scenarios(now) {
  const todayDep = Math.floor((now - 4 * HOUR) / MIN) * MIN;
  const dur = 6.5 * HOUR;
  const eta = todayDep + dur + 5 * MIN;
  const pos = slerp(AUH.location, HKT.location, (now - todayDep) / (eta - todayDep));
  const ey = (n) => ({ number: 'EY 416', callSign: 'ETD416', dep: AUH, arr: HKT, ...n });

  const EY416 = [
    flight(ey({
      status: 'Arrived',
      depTimes: { scheduled: todayDep - DAY, revised: todayDep - DAY + 4 * MIN, runway: todayDep - DAY + 14 * MIN },
      arrTimes: { scheduled: todayDep - DAY + dur, revised: todayDep - DAY + dur - 2 * MIN, runway: todayDep - DAY + dur - 8 * MIN },
      gate: 'A9',
    })),
    flight(ey({
      status: 'EnRoute',
      depTimes: { scheduled: todayDep, revised: todayDep + 7 * MIN, runway: todayDep + 16 * MIN },
      arrTimes: { scheduled: todayDep + dur, revised: eta },
      location: {
        pressureAltitude: { meter: 11278, km: 11.278, feet: 37000 },
        altitude: { meter: 11278, km: 11.278, feet: 37001 },
        pressure: { hPa: 217 },
        groundSpeed: { kt: 455, kmPerHour: 842, miPerHour: 523, meterPerSecond: 234 },
        trueTrack: { deg: 118, rad: 2.06 },
        reportedAtUtc: `${wall(now - 30e3, 0)}Z`,
        lat: Number(pos.lat.toFixed(4)),
        lon: Number(pos.lon.toFixed(4)),
      },
    })),
    flight(ey({
      status: 'Expected',
      depTimes: { scheduled: todayDep + DAY },
      arrTimes: { scheduled: todayDep + DAY + dur },
    })),
  ];

  const ld = Math.floor((now - 7.5 * HOUR) / MIN) * MIN;
  const LD1 = [
    flight({ number: 'LD 1', callSign: 'LDX1', status: 'Arrived', dep: AUH, arr: HKT, depTimes: { scheduled: ld, runway: ld + 10 * MIN }, arrTimes: { scheduled: ld + dur, runway: ld + dur } }),
    flight({ number: 'LD 1', callSign: 'LDX1', status: 'Expected', dep: AUH, arr: HKT, depTimes: { scheduled: ld + DAY }, arrTimes: { scheduled: ld + DAY + dur } }),
  ];

  const bd = Math.floor((now + 25 * MIN) / MIN) * MIN;
  const BD1 = [
    flight({ number: 'BD 1', callSign: 'BDX1', status: 'Boarding', dep: AUH, arr: HKT, depTimes: { scheduled: bd }, arrTimes: { scheduled: bd + dur } }),
  ];

  // What "nearest" returns for each number.
  return {
    EY416: { all: EY416, nearest: [EY416[1]] },
    LD1: { all: LD1, nearest: [LD1[0]] },
    BD1: { all: BD1, nearest: BD1 },
  };
}

const depLocalDate = (f) => f.departure.scheduledTime.local.slice(0, 10);

function createMockAeroDataBox() {
  const stats = { total: 0, paths: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      if (body === undefined) {
        res.writeHead(status);
        return res.end();
      }
      res.writeHead(status, { 'Content-Type': 'application/json', 'x-ratelimit-units-remaining': '540' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/__stats') return send(200, stats);
    stats.total++;
    stats.paths.push(url.pathname);

    if (req.headers['x-rapidapi-key'] !== KEY) {
      return send(401, { message: 'Invalid API key. Go to https://docs.rapidapi.com/docs/keys for more info.' });
    }
    const m = url.pathname.match(/^\/flights\/(number|callsign)\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
    if (!m) return send(404, { message: 'Endpoint does not exist' });
    const code = decodeURIComponent(m[2]).replace(/\s+/g, '').toUpperCase();
    if (code === 'RL1') return send(429, { message: 'Too many requests' });
    if (code === 'QT1') return send(429, { message: 'You have exceeded the MONTHLY quota for Units on your current plan, BASIC.' });
    if (code === 'NS1') return send(403, { message: 'You are not subscribed to this API.' });

    const all = scenarios(Date.now());
    const key = code === 'ETD416' ? 'EY416' : code;
    const s = all[key];
    if (!s) return send(204);
    const list = m[3] ? s.all.filter((f) => depLocalDate(f) === m[3]) : s.nearest;
    return list.length ? send(200, list) : send(204);
  });
  return { server, stats, KEY };
}

module.exports = { createMockAeroDataBox, MOCK_ADB_KEY: KEY };

if (require.main === module) {
  const port = Number(process.argv[2]) || 4020;
  createMockAeroDataBox().server.listen(port, () => console.log(`mock AeroDataBox on http://localhost:${port} (key ${KEY})`));
}
