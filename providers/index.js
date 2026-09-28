'use strict';

/**
 * Flight-data provider registry.
 *
 * A provider is any object with:
 *
 *   name: string
 *   isConfigured(): boolean
 *   findInstances(flightCode): Promise<Instance[]>
 *       Every instance of the flight number the provider can see (yesterday's,
 *       today's, tomorrow's...). Throws FlightDataError('NOT_FOUND') if none.
 *   refreshInstance(flightCode, ref): Promise<Instance|null>
 *       Fresh data for one instance. ref = { dep, arr, sched }.
 *
 * flightCode comes from lib/flight-code.js: { type: 'iata'|'icao', code, airline, number, display }.
 *
 * Instance (all times are epoch milliseconds, UTC; unknown values are null):
 * {
 *   id, provider, sources: string[], fetchedAt,
 *   flight:   { iata, icao, number, airlineIata, airlineIcao, airlineName, codeshare },
 *   status:   { code: 'scheduled'|'airborne'|'landed'|'cancelled'|'diverted'|'incident'|'unknown', raw },
 *   departure / arrival: {
 *     iata, icao, name, city, country, lat, lng, timezone, utcOffsetMin,
 *     terminal, gate, baggage, scheduled, estimated, actual, delayMin
 *   },
 *   aircraft: { icao, name, registration, hex },
 *   position: null | { lat, lng, altitudeM, speedKmh, verticalSpeedKmh, heading, updated },
 *   durationMin
 * }
 *
 * To add FlightAware AeroAPI (or anything else): create providers/aeroapi.js
 * that returns this shape, register it below, and set FLIGHT_PROVIDER=aeroapi.
 * The server, instance selection and the whole frontend stay unchanged.
 */

const path = require('path');
const { AirLabsProvider } = require('./airlabs');

const PROVIDERS = {
  airlabs: (env) =>
    new AirLabsProvider({
      apiKey: env.AIRLABS_API_KEY,
      baseUrl: env.AIRLABS_BASE_URL,
      cacheFile: path.join(__dirname, '..', '.cache', 'airlabs-reference.json'),
    }),
};

function createProvider(env = process.env) {
  const name = String(env.FLIGHT_PROVIDER || 'airlabs').trim().toLowerCase();
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(`Unknown FLIGHT_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return factory(env);
}

module.exports = { createProvider, PROVIDERS };
