'use strict';

/**
 * Flight-data provider registry.
 *
 * A provider is any object with:
 *
 *   name: string            e.g. 'aerodatabox'
 *   label: string           shown to people, e.g. 'AeroDataBox'
 *   keyEnv: string          the .env / Render setting holding its key
 *   isConfigured(): boolean
 *   findInstances(flightCode, { date }): Promise<Instance[]>
 *       Every instance of the flight number the provider can see (yesterday's,
 *       today's, tomorrow's...), or those departing on `date` (YYYY-MM-DD,
 *       departure local time) when given. Throws FlightDataError('NOT_FOUND') if none.
 *   refreshInstance(flightCode, ref): Promise<Instance|null>
 *       Fresh data for one instance. ref = { dep, arr, sched, date }.
 *
 * flightCode comes from lib/flight-code.js: { type: 'iata'|'icao', code, airline, number, display }.
 *
 * Instance (all times are epoch milliseconds, UTC; unknown values are null):
 * {
 *   id, provider, sources: string[], fetchedAt,
 *   flight:   { iata, icao, number, airlineIata, airlineIcao, airlineName, codeshare },
 *   status:   { code: 'scheduled'|'airborne'|'landed'|'cancelled'|'diverted'|'incident'|'unknown', raw,
 *               detail?: 'check-in'|'boarding'|'gate-closed'|'delayed'|'departed'|'approaching' },
 *   departure / arrival: {
 *     iata, icao, name, city, country, lat, lng, timezone, utcOffsetMin,
 *     terminal, gate, baggage, scheduled, estimated, actual, delayMin
 *   },
 *   aircraft: { icao, name, registration, hex },
 *   position: null | { lat, lng, altitudeM, speedKmh, verticalSpeedKmh, heading, updated },
 *   durationMin
 * }
 *
 * Included: aerodatabox (default) and airlabs. To add FlightAware AeroAPI (or
 * anything else): create providers/aeroapi.js that returns this shape,
 * register it below, and set FLIGHT_PROVIDER=aeroapi. The server, instance
 * selection and the whole frontend stay unchanged.
 */

const path = require('path');
const { AirLabsProvider } = require('./airlabs');
const { AeroDataBoxProvider } = require('./aerodatabox');

const PROVIDERS = {
  aerodatabox: (env) =>
    new AeroDataBoxProvider({
      apiKey: env.AERODATABOX_API_KEY,
      baseUrl: env.AERODATABOX_BASE_URL,
    }),
  airlabs: (env) =>
    new AirLabsProvider({
      apiKey: env.AIRLABS_API_KEY,
      baseUrl: env.AIRLABS_BASE_URL,
      cacheFile: path.join(__dirname, '..', '.cache', 'airlabs-reference.json'),
    }),
};

/**
 * FLIGHT_PROVIDER picks the provider. Without it, whichever key is present
 * decides (AeroDataBox first), and AeroDataBox is the default.
 */
function providerName(env) {
  const explicit = String(env.FLIGHT_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (String(env.AERODATABOX_API_KEY || '').trim()) return 'aerodatabox';
  if (String(env.AIRLABS_API_KEY || '').trim()) return 'airlabs';
  return 'aerodatabox';
}

function createProvider(env = process.env) {
  const name = providerName(env);
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(`Unknown FLIGHT_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return factory(env);
}

module.exports = { createProvider, PROVIDERS };
