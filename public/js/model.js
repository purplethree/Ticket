/**
 * FlightTracker turns (infrequent) flight-data snapshots into smooth,
 * continuous values: route progress, ETA, countdown and derived status.
 *
 * Progress sources, best first:
 *   live      real aircraft position projected onto the great-circle route,
 *             then extrapolated from the time of that signal so the plane
 *             keeps moving smoothly between refreshes
 *   time      (now − departure) / (arrival − departure), used when there is
 *             no fresh position
 *   landed    100 %
 *   scheduled 0 % (not departed yet)
 *
 * When a refresh changes the answer, the difference is blended out over a
 * few seconds instead of jumping. The ETA is blended the same way, so the
 * countdown glides to a revised arrival time.
 */

import { routeProgress, distanceKm, isCoord } from './geo.js';

const FRESH_POSITION_MS = 15 * 60e3;
const ETA_BLEND_MS = 2400;
const MIN = 60e3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const wallNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function departureRef(flight) {
  const d = flight.departure;
  return d.actual ?? d.estimated ?? d.scheduled ?? null;
}

function buildTarget(flight, now, receivedAt) {
  const dep = flight.departure;
  const arr = flight.arrival;
  const s = flight.status.code;
  const depRef = departureRef(flight);
  const eta = arr.actual ?? arr.estimated ?? arr.scheduled ?? null;
  const etaKind = arr.actual != null ? 'actual' : arr.estimated != null ? 'estimated' : arr.scheduled != null ? 'scheduled' : null;
  const hasRoute = isCoord(dep) && isCoord(arr);
  const routeKm = hasRoute ? distanceKm(dep, arr) : null;
  const base = { eta, etaKind, depRef, routeKm, route: null, posTime: null };

  if (s === 'landed' || (arr.actual != null && arr.actual <= now)) {
    return { ...base, mode: 'landed', progress: () => 1 };
  }
  if (s === 'cancelled') {
    return { ...base, mode: 'cancelled', eta: null, progress: () => 0 };
  }

  const inAir = s === 'airborne' || s === 'diverted' || s === 'incident';
  const pos = flight.position;
  if (pos && hasRoute && isCoord(pos) && (inAir || s === 'unknown')) {
    const posTime = Math.min(pos.updated ?? receivedAt, now);
    if (now - posTime < FRESH_POSITION_MS) {
      const route = routeProgress(dep, arr, pos);
      if (route) {
        const p0 = route.fraction;
        let rate = 0;
        const speedRate = isNum(pos.speedKmh) && pos.speedKmh > 60 ? pos.speedKmh / 3.6e6 / routeKm : null;
        if (eta != null && eta - posTime > MIN) {
          rate = (1 - p0) / (eta - posTime);
          // A stale ETA must not make the plane race or crawl.
          if (speedRate) rate = clamp(rate, speedRate * 0.5, speedRate * 1.6);
        } else if (speedRate) {
          rate = speedRate;
        }
        return {
          ...base,
          mode: 'live',
          route,
          posTime,
          progress: (t) => clamp(p0 + rate * (t - posTime), 0, 1),
        };
      }
    }
  }

  const departed = inAir || (dep.actual != null && dep.actual <= now) || (s === 'unknown' && depRef != null && depRef <= now);
  if (departed && depRef != null && eta != null && eta > depRef) {
    return { ...base, mode: 'time', progress: (t) => clamp((t - depRef) / (eta - depRef), 0, 1) };
  }
  if (!departed) return { ...base, mode: 'scheduled', progress: () => 0 };
  return { ...base, mode: 'unknown', progress: () => 0 };
}

export class FlightTracker {
  /** @param {{now: () => number}} clock  real clock for live, simulated clock for demo */
  constructor(clock) {
    this.clock = clock;
    this.flight = null;
    this.target = null;
    this.corr = null;
    this.etaCorr = null;
    this.prevPosition = null;
    this.receivedAt = null;
    this.landBlend = null;
  }

  /**
   * @param flight   normalized instance
   * @param opts.fresh  true for the first load (no blending from the old flight)
   */
  setFlight(flight, { receivedAt, fresh = false } = {}) {
    const now = this.clock.now();
    const wall = wallNow();
    // A tracking session follows one flight instance, so any update that is
    // not a fresh load continues from what is currently on screen.
    const continuing = !fresh && !!this.flight;
    const shown = continuing ? this.progressAt(now) : null;
    const shownEta = continuing ? this.etaAt(now) : null;

    if (continuing && this.flight.position && flight.position && this.flight.position !== flight.position) {
      this.prevPosition = { ...this.flight.position, seenAt: this.receivedAt };
    } else if (!continuing) {
      this.prevPosition = null;
      this.landBlend = null;
    }

    this.flight = flight;
    this.receivedAt = receivedAt ?? now;
    this.target = buildTarget(flight, now, this.receivedAt);

    this.corr = null;
    if (shown != null) {
      const diff = shown - this.target.progress(now);
      if (Math.abs(diff) > 1e-5) {
        this.corr = { diff, start: wall, dur: 2500 + Math.min(1, Math.abs(diff) * 8) * 5500 };
      }
    }
    this.etaCorr = null;
    if (isNum(shownEta) && isNum(this.target.eta) && Math.abs(shownEta - this.target.eta) >= 1000) {
      this.etaCorr = { diff: shownEta - this.target.eta, start: wall, dur: ETA_BLEND_MS };
    }
  }

  progressAt(now) {
    if (!this.target) return 0;
    let p = this.target.progress(now);
    if (this.corr) {
      const k = (wallNow() - this.corr.start) / this.corr.dur;
      if (k >= 1) this.corr = null;
      else p += this.corr.diff * (1 - ease(clamp(k, 0, 1)));
    }
    return clamp(p, 0, 1);
  }

  etaAt() {
    if (!this.target || !isNum(this.target.eta)) return null;
    let eta = this.target.eta;
    if (this.etaCorr) {
      const k = (wallNow() - this.etaCorr.start) / this.etaCorr.dur;
      if (k >= 1) this.etaCorr = null;
      else eta += this.etaCorr.diff * (1 - ease(clamp(k, 0, 1)));
    }
    return eta;
  }

  positionAge(now) {
    const p = this.flight && this.flight.position;
    if (!p) return null;
    return Math.max(0, now - (p.updated ?? this.receivedAt ?? now));
  }

  isDescending(now, remainingMs) {
    const pos = this.flight.position;
    if (!pos || this.target.mode !== 'live') return false;
    if (!isNum(remainingMs) || remainingMs > 50 * MIN) return false;
    if (isNum(pos.verticalSpeedKmh) && pos.verticalSpeedKmh <= -8) return true;
    const prev = this.prevPosition;
    if (prev && isNum(prev.altitudeM) && isNum(pos.altitudeM)) {
      const prevT = prev.updated ?? prev.seenAt;
      const curT = pos.updated ?? this.receivedAt;
      if (isNum(prevT) && isNum(curT) && curT - prevT < 10 * MIN && prev.altitudeM - pos.altitudeM >= 150) return true;
    }
    return false;
  }

  /** Status shown on the pass. Only uses statuses supported by the data. */
  status(now, remainingMs, { boardingTime = null } = {}) {
    const f = this.flight;
    const s = f.status.code;
    const mode = this.target.mode;
    if (mode === 'landed') return { label: 'LANDED', tone: 'ok' };
    if (s === 'cancelled') return { label: 'CANCELLED', tone: 'bad' };
    if (s === 'diverted') return { label: 'DIVERTED', tone: 'bad' };
    if (s === 'incident') return { label: 'INCIDENT', tone: 'bad' };

    const detail = f.status.detail || null;
    const evidenceInAir = s === 'airborne' || mode === 'live' || f.departure.actual != null;
    if (evidenceInAir && (mode === 'live' || mode === 'time')) {
      // "Approaching" is reported by the data provider; otherwise descent is
      // derived from the aircraft's vertical speed / altitude trend.
      if (detail === 'approaching' || this.isDescending(now, remainingMs)) return { label: 'DESCENDING', tone: 'accent' };
      const since = f.departure.actual != null ? now - f.departure.actual : null;
      const justLeft = since != null && since >= 0 && since < 20 * MIN;
      // "Departed" only right after take-off; later it's simply in flight.
      if (mode !== 'live' && (justLeft || (detail === 'departed' && since == null))) {
        return { label: 'DEPARTED', tone: 'accent' };
      }
      return { label: 'IN FLIGHT', tone: 'accent' };
    }
    if (mode === 'scheduled') {
      const depRef = this.target.depRef;
      if (detail === 'boarding') return { label: 'BOARDING', tone: 'ok' };
      if (detail === 'gate-closed') return { label: 'GATE CLOSED', tone: 'warn' };
      if (isNum(boardingTime) && now >= boardingTime && (depRef == null || now < depRef)) {
        return { label: 'BOARDING', tone: 'ok' };
      }
      const d = f.departure;
      const delay = isNum(d.delayMin) ? d.delayMin : isNum(d.estimated) && isNum(d.scheduled) ? (d.estimated - d.scheduled) / MIN : 0;
      if (delay >= 15 || detail === 'delayed') return { label: 'DELAYED', tone: 'warn' };
      if (s === 'scheduled') return { label: 'SCHEDULED', tone: 'neutral' };
    }
    return { label: '—', tone: 'neutral' };
  }

  /** Everything the renderer needs for one frame. */
  snapshot(opts = {}) {
    const now = this.clock.now();
    const t = this.target;
    let progress = this.progressAt(now);
    const eta = this.etaAt(now);
    const remainingMs = isNum(eta) ? Math.max(0, eta - now) : null;
    const status = this.status(now, remainingMs, opts);
    const cancelled = t.mode === 'cancelled';
    const landedConfirmed = t.mode === 'landed';
    // The countdown shows LANDED at zero (or once landing is confirmed).
    const timerLanded = landedConfirmed || (!cancelled && t.mode !== 'scheduled' && remainingMs === 0);
    // ...and the plane glides onto the destination marker at the same moment.
    if (timerLanded) {
      if (!this.landBlend) this.landBlend = { from: progress, start: wallNow() };
      const k = clamp((wallNow() - this.landBlend.start) / 1500, 0, 1);
      progress = this.landBlend.from + (1 - this.landBlend.from) * ease(k);
    } else {
      this.landBlend = null;
    }
    const routeKm = t.routeKm;
    return {
      now,
      mode: t.mode,
      progress,
      eta,
      etaKind: t.etaKind,
      remainingMs,
      timerLanded,
      landedConfirmed,
      cancelled,
      status,
      routeKm,
      remainingKm: isNum(routeKm) && t.mode !== 'unknown' ? (1 - progress) * routeKm : null,
      flownKm: isNum(routeKm) && t.mode !== 'unknown' ? progress * routeKm : null,
      positionAgeMs: this.positionAge(now),
    };
  }
}
