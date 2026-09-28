/**
 * Until Landing: app controller.
 *
 * Talks only to this project's own server (/api/*). The flight-data API key
 * never reaches the browser.
 */

import { FlightTracker, departureRef } from './model.js';
import { Widgets, PLANE_SVG } from './render.js';
import { DemoClock, DemoFlight } from './demo.js';
import {
  DASH,
  isNum,
  fmtInt,
  formatDuration,
  formatAgo,
  formatCountdown,
  airportTime,
  airportDayDate,
  wallClock,
  compassPoint,
  formatCoord,
  escapeHtml,
  titleCase,
  shortAirportName,
} from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const body = document.body;

/* ───────────────────────────── Settings ───────────────────────────── */

const STORE_KEY = 'until-landing.settings.v1';
const DEFAULT_PASSENGER = {
  name: 'DEREK YANG',
  seat: '12A',
  group: '3',
  cabin: 'ECONOMY',
  pnr: '',
  seq: '',
  boarding: '',
};
const CHOICES = {
  layout: ['full', 'compact', 'minimal'],
  bg: ['dark', 'light', 'green'],
  pos: ['center', 'top-right', 'bottom-right', 'bottom-center'],
  size: ['s', 'm', 'l'],
  accent: ['blue', 'gold', 'white'],
  // Reel Mode control bar: appears on mouse move / tap, or never (ticket only).
  bar: ['auto', 'hidden'],
};
const POS_LABELS = { center: 'Center', 'top-right': 'Top right', 'bottom-right': 'Bottom right', 'bottom-center': 'Bottom center' };

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const s = { layout: 'full', bg: 'dark', pos: 'center', size: 'm', accent: 'blue', bar: 'auto' };
  for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(saved[k])) s[k] = saved[k];
  s.passenger = { ...DEFAULT_PASSENGER };
  if (saved.passenger && typeof saved.passenger === 'object') {
    for (const k of Object.keys(DEFAULT_PASSENGER)) {
      if (typeof saved.passenger[k] === 'string') s.passenger[k] = saved.passenger[k].slice(0, 40);
    }
  }
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode or storage blocked: settings just won't persist */
  }
}

const settings = loadSettings();

function applySettings() {
  for (const k of Object.keys(CHOICES)) body.dataset[k] = settings[k];
  $$('[data-seg]').forEach((group) => {
    const key = group.dataset.seg;
    if (!(key in CHOICES)) return;
    $$('button[data-value]', group).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === settings[key])));
  });
  const theme = { dark: '#070708', light: '#ececef', green: '#00ff00' }[settings.bg];
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme);
  const posBtn = $('#reel-pos-btn');
  if (posBtn) posBtn.textContent = POS_LABELS[settings.pos];
}

function setSetting(key, value) {
  if (!CHOICES[key] || !CHOICES[key].includes(value)) return;
  settings[key] = value;
  applySettings();
  saveSettings();
  scheduleFit();
}

/**
 * Reel Mode scales the widget to the 9:16 frame. Long names or many filled-in
 * fields make the full ticket taller, so measure it and shrink to fit.
 */
function fitReel() {
  const slot = $('#widget-slot');
  if (!body.classList.contains('reel')) {
    slot.style.removeProperty('--fit');
    return;
  }
  const w = slot.querySelector(`.widget[data-widget="${settings.layout}"]`);
  if (!w) return;
  slot.style.setProperty('--fit', '1');
  const cs = getComputedStyle(slot);
  const availH = slot.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const availW = slot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const r = w.getBoundingClientRect();
  if (!r.height || !r.width) return;
  const fit = Math.min(1, availH / r.height, availW / r.width);
  if (fit < 1) slot.style.setProperty('--fit', String(Math.max(0.4, fit * 0.995).toFixed(4)));
}

let fitQueued = false;
function scheduleFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitReel();
  });
}
window.addEventListener('resize', scheduleFit);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);

function cycleSetting(key) {
  const list = CHOICES[key];
  setSetting(key, list[(list.indexOf(settings[key]) + 1) % list.length]);
}

/* ───────────────────────────── API ───────────────────────────── */

class ApiError extends Error {
  constructor(code, message, retryAfterSeconds = null) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function api(path, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError(
      e.name === 'AbortError' ? 'TIMEOUT' : 'LOCAL_NETWORK',
      e.name === 'AbortError'
        ? 'The request took too long. Check your connection and try again.'
        : "Couldn't reach the local server. Make sure `npm start` is still running, then try again.",
    );
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.error) {
    const e = (data && data.error) || {};
    throw new ApiError(e.code || 'UPSTREAM', e.message || 'Something went wrong loading flight data. Try again in a moment.', e.retryAfterSeconds);
  }
  return data;
}

let config = { liveAvailable: true, refreshSeconds: 60 };

/* ───────────────────────────── Views ───────────────────────────── */

function showView(name) {
  body.dataset.view = name;
  if (name !== 'tracker') {
    stopFrameLoop();
    if (body.classList.contains('reel')) setReel(false);
  } else {
    startFrameLoop();
  }
  closeDisplayMenu();
  window.scrollTo(0, 0);
}

let toastTimer = null;
/** Short message at the bottom. Suppressed in a clean (bar hidden) Reel Mode unless forced. */
function toast(message, ms = 2400, { force = false } = {}) {
  if (!force && barHidden()) return;
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

function setNotice(message, kind = 'info') {
  const el = $('#tracker-notice');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

/* ───────────────────────────── Search ───────────────────────────── */

const FLIGHT_RE = /^([A-Z]{3}\d{1,4}[A-Z]?|[A-Z0-9]{2}\d{1,4}[A-Z]?)$/;

function normalizeFlightInput(v) {
  return String(v || '')
    .toUpperCase()
    .replace(/[\s\-_.\/]/g, '');
}

function showSearchError(message) {
  const el = $('#search-error');
  el.textContent = message || '';
  el.hidden = !message;
}

let searchToken = 0;

async function runSearch(rawFlight, date) {
  const flight = normalizeFlightInput(rawFlight);
  if (!flight) {
    showView('search');
    showSearchError('Enter a flight number, for example EY416.');
    $('#flight-input').focus();
    return;
  }
  if (!FLIGHT_RE.test(flight) || /^\d{2}/.test(flight)) {
    showView('search');
    showSearchError(`“${rawFlight.trim()}” doesn't look like a flight number. Try something like EY416.`);
    $('#flight-input').focus();
    return;
  }
  showSearchError('');
  stopSession();

  const token = ++searchToken;
  $('#locating-code').textContent = flight;
  showView('loading');
  const started = performance.now();

  try {
    const params = new URLSearchParams({ flight });
    if (date) params.set('date', date);
    // A search can take several upstream calls; allow for a slow provider.
    const data = await api(`/api/search?${params}`, { timeoutMs: 50000 });
    // Let the locating animation register instead of flashing.
    const wait = 650 - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (token !== searchToken) return;

    const selected = data.selectedId && data.candidates.find((c) => c.id === data.selectedId);
    if (selected) {
      startLive(selected, data);
    } else {
      showInstancePicker(data, data.message);
    }
  } catch (err) {
    if (token !== searchToken) return;
    showView('search');
    showSearchError(err.message);
  }
}

/* ───────────────────────────── Instance picker ───────────────────────────── */

let lastSearch = null;

function instanceStatus(inst) {
  const clock = { now: () => Date.now() };
  const t = new FlightTracker(clock);
  t.setFlight(inst, { fresh: true, receivedAt: inst.fetchedAt || Date.now() });
  return t.snapshot().status;
}

function showInstancePicker(search, message) {
  lastSearch = search;
  const code = search.query.flight;
  $('#select-title').textContent = message ? 'Choose your flight' : `Other ${code} flights`;
  $('#select-message').textContent = message || 'Pick the departure you want to track.';
  const list = $('#instance-list');
  list.innerHTML = '';
  for (const c of search.candidates) {
    const dep = c.departure;
    const arr = c.arrival;
    const depT = dep.actual ?? dep.estimated ?? dep.scheduled;
    const arrT = arr.actual ?? arr.estimated ?? arr.scheduled;
    const st = instanceStatus(c);
    const when = [
      isNum(depT) ? airportDayDate(depT, dep) : null,
      isNum(depT) ? `DEP ${airportTime(depT, dep)}` : null,
      isNum(arrT) ? `ARR ${airportTime(arrT, arr)}` : null,
    ]
      .filter(Boolean)
      .join('  ·  ');
    const cities = [dep.city || shortAirportName(dep.name), arr.city || shortAirportName(arr.name)].filter(Boolean);
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="instance" data-id="${escapeHtml(c.id)}">
        <span class="inst-route">${escapeHtml(dep.iata || dep.icao || DASH)}${PLANE_SVG}${escapeHtml(arr.iata || arr.icao || DASH)}</span>
        ${cities.length === 2 ? `<span class="inst-cities">${escapeHtml(titleCase(cities[0]))} → ${escapeHtml(titleCase(cities[1]))}</span>` : ''}
        <span class="inst-when">${escapeHtml(when || 'Time not available')}</span>
        <span class="status-pill" data-tone="${st.tone}"><i></i>${escapeHtml(st.label)}</span>
      </button>`;
    list.appendChild(li);
  }
  showView('select');
}

/* ───────────────────────────── Tracking session ───────────────────────────── */

let session = null;
let widgets = null;

function stopSession() {
  if (!session) return;
  clearTimeout(session.timer);
  clearInterval(session.demoTimer);
  session = null;
  if (widgets) {
    widgets.destroy();
    widgets = null;
  }
  setNotice('');
  document.title = 'Until Landing · Live Flight Study Tracker';
}

function buildWidgets() {
  if (widgets) widgets.destroy();
  widgets = new Widgets($('#widget-slot'));
  widgets.setDemo(session.kind === 'demo');
  buildLivePanel();
  renderStatic();
}

function flightCodeOf(flight) {
  return flight.flight.iata || flight.flight.icao || '';
}

function computeBoardingTime() {
  const hhmm = settings.passenger.boarding;
  if (!session || !/^\d{2}:\d{2}$/.test(hhmm || '')) return null;
  const f = session.tracker.flight;
  const dep = f.departure;
  const depT = dep.scheduled ?? dep.estimated ?? dep.actual;
  if (!isNum(depT)) return null;
  const w = wallClock(depT, dep);
  const depMinute = Math.floor(depT / 60e3) * 60e3;
  const offset = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - depMinute;
  const [hh, mm] = hhmm.split(':').map(Number);
  let t = Date.UTC(w.year, w.month - 1, w.day, hh, mm) - offset;
  if (t > depT) t -= 24 * 3600e3;
  return t;
}

function renderStatic() {
  if (!session || !widgets) return;
  session.boardingTime = computeBoardingTime();
  widgets.renderStatic(session.tracker.flight, settings.passenger, session.tracker);
  const others = session.kind === 'live' && session.search && session.search.candidates.length > 1;
  const btn = $('#other-instances');
  btn.hidden = !others;
  if (others) btn.textContent = `Other ${session.search.query.flight} flights (${session.search.candidates.length - 1})`;
  $('#demo-bar').hidden = session.kind !== 'demo';
  scheduleFit();
}

/** Keeps static facts (coordinates, names, time zones) if a refresh omits them. */
function carryStatic(prev, next) {
  if (!prev) return next;
  for (const side of ['departure', 'arrival']) {
    for (const k of ['lat', 'lng', 'name', 'city', 'country', 'timezone', 'utcOffsetMin', 'icao']) {
      if (next[side][k] == null && prev[side][k] != null && prev[side].iata === next[side].iata) {
        next[side][k] = prev[side][k];
      }
    }
  }
  if (!next.flight.airlineName && prev.flight.airlineName) next.flight.airlineName = prev.flight.airlineName;
  for (const k of ['name', 'icao', 'registration']) {
    if (next.aircraft[k] == null && prev.aircraft[k] != null) next.aircraft[k] = prev.aircraft[k];
  }
  return next;
}

function startLive(instance, search) {
  stopSession();
  const clock = { now: () => Date.now() };
  session = {
    kind: 'live',
    clock,
    tracker: new FlightTracker(clock),
    search,
    ref: {
      dep: instance.departure.iata,
      arr: instance.arrival.iata,
      sched: instance.departure.scheduled,
      date: instance.localDate || null,
    },
    lastFetchWall: performance.now(),
    failures: 0,
    missing: 0,
    stopped: false,
    inflight: false,
    zeroHandled: false,
    timer: null,
  };
  session.tracker.setFlight(instance, { fresh: true, receivedAt: instance.fetchedAt || Date.now() });
  arrival.reset();
  buildWidgets();
  showView('tracker');
  updateUrl({ flight: search.query.flight, date: search.query.date || null, demo: null });
  scheduleRefresh();
}

/* ─────────── Live refresh (never every second; adaptive, pauses when hidden) ─────────── */

const FATAL_CODES = new Set(['NO_API_KEY', 'INVALID_API_KEY', 'INVALID_FLIGHT']);

function refreshDelay() {
  const base = config.refreshSeconds * 1000;
  const snap = session.tracker.snapshot();
  if (snap.landedConfirmed || snap.cancelled) return null;
  if (session.missing >= 3) return null;
  if (session.failures > 0) {
    const last = session.lastError;
    if (last && (last.code === 'QUOTA_EXCEEDED')) return 30 * 60e3;
    if (last && last.code === 'RATE_LIMIT') return Math.max(5 * 60e3, (last.retryAfterSeconds || 0) * 1000);
    return Math.min(10 * 60e3, base * 2 ** (session.failures - 1));
  }
  if (session.missing > 0) return 5 * 60e3;
  if (snap.mode === 'scheduled') {
    const dep = departureRef(session.tracker.flight);
    const until = isNum(dep) ? dep - Date.now() : Infinity;
    if (until > 3 * 3600e3) return 15 * 60e3;
    if (until > 3600e3) return 5 * 60e3;
    if (until > 20 * 60e3) return 2 * 60e3;
    return base;
  }
  if (snap.timerLanded) {
    // ETA reached but landing not confirmed yet: keep checking for a while.
    if (isNum(snap.eta) && Date.now() - snap.eta > 3 * 3600e3) return null;
    return Math.max(base, 45e3);
  }
  return base;
}

function scheduleRefresh(delay) {
  if (!session || session.kind !== 'live') return;
  clearTimeout(session.timer);
  if (session.stopped) return;
  const d = delay ?? refreshDelay();
  if (d == null) return;
  session.timer = setTimeout(refreshLive, d);
}

async function refreshLive() {
  const s = session;
  if (!s || s.kind !== 'live' || s.inflight || s.stopped) return;
  if (document.hidden) {
    s.pendingRefresh = true;
    return;
  }
  s.pendingRefresh = false;
  s.inflight = true;
  try {
    const params = new URLSearchParams({ flight: s.search.query.flight });
    if (s.ref.dep) params.set('dep', s.ref.dep);
    if (s.ref.arr) params.set('arr', s.ref.arr);
    if (isNum(s.ref.sched)) params.set('sched', String(s.ref.sched));
    if (s.ref.date) params.set('date', s.ref.date);
    const data = await api(`/api/flight?${params}`);
    if (s !== session) return;
    s.failures = 0;
    s.lastError = null;
    if (data.instance) {
      s.missing = 0;
      const next = carryStatic(s.tracker.flight, data.instance);
      s.tracker.setFlight(next, { receivedAt: next.fetchedAt || Date.now() });
      s.lastFetchWall = performance.now();
      if (!s.tracker.snapshot().timerLanded) s.zeroHandled = false;
      setNotice('');
      renderStatic();
    } else {
      // No new data: keep "UPDATED … AGO" counting from the last real update.
      s.missing++;
      setNotice('The data provider no longer lists this flight. Showing the last data received.');
    }
  } catch (err) {
    if (s !== session) return;
    s.failures++;
    s.lastError = err;
    if (FATAL_CODES.has(err.code)) {
      s.stopped = true;
      setNotice(`${err.message} Live updates are paused.`, 'error');
    } else {
      setNotice(`${err.message} The card keeps running on the last data and retries automatically.`, 'error');
    }
  } finally {
    s.inflight = false;
    if (s === session) scheduleRefresh();
  }
}

// Back on the tab: catch up only if a planned refresh was skipped or is overdue.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !session || session.kind !== 'live' || session.stopped) return;
  const planned = refreshDelay();
  if (planned == null) return;
  const age = performance.now() - session.lastFetchWall;
  if (session.pendingRefresh || age > planned) refreshLive();
});

/* ───────────────────────────── Demo mode ───────────────────────────── */

const DEMO_REFRESH_MS = 5000;

function startDemo(scenario = 'cruise') {
  stopSession();
  const clock = new DemoClock();
  const demo = new DemoFlight(clock, scenario);
  session = {
    kind: 'demo',
    clock,
    demo,
    tracker: new FlightTracker(clock),
    lastFetchWall: performance.now(),
    demoTimer: null,
    speed: 1,
  };
  session.tracker.setFlight(demo.snapshot(), { fresh: true, receivedAt: clock.now() });
  session.demoTimer = setInterval(demoRefresh, DEMO_REFRESH_MS);
  arrival.reset();
  buildWidgets();
  syncDemoControls();
  showView('tracker');
  updateUrl({ flight: null, date: null, demo: '1' });
}

function demoRefresh() {
  if (!session || session.kind !== 'demo') return;
  const snap = session.demo.snapshot();
  session.tracker.setFlight(snap, { receivedAt: session.clock.now() });
  session.lastFetchWall = performance.now();
  renderStatic();
}

function syncDemoControls() {
  if (!session || session.kind !== 'demo') return;
  $('#demo-toggle').textContent = session.clock.paused ? 'Resume' : 'Pause';
  $$('[data-seg="demo-speed"] button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.value) === session.speed)));
  $$('[data-seg="demo-scenario"] button').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.value === session.demo.scenario)),
  );
}

function demoTogglePause() {
  if (!session || session.kind !== 'demo') return;
  if (session.clock.paused) {
    session.clock.resume();
    session.demoTimer = setInterval(demoRefresh, DEMO_REFRESH_MS);
    demoRefresh();
    toast('Demo resumed');
  } else {
    session.clock.pause();
    clearInterval(session.demoTimer);
    toast('Demo paused');
  }
  syncDemoControls();
}

function demoSetSpeed(speed) {
  if (!session || session.kind !== 'demo') return;
  session.speed = speed;
  session.clock.setSpeed(speed);
  demoRefresh();
  syncDemoControls();
}

function demoSetScenario(name) {
  if (!session || session.kind !== 'demo') return;
  session.demo.reset(name);
  session.tracker.setFlight(session.demo.snapshot(), { fresh: true, receivedAt: session.clock.now() });
  session.lastFetchWall = performance.now();
  arrival.reset();
  renderStatic();
  syncDemoControls();
}

/* ───────────────────────────── Frame loop ───────────────────────────── */

let rafId = null;
let lastFrameWall = 0;
let lastPanelWall = 0;
let lastTitle = '';

const arrival = {
  prev: null,
  timer: null,
  reset() {
    this.prev = null;
  },
  check(timerLanded) {
    if (this.prev === false && timerLanded) {
      $$('#widget-slot .widget').forEach((w) => w.classList.add('arrived'));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => $$('#widget-slot .widget').forEach((w) => w.classList.remove('arrived')), 4200);
    }
    this.prev = timerLanded;
  },
};

function sourceInfo(snap) {
  const demo = session.kind === 'demo';
  switch (snap.mode) {
    case 'live':
      return { label: demo ? 'SIMULATED POSITION' : 'LIVE POSITION', live: true };
    case 'time':
      return { label: snap.etaKind === 'scheduled' ? 'SCHEDULE BASED' : 'ETA BASED', live: false };
    case 'scheduled':
      return { label: 'AWAITING DEPARTURE', live: false };
    case 'landed':
      return { label: 'ARRIVED', live: false };
    case 'cancelled':
      return { label: 'CANCELLED', live: false };
    default:
      return { label: 'PROGRESS UNAVAILABLE', live: false };
  }
}

function frame() {
  rafId = requestAnimationFrame(frame);
  renderFrameNow();
}

function renderFrameNow() {
  lastFrameWall = performance.now();
  if (!session || !widgets) return;
  const tracker = session.tracker;
  const snap = tracker.snapshot({ boardingTime: session.boardingTime });
  const f = tracker.flight;
  const arr = f.arrival;
  const src = sourceInfo(snap);
  const arrT = isNum(arr.actual) ? arr.actual : snap.eta;
  const code = arr.iata || arr.icao || '';
  widgets.renderFrame(snap, {
    sourceLabel: src.label,
    sourceLive: src.live,
    updatedText: `UPDATED ${formatAgo(performance.now() - session.lastFetchWall)}`,
    arrivedText: isNum(arrT) ? `ARRIVED ${code} · ${airportTime(arrT, arr)}` : `ARRIVED ${code}`,
    arrivedShort: code ? `AT ${code}` : 'ARRIVED',
  });
  arrival.check(snap.timerLanded);

  // At zero, ask for confirmation of the landing a little later.
  if (session.kind === 'live' && snap.timerLanded && !snap.landedConfirmed && !session.zeroHandled) {
    session.zeroHandled = true;
    scheduleRefresh(20e3);
  }
  if (session.kind === 'demo' && snap.timerLanded && !snap.landedConfirmed && !session.clock.paused) {
    demoRefresh();
  }

  const title = snap.cancelled
    ? `${flightCodeOf(f)} · Cancelled`
    : snap.timerLanded
      ? `${flightCodeOf(f)} · Landed`
      : isNum(snap.remainingMs)
        ? `${formatCountdown(snap.remainingMs)} · ${flightCodeOf(f)}`
        : `${flightCodeOf(f)} · Until Landing`;
  if (title !== lastTitle) {
    lastTitle = title;
    document.title = title;
  }

  if (performance.now() - lastPanelWall > 450) {
    lastPanelWall = performance.now();
    updateLivePanel(snap, src);
  }
}

function startFrameLoop() {
  if (rafId == null) rafId = requestAnimationFrame(frame);
}

function stopFrameLoop() {
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
}

// Safety net: if animation frames are throttled (some capture setups), the
// countdown still ticks once per second from a plain timer.
setInterval(() => {
  if (body.dataset.view === 'tracker' && performance.now() - lastFrameWall > 900) renderFrameNow();
}, 500);

/* ───────────────────────────── Live flight panel ───────────────────────────── */

const PANEL_ROWS = [
  ['alt', 'Altitude'],
  ['speed', 'Ground speed'],
  ['vs', 'Vertical speed'],
  ['heading', 'Heading'],
  ['aircraft', 'Aircraft'],
  ['reg', 'Registration'],
  ['signal', 'Last signal'],
  ['pos', 'Position'],
  ['distLeft', 'Distance remaining'],
  ['distTotal', 'Route distance'],
  ['timeLeft', 'Time remaining'],
  ['progress', 'Progress'],
  ['schedDep', 'Sched. departure'],
  ['schedArr', 'Sched. arrival'],
  ['rawStatus', 'Data status'],
  ['provider', 'Data source'],
];
const panelCache = new Map();
const PROVIDER_LABELS = { aerodatabox: 'AeroDataBox', airlabs: 'AirLabs' };

function buildLivePanel() {
  const grid = $('#lp-grid');
  grid.innerHTML = PANEL_ROWS.map(([k, label]) => `<div><dt>${label}</dt><dd data-lp="${k}">${DASH}</dd></div>`).join('');
  panelCache.clear();
}

function setPanel(key, value) {
  const v = value == null || value === '' ? DASH : String(value);
  if (panelCache.get(key) === v) return;
  panelCache.set(key, v);
  const el = document.querySelector(`[data-lp="${key}"]`);
  if (el) el.textContent = v;
}

function updateLivePanel(snap, src) {
  if (body.classList.contains('reel')) return;
  const f = session.tracker.flight;
  const p = f.position;
  const sText = session.kind === 'demo' ? `DEMO · ${src.label}` : src.label;
  const srcEl = $('#lp-src');
  if (srcEl.textContent !== sText) srcEl.textContent = sText;

  const usePos = p && snap.mode !== 'landed' && snap.mode !== 'scheduled';
  setPanel('alt', usePos && isNum(p.altitudeM) ? `${fmtInt(Math.round((p.altitudeM * 3.28084) / 25) * 25)} ft` : null);
  setPanel('speed', usePos && isNum(p.speedKmh) ? `${fmtInt(p.speedKmh * 0.621371)} mph` : null);
  if (usePos && isNum(p.verticalSpeedKmh)) {
    const fpm = p.verticalSpeedKmh * 54.6807;
    setPanel('vs', Math.abs(fpm) < 100 ? 'Level' : `${fpm > 0 ? '+' : '−'}${fmtInt(Math.abs(fpm))} ft/min`);
  } else setPanel('vs', null);
  setPanel('heading', usePos && isNum(p.heading) ? `${Math.round(p.heading)}° ${compassPoint(p.heading)}` : null);
  setPanel('aircraft', f.aircraft.name || f.aircraft.icao);
  setPanel('reg', f.aircraft.registration);
  setPanel('signal', p && isNum(snap.positionAgeMs) ? formatAgo(snap.positionAgeMs).toLowerCase() : null);
  setPanel('pos', usePos ? formatCoord(p.lat, p.lng) : null);
  setPanel('distLeft', isNum(snap.remainingKm) ? `${fmtInt(snap.timerLanded ? 0 : snap.remainingKm)} km` : null);
  setPanel('distTotal', isNum(snap.routeKm) ? `${fmtInt(snap.routeKm)} km` : null);
  setPanel(
    'timeLeft',
    snap.cancelled ? null : snap.timerLanded ? 'Landed' : isNum(snap.remainingMs) ? formatDuration(snap.remainingMs) : null,
  );
  const method = { live: 'from position', time: 'from times', landed: 'arrived', scheduled: 'not departed' }[snap.mode];
  const pctText = snap.timerLanded ? '100%' : `${Math.floor(snap.progress * 100)}%`;
  setPanel('progress', snap.mode === 'unknown' || snap.cancelled ? null : `${pctText} · ${method}`);
  const d = f.departure;
  const a = f.arrival;
  setPanel('schedDep', isNum(d.scheduled) ? `${airportTime(d.scheduled, d)} ${d.iata || ''}`.trim() : null);
  setPanel('schedArr', isNum(a.scheduled) ? `${airportTime(a.scheduled, a)} ${a.iata || ''}`.trim() : null);
  setPanel('rawStatus', f.status.raw ? titleCase(f.status.raw) : null);
  setPanel('provider', session.kind === 'demo' ? 'Demo simulation' : PROVIDER_LABELS[f.provider] || f.provider);
}

/* ───────────────────────────── Reel mode ───────────────────────────── */

let reelHideTimer = null;

const barHidden = () => body.classList.contains('reel') && settings.bar === 'hidden';

function setReel(on) {
  body.classList.toggle('reel', on);
  scheduleFit();
  if (on) {
    closeDisplayMenu();
    closeEditor();
    if (settings.bar === 'hidden') {
      // Ticket only: no bar, no hints, no cursor.
      body.classList.remove('controls-visible');
      body.classList.add('idle');
    } else {
      showReelControls();
      toast('Esc to exit  ·  F fullscreen  ·  H hide bar', 2600);
    }
  } else {
    body.classList.remove('controls-visible', 'idle');
    hideToast();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
}

function showReelControls() {
  if (!body.classList.contains('reel')) return;
  if (settings.bar === 'hidden') {
    body.classList.remove('controls-visible');
    body.classList.add('idle');
    return;
  }
  body.classList.add('controls-visible');
  body.classList.remove('idle');
  clearTimeout(reelHideTimer);
  reelHideTimer = setTimeout(() => {
    if ($('#reel-controls').matches(':hover')) return showReelControls();
    body.classList.remove('controls-visible');
    body.classList.add('idle');
  }, 2200);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('Fullscreen is not available here'));
}

['pointermove', 'pointerdown', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, () => body.classList.contains('reel') && showReelControls(), { passive: true }),
);

function setBarHidden(hidden) {
  setSetting('bar', hidden ? 'hidden' : 'auto');
  if (hidden) {
    showReelControls(); // applies the hidden state
    toast('Bar hidden  ·  double-tap or press H to bring it back', 2200, { force: true });
  } else {
    hideToast();
    showReelControls();
  }
}

// With the bar hidden, a double-tap (phone) or double-click brings it back.
let lastTap = 0;
document.addEventListener('pointerup', (e) => {
  if (!barHidden() || e.target.closest('#reel-controls')) return;
  const now = performance.now();
  if (now - lastTap < 350) {
    lastTap = 0;
    if (window.getSelection) window.getSelection().removeAllRanges();
    setBarHidden(false);
  } else {
    lastTap = now;
  }
});

/* ───────────────────────────── Display menu & editor ───────────────────────────── */

function openDisplayMenu() {
  const menu = $('#display-menu');
  menu.hidden = false;
  $('[data-action="display"]').setAttribute('aria-expanded', 'true');
}
function closeDisplayMenu() {
  const menu = $('#display-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('[data-action="display"]').setAttribute('aria-expanded', 'false');
}

function openEditor() {
  const form = $('#editor-form');
  for (const [k, v] of Object.entries(settings.passenger)) {
    if (form.elements[k]) form.elements[k].value = v;
  }
  const sheet = $('#editor');
  sheet.inert = false;
  sheet.setAttribute('aria-hidden', 'false');
  sheet.classList.add('open');
  $('#sheet-backdrop').hidden = false;
  setTimeout(() => form.elements.name.focus({ preventScroll: true }), 50);
}
function closeEditor() {
  const sheet = $('#editor');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.inert = true;
  $('#sheet-backdrop').hidden = true;
}

$('#editor-form').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name || !(el.name in DEFAULT_PASSENGER)) return;
  let v = el.value;
  if (el.name !== 'boarding') v = v.toUpperCase();
  settings.passenger[el.name] = v.slice(0, 40);
  saveSettings();
  renderStatic();
});
$('#editor-form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeEditor();
});

/* ───────────────────────────── URL state ───────────────────────────── */

function updateUrl(changes) {
  try {
    const url = new URL(location.href);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null) url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    history.replaceState(null, '', url);
  } catch {
    /* ignore */
  }
}

/* ───────────────────────────── Events ───────────────────────────── */

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch($('#flight-input').value, $('#date-input').value);
});

$('#flight-input').addEventListener('input', () => showSearchError(''));

document.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-seg] button[data-value]');
  if (seg) {
    const key = seg.closest('[data-seg]').dataset.seg;
    if (key in CHOICES) setSetting(key, seg.dataset.value);
    else if (key === 'demo-speed') demoSetSpeed(Number(seg.dataset.value));
    else if (key === 'demo-scenario') demoSetScenario(seg.dataset.value);
    return;
  }

  const inst = e.target.closest('.instance[data-id]');
  if (inst && lastSearch) {
    const c = lastSearch.candidates.find((x) => x.id === inst.dataset.id);
    if (c) startLive(c, lastSearch);
    return;
  }

  const actionEl = e.target.closest('[data-action]');
  const menu = $('#display-menu');
  if (!menu.hidden && !e.target.closest('#display-menu') && !(actionEl && actionEl.dataset.action === 'display')) {
    closeDisplayMenu();
  }
  if (!actionEl) return;

  switch (actionEl.dataset.action) {
    case 'home':
    case 'new-search':
      searchToken++;
      stopSession();
      updateUrl({ flight: null, date: null, demo: null });
      showView('search');
      setTimeout(() => $('#flight-input').focus({ preventScroll: true }), 30);
      break;
    case 'demo':
      startDemo();
      break;
    case 'reel':
      setReel(true);
      break;
    case 'exit-reel':
      setReel(false);
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    case 'hide-bar':
      setBarHidden(true);
      break;
    case 'cycle-pos':
      cycleSetting('pos');
      toast(`Position: ${POS_LABELS[settings.pos]}`, 1200);
      break;
    case 'display':
      if (menu.hidden) openDisplayMenu();
      else closeDisplayMenu();
      break;
    case 'edit':
      openEditor();
      break;
    case 'close-editor':
      closeEditor();
      break;
    case 'reset-passenger':
      settings.passenger = { ...DEFAULT_PASSENGER };
      saveSettings();
      openEditor();
      renderStatic();
      break;
    case 'demo-toggle':
      demoTogglePause();
      break;
    case 'instances':
      if (session && session.search) {
        const search = session.search;
        stopSession(); // no background refreshes while choosing
        showInstancePicker(search, null);
      }
      break;
    default:
      break;
  }
});

$('#sheet-backdrop').addEventListener('click', closeEditor);

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest && e.target.closest('input, select, textarea, [contenteditable]');
  if (e.key === 'Escape') {
    if (!$('#display-menu').hidden) return closeDisplayMenu();
    if ($('#editor').classList.contains('open')) return closeEditor();
    if (body.classList.contains('reel')) return setReel(false);
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || body.dataset.view !== 'tracker') return;
  const k = e.key.toLowerCase();
  if (k === 'r') setReel(!body.classList.contains('reel'));
  else if (k === '1') setSetting('layout', 'full');
  else if (k === '2') setSetting('layout', 'compact');
  else if (k === '3') setSetting('layout', 'minimal');
  else if (k === 'b') cycleSetting('bg');
  else if (k === 'p') {
    cycleSetting('pos');
    if (body.classList.contains('reel')) toast(`Position: ${POS_LABELS[settings.pos]}`, 1200);
  } else if (k === 'f') toggleFullscreen();
  else if (k === 'h' && body.classList.contains('reel')) setBarHidden(settings.bar !== 'hidden');
  else if (k === 'e' && !body.classList.contains('reel')) openEditor();
  else if (k === ' ' && session && session.kind === 'demo') {
    e.preventDefault();
    demoTogglePause();
  } else return;
  if (body.classList.contains('reel')) showReelControls();
});

/* ───────────────────────────── Boot ───────────────────────────── */

async function boot() {
  $('#locating-plane').innerHTML = PLANE_SVG;

  const params = new URLSearchParams(location.search);
  for (const k of Object.keys(CHOICES)) {
    const v = params.get(k);
    if (v && CHOICES[k].includes(v)) settings[k] = v;
  }
  applySettings();

  try {
    config = await api('/api/config', { timeoutMs: 8000 });
  } catch {
    config = { liveAvailable: true, refreshSeconds: 60 };
  }
  $('#setup-note').hidden = config.liveAvailable !== false;
  if (config.keyEnv) $('#setup-key').textContent = config.keyEnv;
  if (config.providerLabel) $('#setup-service').textContent = config.providerLabel;

  const flight = params.get('flight');
  if (params.get('demo') === '1') {
    startDemo();
  } else if (flight) {
    $('#flight-input').value = normalizeFlightInput(flight);
    const date = params.get('date');
    if (date) $('#date-input').value = date;
    await runSearch(flight, date || '');
  } else {
    showView('search');
    $('#flight-input').focus({ preventScroll: true });
  }
  if (params.get('reel') === '1' && body.dataset.view === 'tracker') setReel(true);
}

boot();
