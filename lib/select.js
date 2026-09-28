'use strict';

/**
 * Chooses which daily instance of a repeating flight number the person most
 * likely means. Works on the provider-agnostic instance model, so it does not
 * care which flight-data API produced the instances.
 *
 * Preference order:
 *   1. an instance that is airborne right now
 *   2. today's upcoming instance (departing later today at the departure
 *      airport or within the next 12 h, or due to depart but not yet
 *      reported as departed)
 *   3. otherwise nothing is auto-selected: the person picks from the list,
 *      which shows the most recently completed instance first.
 *
 * If more than one instance shares the winning tier, nothing is
 * auto-selected either. We never silently pick a flight that is obviously
 * wrong.
 */

const HOUR = 3600e3;
const FRESH_POSITION_MS = 20 * 60e3;

const TIER_RANK = { airborne: 0, today: 1, completed: 2, future: 3, unknown: 4 };

function depRef(inst) {
  const d = inst.departure || {};
  return d.actual ?? d.estimated ?? d.scheduled ?? null;
}

function arrRef(inst) {
  const a = inst.arrival || {};
  return a.actual ?? a.estimated ?? a.scheduled ?? null;
}

function hasFreshPosition(inst, now) {
  const p = inst.position;
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
  if (p.updated == null) return true;
  return now - p.updated < FRESH_POSITION_MS;
}

function classify(inst, now) {
  const s = inst.status ? inst.status.code : 'unknown';
  const dep = depRef(inst);
  const arr = arrRef(inst);

  if (s === 'landed' || (inst.arrival && inst.arrival.actual != null && inst.arrival.actual <= now)) {
    return 'completed';
  }
  if (s === 'cancelled') {
    if (dep == null) return 'unknown';
    if (dep > now) return isTodayDeparture(inst, dep, now) ? 'today' : 'future';
    if (dep >= now - 12 * HOUR) return 'today';
    return 'completed';
  }
  if (s === 'airborne' || hasFreshPosition(inst, now)) return 'airborne';
  if (s === 'diverted' || s === 'incident') {
    return arr != null && arr < now - HOUR ? 'completed' : 'airborne';
  }
  if (dep == null) return 'unknown';
  if (dep > now) return isTodayDeparture(inst, dep, now) ? 'today' : 'future';
  // Scheduled (or unknown) but the arrival time is well in the past: this
  // instance is over, even if the data never reported the landing.
  if (arr != null && arr < now - HOUR) return 'completed';
  // Due to depart but not reported as departed yet (e.g. delayed).
  if (dep >= now - 12 * HOUR) return 'today';
  return 'completed';
}

/**
 * "Today's" departure: same calendar day at the departure airport, or
 * leaving within the next 12 hours (a late-evening search for a flight
 * shortly after midnight still means tonight's flight).
 */
function isTodayDeparture(inst, dep, now) {
  if (dep - now <= 12 * HOUR) return true;
  const d = localDateAt(dep, inst.departure);
  return d != null && d === localDateAt(now, inst.departure);
}

/** Calendar date (YYYY-MM-DD) of instant `t` at an airport. */
function localDateAt(t, airport) {
  if (t == null) return null;
  const a = airport || {};
  if (Number.isFinite(a.utcOffsetMin)) {
    return new Date(t + a.utcOffsetMin * 60e3).toISOString().slice(0, 10);
  }
  if (a.timezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: a.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(t));
    } catch {
      /* unknown zone: fall through */
    }
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** Local calendar date (YYYY-MM-DD) of the departure at the departure airport. */
function departureLocalDate(inst) {
  const d = inst.departure || {};
  return localDateAt(d.scheduled ?? d.estimated ?? d.actual, d);
}

function sortCandidates(list, now) {
  return list
    .map((inst) => ({ inst, tier: classify(inst, now), dep: depRef(inst) }))
    .sort((a, b) => {
      const r = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (r) return r;
      if (a.dep == null) return 1;
      if (b.dep == null) return -1;
      // completed: most recent first; everything else: soonest first
      return a.tier === 'completed' ? b.dep - a.dep : a.dep - b.dep;
    });
}

function prettyDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

/**
 * @returns {{selectedId: string|null, reason: string, message: string|null,
 *            candidates: Array<object>}}
 */
function selectInstance(instances, { date = null, now = Date.now(), display = 'this flight' } = {}) {
  const sorted = sortCandidates(instances, now);
  const candidates = sorted.map(({ inst, tier }) => ({ ...inst, tier, localDate: departureLocalDate(inst) }));
  const result = (selectedId, reason, message = null) => ({ selectedId, reason, message, candidates });

  let pool = candidates;
  if (date) {
    pool = candidates.filter((c) => c.localDate === date);
    if (pool.length === 0) {
      return result(
        null,
        'date_mismatch',
        `Couldn't find ${display} departing on ${prettyDate(date)}. Live data covers flights around today. Choose another flight instance below.`,
      );
    }
    if (pool.length === 1) return result(pool[0].id, 'date');
  }

  const airborne = pool.filter((c) => c.tier === 'airborne');
  if (airborne.length === 1) return result(airborne[0].id, 'airborne');
  if (airborne.length > 1) {
    return result(null, 'multiple_airborne', `More than one ${display} is in the air right now. Choose yours.`);
  }

  const today = pool.filter((c) => c.tier === 'today');
  if (today.length === 1) return result(today[0].id, 'upcoming');
  if (today.length > 1) {
    return result(
      null,
      'multiple_today',
      date
        ? `${display} has more than one departure on ${prettyDate(date)}. Choose yours.`
        : `${display} operates more than once today. Choose your flight.`,
    );
  }

  return result(null, 'no_active', `Couldn't find an active ${display}. Choose another flight instance below.`);
}

module.exports = { selectInstance, classify, departureLocalDate, depRef, arrRef };
