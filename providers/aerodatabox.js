'use strict';

/**
 * AeroDataBox provider (https://aerodatabox.com), accessed through RapidAPI.
 *
 * Endpoints used (Flight Status API, 1 unit per call on the free Basic plan):
 *   GET /flights/number/{EY416}               nearest instance(s): en route,
 *                                             about to depart or just arrived
 *   GET /flights/number/{EY416}/{YYYY-MM-DD}  instances departing on that
 *                                             local date (dateLocalRole=Departure)
 * ICAO call signs (ETD416) use /flights/callsign/… instead.
 *
 * withLocation=true adds the live position of an airborne aircraft, and each
 * airport arrives with its coordinates and time zone, so a refresh costs a
 * single unit. No other endpoints are needed.
 *
 * Times come as { utc: "2026-09-28 00:15Z", local: "2026-09-28 04:15+04:00" }.
 * scheduledTime = timetable, revisedTime = airline/airport estimate (or
 * actual once it happened), predictedTime = AeroDataBox's own estimate,
 * runwayTime = actual take-off / touchdown.
 *
 * Everything is converted to the provider-agnostic instance model documented
 * in providers/index.js. A value the API does not return stays null.
 */

const { FlightDataError } = require('../lib/errors');
const { TtlCache } = require('../lib/cache');
const { aircraftName } = require('../lib/aircraft-types');
const { classify } = require('../lib/select');

const DEFAULT_BASE_URL = 'https://aerodatabox.p.rapidapi.com';
const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';
const LIVE_TTL_MS = 25e3;
const REQUEST_TIMEOUT_MS = 15e3;
const SAME_INSTANCE_WINDOW_MS = 90 * 60e3;
const DAY_MS = 24 * 3600e3;

class AeroDataBoxProvider {
  constructor({ apiKey, baseUrl, fetchImpl, logger } = {}) {
    this.name = 'aerodatabox';
    this.label = 'AeroDataBox';
    this.keyEnv = 'AERODATABOX_API_KEY';
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.logger = logger || console;
    this.cache = new TtlCache({ maxEntries: 300 });
    this.stats = { upstreamRequests: 0 };
  }

  isConfigured() {
    const k = this.apiKey;
    return k.length >= 8 && !/^(x+|your[_-]?key.*|your[_-]?api[_-]?key.*|changeme)$/i.test(k);
  }

  /* ───────────────────────────── HTTP ───────────────────────────── */

  /** Returns an array of flight records ([] when AeroDataBox has none). */
  async request(path, params = {}) {
    if (!this.isConfigured()) throw new FlightDataError('NO_API_KEY');
    const qs = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

    return this.cache.wrap(`${path}?${qs}`, LIVE_TTL_MS, async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let res;
      let text;
      try {
        this.stats.upstreamRequests++;
        res = await this.fetch(url, {
          signal: ctrl.signal,
          headers: {
            Accept: 'application/json',
            'X-RapidAPI-Key': this.apiKey,
            'X-RapidAPI-Host': RAPIDAPI_HOST,
          },
        });
        text = await res.text();
      } catch (e) {
        if (e && e.name === 'AbortError') throw new FlightDataError('TIMEOUT', 'AeroDataBox timed out');
        throw new FlightDataError('NETWORK', `AeroDataBox network error: ${e && e.message}`);
      } finally {
        clearTimeout(timer);
      }

      this.logQuota(res);

      // 204 No Content / 404: no flight with this number around that date.
      if (res.status === 204 || res.status === 404 || (res.ok && !text.trim())) return [];

      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (!res.ok) throw mapHttpError(res.status, body);
      if (Array.isArray(body)) return body;
      if (body && Array.isArray(body.items)) return body.items;
      if (body && typeof body === 'object' && (body.departure || body.arrival)) return [body];
      throw new FlightDataError('UPSTREAM', `AeroDataBox sent an unexpected body (HTTP ${res.status})`);
    });
  }

  logQuota(res) {
    const h = (name) => res.headers && res.headers.get && res.headers.get(name);
    const remaining = h('x-ratelimit-units-remaining') || h('x-ratelimit-requests-remaining');
    if (remaining != null && Number(remaining) < 60) {
      this.logger.warn(`[aerodatabox] only ${remaining} units left this month`);
    }
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  /**
   * @param {{type:'iata'|'icao', code:string}} flightCode
   * @param {{date?: string|null}} opts  YYYY-MM-DD departure date (local)
   */
  async findInstances(flightCode, { date = null } = {}) {
    const now = Date.now();
    let instances = [];

    if (date) {
      instances = this.normalizeAll(await this.request(datedPath(flightCode, date), datedParams()), flightCode);
    } else {
      instances = this.normalizeAll(await this.request(nearestPath(flightCode), baseParams()), flightCode);

      // "Nearest" can be yesterday's landed flight or tomorrow's departure.
      // If nothing is airborne or leaving today, fetch the neighbouring day
      // too (1 more unit) so the picker can offer both sides.
      const hasCurrent = instances.some((i) => ['airborne', 'today'].includes(classify(i, now)));
      if (instances.length && !hasCurrent) {
        const allPast = instances.every((i) => classify(i, now) === 'completed');
        const anchor = instances
          .map((i) => i.departure.scheduled)
          .filter((t) => t != null)
          .sort((a, b) => (allPast ? b - a : a - b))[0];
        const ref = instances.find((i) => i.departure.scheduled === anchor) || instances[0];
        const neighbour = localDate(anchor, ref.departure, allPast ? DAY_MS : -DAY_MS);
        if (neighbour) {
          try {
            const more = this.normalizeAll(await this.request(datedPath(flightCode, neighbour), datedParams()), flightCode);
            for (const inst of more) addOrMerge(instances, inst);
          } catch (e) {
            if (!(e instanceof FlightDataError) || ['NO_API_KEY', 'INVALID_API_KEY', 'NOT_SUBSCRIBED'].includes(e.code)) throw e;
            this.logger.warn(`[aerodatabox] neighbouring day skipped: ${e.code}`);
          }
        }
      }
    }

    if (instances.length === 0) throw new FlightDataError('NOT_FOUND', `no instances for ${flightCode.code}`);
    instances.forEach((i) => (i.fetchedAt = now));
    return instances;
  }

  /**
   * @param ref { dep, arr, sched, date } date = departure local date if known
   */
  async refreshInstance(flightCode, ref) {
    const now = Date.now();
    const pick = (records) => {
      for (const inst of this.normalizeAll(records, flightCode)) if (sameInstance(inst, ref)) return inst;
      return null;
    };

    let inst = null;
    if (ref.date) inst = pick(await this.request(datedPath(flightCode, ref.date), datedParams()));
    if (!inst) inst = pick(await this.request(nearestPath(flightCode), baseParams()));
    if (!inst) return null;
    inst.fetchedAt = now;
    return inst;
  }

  normalizeAll(records, flightCode) {
    const out = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (!r || typeof r !== 'object' || (!r.departure && !r.arrival)) continue;
      if (r.isCargo === true) continue;
      addOrMerge(out, normalizeRecord(r, flightCode));
    }
    return out;
  }
}

/* ───────────────────────────── Helpers ───────────────────────────── */

const baseParams = () => ({ withLocation: 'true', withAircraftImage: 'false' });
const datedParams = () => ({ ...baseParams(), dateLocalRole: 'Departure' });
const searchBy = (flightCode) => (flightCode.type === 'icao' ? 'callsign' : 'number');
const nearestPath = (flightCode) => `/flights/${searchBy(flightCode)}/${encodeURIComponent(flightCode.code)}`;
const datedPath = (flightCode, date) => `${nearestPath(flightCode)}/${date}`;

function mapHttpError(status, body) {
  const msg = String((body && (body.message || body.error || body.title)) || '').toLowerCase();
  if (status === 429) {
    if (/(month|quota|plan)/.test(msg)) return new FlightDataError('QUOTA_EXCEEDED', `AeroDataBox 429: ${msg}`);
    return new FlightDataError('RATE_LIMIT', 'AeroDataBox 429', { retryAfterSeconds: 60 });
  }
  if (status === 403 && /subscri/.test(msg)) return new FlightDataError('NOT_SUBSCRIBED', 'AeroDataBox 403: not subscribed');
  if (status === 401 || status === 403) return new FlightDataError('INVALID_API_KEY', `AeroDataBox HTTP ${status}`);
  if (status === 400) return new FlightDataError('NOT_FOUND', `AeroDataBox 400: ${msg}`);
  return new FlightDataError('UPSTREAM', `AeroDataBox HTTP ${status}`);
}

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|undefined|nan|n\/a|na|none|-+|—|\?)$/i.test(s)) return null;
  return s;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);

/** "2026-09-28 00:15Z" (or ISO) → epoch ms. */
function parseUtc(s) {
  const raw = str(s);
  if (!raw) return null;
  let iso = raw.replace(' ', 'T');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > MIN_TS && ms < MAX_TS ? ms : null;
}

/** { utc, local } → epoch ms (UTC). */
function timeOf(t) {
  if (!t) return null;
  if (typeof t === 'string') return parseUtc(t);
  return parseUtc(t.utc) ?? parseUtc(t.local);
}

/** "+04:00" at the end of a local time string → 240. */
function offsetOf(t) {
  const local = t && typeof t === 'object' ? str(t.local) : null;
  if (!local) return null;
  const m = local.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return Math.abs(minutes) <= 14 * 60 ? minutes : null;
}

/** Local calendar date of `ms` at an airport, shifted by `shiftMs`. */
function localDate(ms, airport, shiftMs = 0) {
  if (ms == null) return null;
  const off = airport && Number.isFinite(airport.utcOffsetMin) ? airport.utcOffsetMin : 0;
  return new Date(ms + shiftMs + off * 60e3).toISOString().slice(0, 10);
}

const STATUS = {
  unknown: { code: 'unknown' },
  expected: { code: 'scheduled' },
  checkin: { code: 'scheduled', detail: 'check-in' },
  boarding: { code: 'scheduled', detail: 'boarding' },
  gateclosed: { code: 'scheduled', detail: 'gate-closed' },
  delayed: { code: 'scheduled', detail: 'delayed' },
  departed: { code: 'airborne', detail: 'departed' },
  enroute: { code: 'airborne' },
  approaching: { code: 'airborne', detail: 'approaching' },
  arrived: { code: 'landed' },
  canceled: { code: 'cancelled' },
  cancelled: { code: 'cancelled' },
  canceleduncertain: { code: 'cancelled' },
  diverted: { code: 'diverted' },
};

function normalizeStatus(raw) {
  const key = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const s = STATUS[key] || STATUS.unknown;
  return { code: s.code, raw: str(raw), detail: s.detail || null };
}

function endpointFrom(side, { done }) {
  const s = side || {};
  const a = s.airport || {};
  const loc = a.location || {};
  const scheduled = timeOf(s.scheduledTime);
  const revised = timeOf(s.revisedTime);
  const predicted = timeOf(s.predictedTime);
  const runway = timeOf(s.runwayTime);
  const actual = done ? (runway ?? revised ?? null) : null;
  const estimated = actual != null ? null : (revised ?? predicted ?? null);
  const ref = actual ?? estimated;
  const lat = num(loc.lat);
  const lng = num(loc.lon ?? loc.lng);
  const validCoord = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    iata: str(a.iata) && str(a.iata).toUpperCase(),
    icao: str(a.icao) && str(a.icao).toUpperCase(),
    name: str(a.name) || str(a.shortName),
    city: str(a.municipalityName),
    country: str(a.countryCode),
    lat: validCoord ? lat : null,
    lng: validCoord ? lng : null,
    timezone: str(a.timeZone),
    utcOffsetMin: offsetOf(s.scheduledTime) ?? offsetOf(s.revisedTime) ?? offsetOf(s.runwayTime),
    terminal: str(s.terminal),
    gate: str(s.gate),
    baggage: str(s.baggageBelt),
    scheduled,
    estimated,
    actual,
    delayMin: scheduled != null && ref != null ? Math.round((ref - scheduled) / 60e3) : null,
  };
}

function positionFrom(L) {
  if (!L || typeof L !== 'object') return null;
  const lat = num(L.lat);
  const lng = num(L.lon ?? L.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  const alt = L.altitude || L.pressureAltitude || {};
  const altitudeM = num(alt.meter) ?? (num(alt.feet) != null ? num(alt.feet) * 0.3048 : null);
  const gs = L.groundSpeed || {};
  const speedKmh =
    num(gs.kmPerHour) ?? (num(gs.kt) != null ? num(gs.kt) * 1.852 : null) ?? (num(gs.meterPerSecond) != null ? num(gs.meterPerSecond) * 3.6 : null);
  const heading = num((L.trueTrack || {}).deg);
  return {
    lat,
    lng,
    altitudeM: altitudeM != null && altitudeM >= -500 && altitudeM < 25000 ? Math.round(altitudeM) : null,
    speedKmh: speedKmh != null && speedKmh >= 0 && speedKmh < 1500 ? Math.round(speedKmh) : null,
    verticalSpeedKmh: null,
    heading: heading != null && heading >= 0 && heading <= 360 ? heading % 360 : null,
    updated: parseUtc(L.reportedAtUtc),
  };
}

function splitNumber(number, airlineIata) {
  // "EY 416" → { iata: "EY416", number: "416" }
  const raw = str(number);
  if (!raw) return { iata: null, number: null };
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  const m = compact.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (m && !/^\d{2}$/.test(m[1])) {
    const n = m[2].replace(/^0+(?=\d)/, '');
    return { iata: m[1] + n, number: n };
  }
  return { iata: airlineIata && /^\d/.test(compact) ? airlineIata + compact : compact, number: compact.replace(/^[A-Z]+/, '') };
}

function normalizeRecord(r, flightCode) {
  const status = normalizeStatus(r.status);
  const departed = ['airborne', 'landed', 'diverted'].includes(status.code);
  const arrived = status.code === 'landed';
  const airline = r.airline || {};
  const ac = r.aircraft || {};
  const { iata, number } = splitNumber(r.number, str(airline.iata));

  const inst = {
    id: null,
    provider: 'aerodatabox',
    sources: ['flight-status'],
    flight: {
      iata: iata || (flightCode.type === 'iata' ? flightCode.code : null),
      icao: str(r.callSign) || (flightCode.type === 'icao' ? flightCode.code : null),
      number,
      airlineIata: str(airline.iata) || (flightCode.type === 'iata' ? flightCode.airline : null),
      airlineIcao: str(airline.icao),
      airlineName: str(airline.name),
      codeshare: null,
    },
    status,
    departure: endpointFrom(r.departure, { done: departed }),
    arrival: endpointFrom(r.arrival, { done: arrived }),
    aircraft: {
      icao: null,
      name: str(ac.model) || aircraftName(ac.icao),
      registration: str(ac.reg) && str(ac.reg).toUpperCase(),
      hex: str(ac.modeS),
    },
    position: null,
    durationMin: null,
    fetchedAt: null,
  };

  // Only trust a position for a flight that is actually flying; before
  // departure it could be the aircraft's previous leg.
  const pos = positionFrom(r.location);
  if (pos && (status.code === 'airborne' || status.code === 'diverted' || status.code === 'unknown')) {
    inst.position = pos;
    if (status.code === 'unknown') inst.status = { ...status, code: 'airborne' };
  }

  const d = inst.departure;
  const a = inst.arrival;
  if (d.scheduled != null && a.scheduled != null && a.scheduled > d.scheduled) {
    inst.durationMin = Math.round((a.scheduled - d.scheduled) / 60e3);
  }
  const depKey = d.iata || d.icao || 'XXX';
  inst.id = d.scheduled != null ? `${flightCode.code}-${depKey}-${d.scheduled}` : `${flightCode.code}-${depKey}-${a.iata || 'XXX'}-live`;
  return inst;
}

function sameInstance(inst, ref) {
  if (ref.dep && inst.departure.iata && inst.departure.iata !== ref.dep) return false;
  if (ref.sched != null) {
    return inst.departure.scheduled != null && Math.abs(inst.departure.scheduled - ref.sched) <= SAME_INSTANCE_WINDOW_MS;
  }
  if (ref.arr && inst.arrival.iata && inst.arrival.iata !== ref.arr) return false;
  return true;
}

function addOrMerge(list, inst) {
  const existing = list.find((x) => x.id === inst.id);
  if (!existing) {
    list.push(inst);
    return;
  }
  // Same instance seen twice: keep the one with a live position / later data.
  if (!existing.position && inst.position) Object.assign(existing, inst);
}

module.exports = {
  AeroDataBoxProvider,
  _internal: { normalizeRecord, mapHttpError, parseUtc, offsetOf, normalizeStatus, splitNumber },
};
