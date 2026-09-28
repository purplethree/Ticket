/**
 * Demo Mode: a simulated EY416 Abu Dhabi → Phuket flight so the interface
 * can be tested without spending API requests. Everything here is clearly
 * fake and the UI always shows a DEMO badge while it is active.
 */

import { intermediatePoint, bearingDeg } from './geo.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DURATION = 6.5 * HOUR;
const CRUISE_ALT_M = 11278; // FL370
const CLIMB_MIN = 22;
const DESCENT_MIN = 28;

const AUH = {
  iata: 'AUH',
  icao: 'OMAA',
  name: 'Zayed International Airport',
  city: 'Abu Dhabi',
  country: 'AE',
  lat: 24.433,
  lng: 54.6511,
  timezone: 'Asia/Dubai',
  utcOffsetMin: 240,
};

const HKT = {
  iata: 'HKT',
  icao: 'VTSP',
  name: 'Phuket International Airport',
  city: 'Phuket',
  country: 'TH',
  lat: 8.1132,
  lng: 98.3169,
  timezone: 'Asia/Bangkok',
  utcOffsetMin: 420,
};

/** A clock that can run faster than real time and be paused. */
export class DemoClock {
  constructor() {
    this.anchorReal = Date.now();
    this.anchorSim = Date.now();
    this.speed = 1;
    this.paused = false;
  }
  now() {
    if (this.paused) return this.anchorSim;
    return this.anchorSim + (Date.now() - this.anchorReal) * this.speed;
  }
  setSpeed(speed) {
    this.anchorSim = this.now();
    this.anchorReal = Date.now();
    this.speed = speed;
  }
  pause() {
    this.anchorSim = this.now();
    this.paused = true;
  }
  resume() {
    this.anchorReal = Date.now();
    this.paused = false;
  }
  jumpTo(simMs) {
    this.anchorSim = simMs;
    this.anchorReal = Date.now();
  }
}

export const DEMO_SCENARIOS = {
  cruise: { label: 'In flight', departedAgo: DURATION - 2.5 * HOUR },
  landing: { label: 'Final 90 s', departedAgo: DURATION - 90e3 },
  departure: { label: 'Pre-departure', departedAgo: -20 * MIN },
};

export class DemoFlight {
  constructor(clock, scenario = 'cruise') {
    this.clock = clock;
    this.reset(scenario);
  }

  reset(scenario = 'cruise') {
    const s = DEMO_SCENARIOS[scenario] || DEMO_SCENARIOS.cruise;
    this.scenario = scenario in DEMO_SCENARIOS ? scenario : 'cruise';
    const now = this.clock.now();
    const dep = now - s.departedAgo;
    // Whole minutes, like a real timetable (except the exact 90-second finale).
    this.departure = this.scenario === 'landing' ? dep : Math.round(dep / MIN) * MIN;
    this.arrival = this.departure + DURATION;
  }

  snapshot() {
    const now = this.clock.now();
    const dep = this.departure;
    const arr = this.arrival;
    let status = 'scheduled';
    let position = null;

    if (now >= arr) {
      status = 'landed';
    } else if (now >= dep) {
      status = 'airborne';
      const f = (now - dep) / (arr - dep);
      const p = intermediatePoint(AUH, HKT, f);
      const elapsedMin = (now - dep) / MIN;
      const remainingMin = (arr - now) / MIN;
      let alt = CRUISE_ALT_M;
      let vs = 0;
      let speed = 835;
      if (elapsedMin < CLIMB_MIN) {
        const k = elapsedMin / CLIMB_MIN;
        alt = CRUISE_ALT_M * (1 - (1 - k) * (1 - k));
        vs = ((2 * (1 - k) * CRUISE_ALT_M) / CLIMB_MIN) * 0.06; // m/min → km/h
        speed = 330 + 505 * k;
      } else if (remainingMin < DESCENT_MIN) {
        const k = remainingMin / DESCENT_MIN;
        alt = CRUISE_ALT_M * k;
        vs = -(CRUISE_ALT_M / DESCENT_MIN) * 0.06;
        speed = 280 + 555 * k;
      }
      position = {
        lat: p.lat,
        lng: p.lng,
        altitudeM: Math.round(alt),
        speedKmh: Math.round(speed),
        verticalSpeedKmh: Math.round(vs * 10) / 10,
        heading: Math.round(bearingDeg(p, HKT)),
        updated: now - 4000,
      };
    }

    return {
      id: 'DEMO-EY416',
      provider: 'demo',
      demo: true,
      sources: ['demo'],
      fetchedAt: now,
      flight: {
        iata: 'EY416',
        icao: 'ETD416',
        number: '416',
        airlineIata: 'EY',
        airlineIcao: 'ETD',
        airlineName: 'Etihad Airways',
        codeshare: null,
      },
      status: { code: status, raw: status },
      departure: {
        ...AUH,
        terminal: 'A',
        gate: 'A6',
        baggage: null,
        scheduled: dep,
        estimated: dep,
        actual: now >= dep ? dep : null,
        delayMin: 0,
      },
      arrival: {
        ...HKT,
        terminal: null,
        gate: null,
        baggage: null,
        scheduled: arr,
        estimated: arr,
        actual: now >= arr ? arr : null,
        delayMin: 0,
      },
      aircraft: { icao: 'A21N', name: 'Airbus A321LR', registration: 'A6-LRD', hex: null },
      position,
      durationMin: DURATION / MIN,
    };
  }
}
