/**
 * Builds the three widget layouts (full boarding pass, compact overlay,
 * minimal bar) once, then updates them in place. Static text changes only
 * when new flight data arrives; moving parts (plane, countdown) update every
 * animation frame without touching the rest of the DOM.
 */

import {
  DASH,
  isNum,
  fmtInt,
  formatCountdown,
  airportTime,
  airportDate,
  delayLabel,
  shortAirportName,
  titleCase,
  formatDuration,
} from './format.js';

export const PLANE_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M46 24C46 22.6 44.6 21.6 42.4 21.6L30 21.6 19.6 4.4Q19.2 3.8 18.4 3.8L16.6 3.8Q15.8 3.8 15.9 4.6L20.2 21.6 11.4 21.6 7.2 13.8Q6.9 13.2 6.2 13.2L5.2 13.2Q4.6 13.2 4.7 13.9L6.4 21.8C5 22.1 4 22.9 4 24 4 25.1 5 25.9 6.4 26.2L4.7 34.1Q4.6 34.8 5.2 34.8L6.2 34.8Q6.9 34.8 7.2 34.2L11.4 26.4 20.2 26.4 15.9 43.4Q15.8 44.2 16.6 44.2L18.4 44.2Q19.2 44.2 19.6 43.6L30 26.4 42.4 26.4C44.6 26.4 46 25.4 46 24ZM22.2 12.1H27.2A1.4 1.4 0 0 1 27.2 14.9H22.2A1.4 1.4 0 0 1 22.2 12.1ZM22.2 33.1H27.2A1.4 1.4 0 0 1 27.2 35.9H22.2A1.4 1.4 0 0 1 22.2 33.1Z"/></svg>`;

const routeBarMarkup = (variant) => `
  <div class="routebar rb-${variant}" data-routebar>
    <div class="rb-track">
      <span class="rb-rest"></span>
      <span class="rb-done"></span>
      <span class="rb-node rb-dep"></span>
      <span class="rb-node rb-arr"><span class="rb-ripple"></span></span>
      <span class="rb-plane">${PLANE_SVG}</span>
    </div>
  </div>`;

const statusPill = () => `<span class="status-pill" data-f="statusPill"><i></i><span data-f="status">—</span></span>`;
const demoBadge = () => `<span class="demo-badge" data-demo-badge>DEMO</span>`;
const cell = (key, label, span = 1) =>
  `<div class="cell" data-cell="${key}" style="--span:${span}"><span class="cell-label">${label}</span><span class="cell-value" data-f="${key}"></span></div>`;

export function widgetsMarkup() {
  return `
  <article class="widget pass" data-widget="full" aria-label="Boarding pass">
    <div class="pass-top">
      <header class="pass-head">
        <div class="airline">
          <span class="airline-mark" data-f="airlineMark"></span>
          <span class="airline-name" data-f="airlineName"></span>
        </div>
        <div class="head-tags">${demoBadge()}<span class="doc-type">BOARDING PASS</span></div>
      </header>
      <div class="flight-row">
        <span class="flight-no" data-f="flightDisplay"></span>
        ${statusPill()}
      </div>

      <div class="route">
        <div class="ap ap-dep">
          <span class="ap-city" data-f="depCity"></span>
          <span class="ap-code" data-f="depCode"></span>
          <span class="ap-name" data-f="depName"></span>
        </div>
        <div class="route-mid"><span data-f="duration"></span></div>
        <div class="ap ap-arr">
          <span class="ap-city" data-f="arrCity"></span>
          <span class="ap-code" data-f="arrCode"></span>
          <span class="ap-name" data-f="arrName"></span>
        </div>
      </div>

      <div class="times">
        <div class="time-block">
          <span class="time" data-f="depTime"></span>
          <span class="time-label"><span data-f="depTimeLabel"></span><em class="delay" data-f="depDelay"></em></span>
        </div>
        <div class="time-block time-right">
          <span class="time" data-f="arrTime"></span>
          <span class="time-label"><em class="delay" data-f="arrDelay"></em><span data-f="arrTimeLabel"></span></span>
        </div>
      </div>

      <div class="progress-block">
        ${routeBarMarkup('full')}
        <div class="rb-meta">
          <span><b data-f="pct">0%</b> <span data-f="pctLabel">COMPLETE</span></span>
          <span data-f="kmToGo"></span>
        </div>
      </div>

      <div class="countdown">
        <div class="cd-time" data-f="countdown">--:--:--</div>
        <div class="cd-label" data-f="countdownLabel">TIME UNTIL LANDING</div>
        <div class="cd-meta">
          <span class="src-dot" data-f="srcDot"></span><span data-f="source"></span>
          <span class="cd-updated"><span class="sep">·</span><span data-f="updated"></span></span>
        </div>
      </div>
    </div>

    <div class="pass-bottom">
      <div class="grid">
        ${cell('passenger', 'PASSENGER', 3)}
        ${cell('seat', 'SEAT')}
        ${cell('flight', 'FLIGHT')}
        ${cell('date', 'DATE')}
        ${cell('gate', 'GATE')}
        ${cell('terminal', 'TERMINAL')}
        ${cell('boarding', 'BOARDING')}
        ${cell('group', 'GROUP')}
        ${cell('cabin', 'CLASS', 2)}
        ${cell('aircraft', 'AIRCRAFT', 2)}
        ${cell('registration', 'REGISTRATION')}
        ${cell('seq', 'SEQ')}
        ${cell('pnr', 'BOOKING REF', 2)}
        ${cell('arrTerminal', 'ARR TERMINAL')}
        ${cell('arrGate', 'ARR GATE')}
        ${cell('baggage', 'BAGGAGE')}
      </div>
      <div class="barcode" data-f="barcode" aria-hidden="true"></div>
      <div class="pass-foot">STUDY VISUAL • NOT VALID FOR TRAVEL</div>
    </div>
  </article>

  <article class="widget compact" data-widget="compact" aria-label="Compact flight tracker">
    <header class="c-head">
      <span class="c-flight" data-f="flightDisplay"></span>
      <span class="c-tags">${demoBadge()}${statusPill()}</span>
    </header>
    <div class="c-route">
      <div class="c-ap"><span class="c-code" data-f="depCode"></span><span class="c-city" data-f="depCityTitle"></span></div>
      <div class="c-ap c-right"><span class="c-code" data-f="arrCode"></span><span class="c-city" data-f="arrCityTitle"></span></div>
    </div>
    ${routeBarMarkup('compact')}
    <div class="c-meta"><span class="c-pct" data-f="pct">0%</span><span data-f="kmToGoShort"></span></div>
    <div class="c-bottom">
      <div>
        <div class="c-time" data-f="countdown">--:--:--</div>
        <div class="c-label" data-f="countdownLabelShort">UNTIL LANDING</div>
      </div>
      <div class="c-right">
        <div class="c-label" data-f="landingLabel">LANDING</div>
        <div class="c-land" data-f="landingTime"></div>
      </div>
    </div>
    <div class="c-foot">STUDY VISUAL • NOT VALID FOR TRAVEL</div>
  </article>

  <article class="widget minimal" data-widget="minimal" aria-label="Minimal flight tracker">
    <div class="m-top">
      <span class="m-flight"><span data-f="flightCode"></span>${demoBadge()}</span>
      <span class="m-left"><b data-f="countdown">--:--:--</b> <span data-f="leftLabel">LEFT</span></span>
    </div>
    <div class="m-route">
      <span class="m-code" data-f="depCode"></span>
      ${routeBarMarkup('minimal')}
      <span class="m-code" data-f="arrCode"></span>
    </div>
  </article>`;
}

/** One animated route bar: dots, completed line, remaining line and plane. */
class RouteBar {
  constructor(el) {
    this.el = el;
    this.track = el.querySelector('.rb-track');
    this.done = el.querySelector('.rb-done');
    this.plane = el.querySelector('.rb-plane');
    this.width = 0;
    this.last = -1;
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.measure());
      this.ro.observe(this.track);
    }
    this.measure();
  }
  measure() {
    this.width = this.track.clientWidth;
    this.last = -1;
  }
  set(p) {
    if (!this.width) this.width = this.track.clientWidth;
    const x = p * this.width;
    if (Math.abs(x - this.last) < 0.01) return;
    this.last = x;
    this.done.style.transform = `scaleX(${p.toFixed(5)})`;
    this.plane.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
  }
  destroy() {
    if (this.ro) this.ro.disconnect();
  }
}

export class Widgets {
  constructor(slot) {
    this.slot = slot;
    slot.innerHTML = widgetsMarkup();
    this.fields = new Map();
    slot.querySelectorAll('[data-f]').forEach((el) => {
      const k = el.dataset.f;
      if (!this.fields.has(k)) this.fields.set(k, []);
      this.fields.get(k).push(el);
    });
    this.cells = new Map();
    slot.querySelectorAll('[data-cell]').forEach((el) => this.cells.set(el.dataset.cell, el));
    this.bars = [...slot.querySelectorAll('[data-routebar]')].map((el) => new RouteBar(el));
    this.widgets = [...slot.querySelectorAll('[data-widget]')];
    this.cache = new Map();
    this.barcodeSeed = null;
  }

  destroy() {
    this.bars.forEach((b) => b.destroy());
    this.slot.innerHTML = '';
  }

  text(key, value) {
    const v = value == null || value === '' ? '' : String(value);
    if (this.cache.get(key) === v) return;
    this.cache.set(key, v);
    for (const el of this.fields.get(key) || []) el.textContent = v;
  }

  cellValue(key, value) {
    const el = this.cells.get(key);
    if (!el) return;
    const has = value != null && String(value).trim() !== '';
    el.hidden = !has;
    this.text(key, has ? String(value).trim() : '');
  }

  attr(key, name, value) {
    const ck = `${key}@${name}`;
    if (this.cache.get(ck) === value) return;
    this.cache.set(ck, value);
    for (const el of this.fields.get(key) || []) el.setAttribute(name, value);
  }

  setDemo(isDemo) {
    this.slot.querySelectorAll('[data-demo-badge]').forEach((el) => (el.hidden = !isDemo));
  }

  /** Text that only changes when new data (or passenger edits) arrive. */
  renderStatic(flight, passenger, tracker) {
    const f = flight.flight;
    const dep = flight.departure;
    const arr = flight.arrival;
    const code = f.iata || f.icao || '';
    const airlineCode = f.airlineIata || f.airlineIcao || code.replace(/\d.*$/, '');
    const number = f.number || code.replace(/^[A-Z0-9]{2}(?=\d)|^[A-Z]{3}(?=\d)/, '');

    this.text('airlineMark', airlineCode);
    this.text('airlineName', (f.airlineName || airlineCode).toUpperCase());
    this.text('flightDisplay', airlineCode && number ? `${airlineCode} ${number}` : code);
    this.text('flightCode', code);

    const depCity = dep.city || shortAirportName(dep.name) || '';
    const arrCity = arr.city || shortAirportName(arr.name) || '';
    this.text('depCity', depCity.toUpperCase());
    this.text('arrCity', arrCity.toUpperCase());
    this.text('depCityTitle', titleCase(depCity));
    this.text('arrCityTitle', titleCase(arrCity));
    this.text('depCode', dep.iata || dep.icao || DASH);
    this.text('arrCode', arr.iata || arr.icao || DASH);
    this.text('depName', shortAirportName(dep.name));
    this.text('arrName', shortAirportName(arr.name));

    // Duration between departure and arrival (actual > estimated > scheduled).
    const depT = dep.actual ?? dep.estimated ?? dep.scheduled;
    const arrT = arr.actual ?? arr.estimated ?? arr.scheduled;
    this.text('duration', isNum(depT) && isNum(arrT) && arrT > depT ? formatDuration(arrT - depT) : '');

    // Departure time + label
    if (isNum(dep.actual)) {
      this.text('depTime', airportTime(dep.actual, dep));
      this.text('depTimeLabel', 'DEPARTED');
    } else if (isNum(dep.estimated) && dep.estimated !== dep.scheduled) {
      this.text('depTime', airportTime(dep.estimated, dep));
      this.text('depTimeLabel', 'EST DEPARTURE');
    } else if (isNum(dep.scheduled) || isNum(dep.estimated)) {
      this.text('depTime', airportTime(dep.scheduled ?? dep.estimated, dep));
      this.text('depTimeLabel', 'DEPARTURE');
    } else {
      this.text('depTime', DASH);
      this.text('depTimeLabel', 'DEPARTURE');
    }
    this.text('depDelay', isNum(depT) && isNum(dep.scheduled) ? delayLabel((depT - dep.scheduled) / 60e3) : '');

    // Arrival time + label
    let arrLabel = 'ARRIVAL';
    if (isNum(arr.actual)) arrLabel = 'ARRIVED';
    else if (isNum(arr.estimated)) arrLabel = 'EST ARRIVAL';
    else if (isNum(arr.scheduled)) arrLabel = 'SCHED ARRIVAL';
    this.text('arrTime', isNum(arrT) ? airportTime(arrT, arr) : DASH);
    this.text('arrTimeLabel', arrLabel);
    this.text('arrDelay', isNum(arrT) && isNum(arr.scheduled) ? delayLabel((arrT - arr.scheduled) / 60e3) : '');

    // Compact "LANDING 14:18"
    this.text('landingTime', isNum(arrT) ? airportTime(arrT, arr) : DASH);

    // Ticket grid
    this.cellValue('passenger', passenger.name && passenger.name.toUpperCase());
    this.cellValue('seat', passenger.seat && passenger.seat.toUpperCase());
    this.cellValue('flight', code);
    this.cellValue('date', isNum(dep.scheduled ?? depT) ? airportDate(dep.scheduled ?? depT, dep) : null);
    this.cellValue('gate', dep.gate);
    this.cellValue('terminal', dep.terminal);
    this.cellValue('boarding', passenger.boarding);
    this.cellValue('group', passenger.group && passenger.group.toUpperCase());
    this.cellValue('cabin', passenger.cabin && passenger.cabin.toUpperCase());
    this.cellValue('aircraft', flight.aircraft.name || flight.aircraft.icao);
    this.cellValue('registration', flight.aircraft.registration);
    this.cellValue('seq', passenger.seq && passenger.seq.toUpperCase());
    this.cellValue('pnr', passenger.pnr && passenger.pnr.toUpperCase());
    this.cellValue('arrTerminal', arr.terminal);
    this.cellValue('arrGate', arr.gate);
    this.cellValue('baggage', arr.baggage);

    // Passenger name stays readable: long names shrink a little.
    const passengerEl = this.cells.get('passenger');
    if (passengerEl) passengerEl.classList.toggle('long', (passenger.name || '').length > 18);

    const seed = [code, dep.iata, dep.scheduled, passenger.name, passenger.seat, passenger.pnr].join('|');
    if (seed !== this.barcodeSeed) {
      this.barcodeSeed = seed;
      const host = (this.fields.get('barcode') || [])[0];
      if (host) host.innerHTML = decorativeBarcode(seed);
    }
    this.hasRoute = isNum(tracker.target && tracker.target.routeKm);
  }

  /** Per-frame values. */
  renderFrame(snap, ctx) {
    for (const b of this.bars) b.set(snap.progress);

    const pct = snap.mode === 'unknown' ? DASH : snap.timerLanded ? '100%' : `${Math.floor(snap.progress * 100 + 1e-9)}%`;
    this.text('pct', pct);
    this.text('pctLabel', snap.mode === 'unknown' ? 'PROGRESS UNAVAILABLE' : 'COMPLETE');
    const km = snap.timerLanded ? 0 : snap.remainingKm;
    this.text('kmToGo', isNum(km) && snap.mode !== 'cancelled' ? `${fmtInt(km)} KM TO GO` : '');
    this.text('kmToGoShort', isNum(km) && snap.mode !== 'cancelled' ? `${fmtInt(km)} km to go` : '');

    // Countdown
    let cd;
    let label;
    let shortLabel;
    let left;
    if (snap.cancelled) {
      cd = '--:--:--';
      label = 'FLIGHT CANCELLED';
      shortLabel = 'CANCELLED';
      left = '';
    } else if (snap.timerLanded) {
      cd = 'LANDED';
      label = snap.landedConfirmed ? ctx.arrivedText : 'AWAITING LANDING CONFIRMATION';
      shortLabel = snap.landedConfirmed ? ctx.arrivedShort : 'ARRIVAL TIME REACHED';
      left = '';
    } else if (isNum(snap.remainingMs)) {
      cd = formatCountdown(snap.remainingMs);
      label = snap.etaKind === 'scheduled' ? 'UNTIL SCHEDULED LANDING' : 'TIME UNTIL LANDING';
      shortLabel = 'UNTIL LANDING';
      left = 'LEFT';
    } else {
      cd = '--:--:--';
      label = 'ARRIVAL TIME UNAVAILABLE';
      shortLabel = 'ETA UNAVAILABLE';
      left = '';
    }
    this.text('countdown', cd);
    this.text('countdownLabel', label);
    this.text('countdownLabelShort', shortLabel);
    this.text('leftLabel', left);
    this.text('landingLabel', snap.landedConfirmed ? 'ARRIVED' : snap.etaKind === 'scheduled' ? 'SCHED LANDING' : 'LANDING');

    for (const w of this.widgets) {
      w.classList.toggle('is-landed', snap.timerLanded);
      w.classList.toggle('is-cancelled', snap.cancelled);
      w.classList.toggle('is-waiting', snap.mode === 'scheduled');
    }

    // Status pill
    this.text('status', snap.status.label);
    this.attr('statusPill', 'data-tone', snap.status.tone);

    // Data source + freshness
    this.text('source', ctx.sourceLabel);
    this.attr('srcDot', 'data-live', ctx.sourceLive ? 'true' : 'false');
    this.text('updated', ctx.updatedText);
  }
}

/**
 * Decorative 2-D barcode that looks like a boarding-pass PDF417 stack but
 * encodes nothing (random modules, no start/stop patterns, no error
 * correction). It cannot be scanned.
 */
function decorativeBarcode(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
  const cols = 160;
  const rows = 8;
  const rowH = 5;
  let rects = '';
  for (let r = 0; r < rows; r++) {
    let x = 0;
    while (x < cols) {
      const w = 1 + Math.floor(rand() * rand() * 4);
      const gap = 1 + Math.floor(rand() * rand() * 3);
      if (x + w > cols) break;
      rects += `<rect x="${x}" y="${r * rowH}" width="${w}" height="${rowH - 0.5}"/>`;
      x += w + gap;
    }
  }
  return `<svg viewBox="0 0 ${cols} ${rows * rowH}" preserveAspectRatio="none" role="presentation">${rects}</svg>`;
}
