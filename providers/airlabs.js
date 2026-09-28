'use strict';

/**
 * AirLabs provider (https://airlabs.co/docs/).
 *
 * Endpoints used:
 *   /flight     Flight Information API: the single closest instance of a flight
 *               number with schedule, estimated and actual times, gates,
 *               terminals, aircraft and (when airborne) position.
 *   /flights    Real-Time Flights API: live ADS-B positions (lat/lng, altitude,
 *               speed, heading, vertical speed, last-signal time).
 *   /schedules  Other daily instances of the same number departing from the
 *               same airport (recent past to ~10 h ahead).
 *   /airports   Airport coordinates, names and time zones (cached for 7 days).
 *   /airlines   Airline name when /flight does not include it (cached for 7 days).
 *
 * AirLabs units: alt = metres, speed and v_speed = km/h, dir = degrees,
 * *_ts and updated = UNIX seconds, *_utc = "YYYY-MM-DD HH:MM" in UTC,
 * plain dep_time / arr_time = airport local time.
 *
 * Everything is converted to the provider-agnostic instance model documented
 * in providers/index.js. Nothing is invented: a value the API does not
 * return stays null.
 */

const { FlightDataError } = require('../lib/errors');
const { TtlCache } = require('../lib/cache');
const { aircraftName } = require('../lib/aircraft-types');

const DEFAULT_BASE_URL = 'https://airlabs.co/api/v9';
const LIVE_TTL_MS = 25e3;
const REFERENCE_TTL_MS = 7 * 24 * 3600e3;
const REQUEST_TIMEOUT_MS = 12e3;
const SAME_INSTANCE_WINDOW_MS = 90 * 60e3;
const LIVE_REFRESH_AFTER_MS = 3 * 60e3;

class AirLabsProvider {
  constructor({ apiKey, baseUrl, cacheFile = null, fetchImpl, logger } = {}) {
    this.name = 'airlabs';
    this.label = 'AirLabs';
    this.keyEnv = 'AIRLABS_API_KEY';
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.logger = logger || console;
    this.liveCache = new TtlCache({ maxEntries: 300 });
    this.refCache = new TtlCache({ file: cacheFile, maxEntries: 3000 });
    this.stats = { upstreamRequests: 0 };
  }

  isConfigured() {
    const k = this.apiKey;
    return k.length >= 8 && !/^(x+|your[_-]?key.*|your[_-]?api[_-]?key.*|changeme)$/i.test(k);
  }

  /* ───────────────────────────── HTTP ───────────────────────────── */

  async request(endpoint, params, { reference = false } = {}) {
    if (!this.isConfigured()) throw new FlightDataError('NO_API_KEY');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const cacheKey = `${endpoint}?${qs}`;
    const cache = reference ? this.refCache : this.liveCache;
    const ttl = reference ? REFERENCE_TTL_MS : LIVE_TTL_MS;

    return cache.wrap(cacheKey, ttl, async () => {
      qs.set('api_key', this.apiKey);
      const url = `${this.baseUrl}/${endpoint}?${qs}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      let res;
      let text;
      try {
        this.stats.upstreamRequests++;
        res = await this.fetch(url, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'flight-study-tracker/1.0' },
        });
        text = await res.text();
      } catch (e) {
        if (e && e.name === 'AbortError') throw new FlightDataError('TIMEOUT', `AirLabs /${endpoint} timed out`);
        throw new FlightDataError('NETWORK', `AirLabs /${endpoint} network error: ${e && e.message}`);
      } finally {
        clearTimeout(timer);
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw httpError(endpoint, res.status) || new FlightDataError('UPSTREAM', `AirLabs /${endpoint} sent non-JSON (HTTP ${res.status})`);
      }
      if (body && body.error) throw mapApiError(endpoint, body.error, res.status);
      const statusErr = httpError(endpoint, res.status);
      if (statusErr) throw statusErr;
      return body && Object.prototype.hasOwnProperty.call(body, 'response') ? body.response : null;
    });
  }

  /** Like request(), but "not found" becomes null instead of an error. */
  async requestOptional(endpoint, params) {
    try {
      return await this.request(endpoint, params);
    } catch (e) {
      if (e instanceof FlightDataError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
  }

  /** Best-effort request: any failure is logged and becomes null. */
  async requestSoft(endpoint, params, opts) {
    try {
      return await this.request(endpoint, params, opts);
    } catch (e) {
      if (!(e instanceof FlightDataError && e.code === 'NOT_FOUND')) {
        this.logger.warn(`[airlabs] /${endpoint} skipped: ${e.code || ''} ${e.message}`);
      }
      return null;
    }
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  /**
   * Finds every instance of a flight number the API currently knows about.
   * @param {{type:'iata'|'icao', code:string}} flightCode
   */
  // The optional { date } is not needed here: AirLabs lists the instances
  // around today and the server filters them by date.
  async findInstances(flightCode) {
    const now = Date.now();
    const param = flightParam(flightCode);

    // /flight is the primary source. /flights (real-time) is secondary: if it
    // fails we still have a result, so its errors are not fatal.
    const [flightRes, liveRes] = await Promise.allSettled([
      this.requestOptional('flight', param),
      this.requestOptional('flights', param),
    ]);
    if (flightRes.status === 'rejected') throw flightRes.reason;
    const flightRec = flightRes.value;
    const liveRecs =
      liveRes.status === 'fulfilled'
        ? toArray(liveRes.value).filter((r) => matchesCode(r, flightCode))
        : (this.logger.warn(`[airlabs] /flights skipped: ${liveRes.reason && liveRes.reason.code}`), []);

    const instances = [];
    if (isFlightRecord(flightRec) && matchesCode(flightRec, flightCode)) {
      addOrMerge(instances, normalizeRecord(flightRec, 'flight', flightCode));
    }

    // Other daily instances departing from the same airport(s).
    const depAirports = unique([flightRec && flightRec.dep_iata, ...liveRecs.map((r) => r.dep_iata)])
      .filter(Boolean)
      .slice(0, 3);
    const scheduleLists = await Promise.all(
      depAirports.map((dep) => this.requestSoft('schedules', { dep_iata: dep, ...param })),
    );
    for (const list of scheduleLists) {
      for (const rec of toArray(list)) {
        if (isFlightRecord(rec) && matchesCode(rec, flightCode)) {
          addOrMerge(instances, normalizeRecord(rec, 'schedules', flightCode));
        }
      }
    }

    for (const live of liveRecs) attachLive(instances, live, flightCode, now);

    if (instances.length === 0) throw new FlightDataError('NOT_FOUND', `no instances for ${flightCode.code}`);

    await this.enrich(instances);
    instances.forEach((i) => (i.fetchedAt = now));
    return instances;
  }

  /**
   * Re-fetches one known instance.
   * @param {{type,code}} flightCode
   * @param {{dep:string|null, arr:string|null, sched:number|null}} ref
   * @returns instance or null when the API no longer reports it
   */
  async refreshInstance(flightCode, ref) {
    const now = Date.now();
    const param = flightParam(flightCode);
    let inst = null;

    const rec = await this.requestOptional('flight', param);
    if (isFlightRecord(rec) && matchesCode(rec, flightCode)) {
      const candidate = normalizeRecord(rec, 'flight', flightCode);
      if (sameInstance(candidate, ref)) inst = candidate;
    }

    // /flight moves on to the next day's instance after landing; look the
    // original instance up in the schedule instead.
    if (!inst && ref.dep) {
      const rows = await this.requestSoft('schedules', { dep_iata: ref.dep, ...param });
      for (const row of toArray(rows)) {
        if (!isFlightRecord(row) || !matchesCode(row, flightCode)) continue;
        const candidate = normalizeRecord(row, 'schedules', flightCode);
        if (sameInstance(candidate, ref)) {
          inst = inst ? mergeInstances(inst, candidate) : candidate;
        }
      }
    }

    // Only instances seen live (no schedule data) need a /flights lookup to
    // be found at all.
    const needsLive = !inst || wantsLivePosition(inst, now);
    if (needsLive) {
      const liveRecs = toArray(await this.requestSoft('flights', param)).filter((r) => matchesCode(r, flightCode));
      if (!inst && ref.sched == null) {
        const live = liveRecs.find((r) => (!ref.dep || r.dep_iata === ref.dep) && (!ref.arr || r.arr_iata === ref.arr));
        if (live) inst = normalizeRecord(live, 'flights', flightCode);
      }
      if (inst) {
        const list = [inst];
        for (const live of liveRecs) attachLive(list, live, flightCode, now, { allowCreate: false });
      }
    }

    if (!inst) return null;
    await this.enrich([inst]);
    inst.fetchedAt = now;
    return inst;
  }

  /* ─────────────────────────── Enrichment ─────────────────────────── */

  async enrich(instances) {
    const codes = unique(instances.flatMap((i) => [i.departure.iata, i.arrival.iata]).filter(Boolean)).slice(0, 8);
    const airports = new Map();
    await Promise.all(
      codes.map(async (code) => {
        const rows = await this.requestSoft('airports', { iata_code: code }, { reference: true });
        const row = toArray(rows).find((r) => r && String(r.iata_code || '').toUpperCase() === code) || null;
        if (row) airports.set(code, row);
      }),
    );

    // Reuse an airline name another instance already carries (schedule rows
    // omit it) before spending a request on /airlines.
    const airlines = new Map();
    for (const i of instances) {
      if (i.flight.airlineName && i.flight.airlineIata) airlines.set(i.flight.airlineIata, i.flight.airlineName);
    }
    const airlineCodes = unique(
      instances
        .filter((i) => !i.flight.airlineName && i.flight.airlineIata && !airlines.has(i.flight.airlineIata))
        .map((i) => i.flight.airlineIata),
    ).slice(0, 3);
    await Promise.all(
      airlineCodes.map(async (code) => {
        const rows = await this.requestSoft('airlines', { iata_code: code }, { reference: true });
        const row = toArray(rows).find((r) => r && String(r.iata_code || '').toUpperCase() === code && r.name);
        if (row) airlines.set(code, str(row.name));
      }),
    );

    for (const inst of instances) {
      for (const side of [inst.departure, inst.arrival]) {
        const a = side.iata && airports.get(side.iata);
        if (!a) continue;
        const lat = num(a.lat);
        const lng = num(a.lng);
        if (side.lat == null && lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          side.lat = lat;
          side.lng = lng;
        }
        side.icao = side.icao || str(a.icao_code);
        side.name = side.name || str(a.name);
        side.city = side.city || str(a.city);
        side.country = side.country || str(a.country_code);
        side.timezone = side.timezone || str(a.timezone);
      }
      if (!inst.flight.airlineName && airlines.has(inst.flight.airlineIata)) {
        inst.flight.airlineName = airlines.get(inst.flight.airlineIata);
      }
    }
  }
}

/* ───────────────────────────── Helpers ───────────────────────────── */

function flightParam(flightCode) {
  return flightCode.type === 'icao' ? { flight_icao: flightCode.code } : { flight_iata: flightCode.code };
}

function mapApiError(endpoint, err, httpStatus) {
  const code = String((err && err.code) || '').toLowerCase();
  const msg = String((err && err.message) || '').toLowerCase();
  const s = `${code} ${msg}`;
  const detail = `AirLabs /${endpoint}: ${code || 'error'}`;
  if (/(month|monthly|quota|plan|subscription)/.test(s) && /(limit|exceed|quota|reached)/.test(s)) {
    return new FlightDataError('QUOTA_EXCEEDED', detail);
  }
  if (/(limit|too many|rate)/.test(s) || httpStatus === 429) {
    return new FlightDataError('RATE_LIMIT', detail, { retryAfterSeconds: /hour/.test(s) ? 3600 : 60 });
  }
  if (/(api_key|api key|key|auth|token|unauthori[sz]ed|forbidden|expired)/.test(s)) {
    return new FlightDataError('INVALID_API_KEY', detail);
  }
  if (/(not[_ ]?found|no data|no result|empty)/.test(s)) return new FlightDataError('NOT_FOUND', detail);
  if (/(param|wrong|invalid|missing)/.test(s)) return new FlightDataError('NOT_FOUND', detail);
  return new FlightDataError('UPSTREAM', detail);
}

function httpError(endpoint, status) {
  if (status === 429) return new FlightDataError('RATE_LIMIT', `AirLabs /${endpoint} HTTP 429`, { retryAfterSeconds: 60 });
  if (status === 401 || status === 403) return new FlightDataError('INVALID_API_KEY', `AirLabs /${endpoint} HTTP ${status}`);
  if (status >= 400) return new FlightDataError('UPSTREAM', `AirLabs /${endpoint} HTTP ${status}`);
  return null;
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [v];
  return [];
}

function unique(arr) {
  return [...new Set(arr)];
}

/** Trimmed string, or null for empty / placeholder values. */
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

function isFlightRecord(r) {
  return !!(r && typeof r === 'object' && !Array.isArray(r) && (r.flight_iata || r.flight_icao || r.dep_iata));
}

function matchesCode(r, flightCode) {
  if (!r) return false;
  const want = flightCode.code;
  const iata = String(r.flight_iata || '').toUpperCase();
  const icao = String(r.flight_icao || '').toUpperCase();
  // Records without any flight code (rare) came from a query filtered by
  // this code, so accept them.
  if (!iata && !icao) return true;
  return flightCode.type === 'icao' ? icao === want || (!icao && !!iata) : iata === want || (!iata && !!icao);
}

const STATUS_MAP = {
  scheduled: 'scheduled',
  'en-route': 'airborne',
  enroute: 'airborne',
  active: 'airborne',
  started: 'airborne',
  airborne: 'airborne',
  landed: 'landed',
  arrived: 'landed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  diverted: 'diverted',
  redirected: 'diverted',
  incident: 'incident',
};

function normalizeStatus(raw) {
  if (!raw) return 'unknown';
  return STATUS_MAP[String(raw).toLowerCase().trim()] || 'unknown';
}

/** "2026-09-28 04:15" → epoch ms, treating the wall-clock value as UTC. */
function parseWallClock(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);

function timeField(r, base) {
  const ts = num(r[`${base}_ts`]);
  if (ts != null && ts > 0) {
    const ms = ts * 1000;
    if (ms > MIN_TS && ms < MAX_TS) return ms;
  }
  const utc = parseWallClock(r[`${base}_utc`]);
  if (utc != null && utc > MIN_TS && utc < MAX_TS) return utc;
  return null;
}

/** Derives the airport's UTC offset from a local/UTC pair of the same timestamp. */
function utcOffsetFromRecord(r, prefix) {
  for (const base of [`${prefix}_time`, `${prefix}_estimated`, `${prefix}_actual`]) {
    const local = parseWallClock(r[base]);
    if (local == null) continue;
    const utc = timeField(r, base);
    if (utc == null) continue;
    const minutes = Math.round((local - utc) / 60e3 / 15) * 15;
    if (Math.abs(minutes) <= 14 * 60) return minutes;
  }
  return null;
}

function endpointFrom(r, p) {
  return {
    iata: str(r[`${p}_iata`]) && str(r[`${p}_iata`]).toUpperCase(),
    icao: str(r[`${p}_icao`]) && str(r[`${p}_icao`]).toUpperCase(),
    name: str(r[`${p}_name`]),
    city: str(r[`${p}_city`]),
    country: str(r[`${p}_country`]),
    lat: null,
    lng: null,
    timezone: null,
    utcOffsetMin: utcOffsetFromRecord(r, p),
    terminal: str(r[`${p}_terminal`]),
    gate: str(r[`${p}_gate`]),
    baggage: p === 'arr' ? str(r.arr_baggage) : null,
    scheduled: timeField(r, `${p}_time`),
    estimated: timeField(r, `${p}_estimated`),
    actual: timeField(r, `${p}_actual`),
    delayMin: num(r[`${p}_delayed`]),
  };
}

function positionFrom(r) {
  const lat = num(r.lat);
  const lng = num(r.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    return null;
  }
  const updated = num(r.updated);
  const alt = num(r.alt);
  const speed = num(r.speed);
  const dir = num(r.dir);
  return {
    lat,
    lng,
    altitudeM: alt != null && alt >= -500 && alt < 25000 ? alt : null,
    speedKmh: speed != null && speed >= 0 && speed < 1500 ? speed : null,
    verticalSpeedKmh: num(r.v_speed),
    heading: dir != null && dir >= 0 && dir <= 360 ? dir % 360 : null,
    updated: updated != null && updated * 1000 > MIN_TS ? updated * 1000 : null,
  };
}

function modelName(r) {
  const model = str(r.model);
  if (model) {
    const maker = str(r.manufacturer);
    if (maker && !model.toLowerCase().includes(maker.toLowerCase().split(' ')[0])) {
      return `${titleCase(maker)} ${model}`;
    }
    return model;
  }
  return aircraftName(r.aircraft_icao);
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function instanceId(inst, flightCode) {
  const dep = inst.departure.iata || inst.departure.icao || 'XXX';
  if (inst.departure.scheduled != null) return `${flightCode.code}-${dep}-${inst.departure.scheduled}`;
  return `${flightCode.code}-${dep}-${inst.arrival.iata || 'XXX'}-live`;
}

function normalizeRecord(r, source, flightCode) {
  const statusRaw = str(r.status);
  const inst = {
    id: null,
    provider: 'airlabs',
    sources: [source],
    flight: {
      iata: str(r.flight_iata),
      icao: str(r.flight_icao),
      number: str(r.flight_number),
      airlineIata: str(r.airline_iata),
      airlineIcao: str(r.airline_icao),
      airlineName: str(r.airline_name),
      codeshare: str(r.cs_flight_iata) ? { flightIata: str(r.cs_flight_iata), airlineIata: str(r.cs_airline_iata) } : null,
    },
    status: { code: normalizeStatus(statusRaw), raw: statusRaw },
    departure: endpointFrom(r, 'dep'),
    arrival: endpointFrom(r, 'arr'),
    aircraft: {
      icao: str(r.aircraft_icao) && str(r.aircraft_icao).toUpperCase(),
      name: modelName(r),
      registration: str(r.reg_number) && str(r.reg_number).toUpperCase(),
      hex: str(r.hex),
    },
    position: null,
    durationMin: num(r.duration),
    fetchedAt: null,
  };
  if (!inst.flight.airlineIata && flightCode.type === 'iata') inst.flight.airlineIata = flightCode.airline;
  if (!inst.flight.iata && !inst.flight.icao) inst.flight[flightCode.type] = flightCode.code;

  // A position is only trusted for an airborne (or unknown-status) instance.
  // For a scheduled flight it could be the aircraft's previous leg.
  const pos = positionFrom(r);
  const s = inst.status.code;
  if (pos && (s === 'airborne' || s === 'unknown' || s === 'diverted' || source === 'flights')) {
    inst.position = pos;
  }
  if (source === 'flights' && s === 'unknown' && pos) inst.status.code = 'airborne';

  inst.id = instanceId(inst, flightCode);
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

function fillNulls(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (target[k] == null && v != null) target[k] = v;
  }
}

/** Merges b into a; values already present in a (the richer source) win. */
function mergeInstances(a, b) {
  fillNulls(a.flight, b.flight);
  fillNulls(a.departure, b.departure);
  fillNulls(a.arrival, b.arrival);
  fillNulls(a.aircraft, b.aircraft);
  if (a.status.code === 'unknown' && b.status.code !== 'unknown') a.status = b.status;
  if (!a.position && b.position) a.position = b.position;
  if (a.durationMin == null) a.durationMin = b.durationMin;
  a.sources = unique([...a.sources, ...b.sources]);
  return a;
}

function addOrMerge(list, inst) {
  const existing = list.find((x) => {
    if (x.departure.iata !== inst.departure.iata) return false;
    if (x.departure.scheduled != null && inst.departure.scheduled != null) {
      return Math.abs(x.departure.scheduled - inst.departure.scheduled) <= SAME_INSTANCE_WINDOW_MS;
    }
    return x.id === inst.id;
  });
  if (existing) mergeInstances(existing, inst);
  else list.push(inst);
}

function wantsLivePosition(inst, now) {
  const s = inst.status.code;
  if (s === 'landed' || s === 'cancelled') return false;
  const dep = inst.departure.actual ?? inst.departure.estimated ?? inst.departure.scheduled;
  const airborne = s === 'airborne' || s === 'diverted' || (dep != null && dep <= now && s !== 'scheduled');
  if (!airborne) return false;
  if (!inst.position) return true;
  const t = inst.position.updated ?? inst.fetchedAt ?? now;
  return now - t > LIVE_REFRESH_AFTER_MS;
}

/**
 * Attaches a live position record (from /flights) to the instance it belongs
 * to, or creates an instance from it when no scheduled instance matches.
 */
function attachLive(list, liveRec, flightCode, now, { allowCreate = true } = {}) {
  const pos = positionFrom(liveRec);
  if (!pos) return;
  const dep = str(liveRec.dep_iata);
  const arr = str(liveRec.arr_iata);
  const liveStatus = normalizeStatus(liveRec.status);
  if (liveStatus === 'landed' || liveStatus === 'scheduled') return;

  const matches = list.filter((inst) => {
    if (dep && inst.departure.iata && inst.departure.iata !== dep) return false;
    if (arr && inst.arrival.iata && inst.arrival.iata !== arr) return false;
    if (inst.status.code === 'landed' || inst.status.code === 'cancelled') return false;
    const d = inst.departure.actual ?? inst.departure.estimated ?? inst.departure.scheduled;
    const a = inst.arrival.actual ?? inst.arrival.estimated ?? inst.arrival.scheduled;
    if (inst.status.code === 'airborne') return true;
    // Scheduled instance: accept only if it should be in the air around now.
    return d != null && d <= now + 30 * 60e3 && (a == null || a >= now - 60 * 60e3);
  });
  matches.sort((x, y) => (x.status.code === 'airborne' ? -1 : 0) - (y.status.code === 'airborne' ? -1 : 0));
  const target = matches[0];

  if (target) {
    const current = target.position;
    const currentT = current && current.updated != null ? current.updated : -Infinity;
    const liveT = pos.updated != null ? pos.updated : now;
    if (!current || liveT >= currentT) target.position = pos;
    // The real-time feed is direct evidence the flight is flying.
    if (target.status.code === 'scheduled' || target.status.code === 'unknown') {
      target.status = { code: 'airborne', raw: target.status.raw };
    }
    if (!target.aircraft.registration) target.aircraft.registration = str(liveRec.reg_number);
    if (!target.aircraft.icao) target.aircraft.icao = str(liveRec.aircraft_icao);
    if (!target.aircraft.name) target.aircraft.name = aircraftName(liveRec.aircraft_icao);
    if (!target.aircraft.hex) target.aircraft.hex = str(liveRec.hex);
    target.sources = unique([...target.sources, 'flights']);
  } else if (allowCreate) {
    list.push(normalizeRecord(liveRec, 'flights', flightCode));
  }
}

module.exports = {
  AirLabsProvider,
  // exported for tests
  _internal: { normalizeRecord, mapApiError, utcOffsetFromRecord, sameInstance, parseWallClock, str },
};
