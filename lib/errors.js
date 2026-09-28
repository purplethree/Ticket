'use strict';

/**
 * Provider-agnostic error. Providers translate their own failure modes into
 * one of these codes so the server can answer with a clean, human-readable
 * message and never forward raw upstream errors to the browser.
 */
class FlightDataError extends Error {
  constructor(code, detail, extra = {}) {
    super(detail || code);
    this.name = 'FlightDataError';
    this.code = code;
    this.retryAfterSeconds = extra.retryAfterSeconds || null;
  }
}

const CODES = {
  NO_API_KEY: {
    status: 503,
    message:
      "Live tracking isn't set up yet. Add your AirLabs API key to the .env file and restart the server, or try Demo Mode.",
  },
  INVALID_API_KEY: {
    status: 502,
    message: 'The flight-data service rejected the API key. Check AIRLABS_API_KEY in your .env file, then restart the server.',
  },
  RATE_LIMIT: {
    status: 429,
    message: 'The flight-data service is getting too many requests right now. Wait a minute and try again.',
  },
  QUOTA_EXCEEDED: {
    status: 429,
    message: "Your AirLabs plan's request allowance has run out. Try again when it resets, or upgrade the plan.",
  },
  NOT_FOUND: {
    status: 404,
    message: "Couldn't find that flight. Check the flight number and try again.",
  },
  INVALID_FLIGHT: {
    status: 400,
    message: "That doesn't look like a flight number. Try something like EY416.",
  },
  INVALID_DATE: {
    status: 400,
    message: 'That date looks wrong. Use the date picker or leave it empty.',
  },
  TIMEOUT: {
    status: 504,
    message: 'The flight-data service took too long to answer. Try again in a moment.',
  },
  NETWORK: {
    status: 502,
    message: "Couldn't reach the flight-data service. Check your internet connection and try again.",
  },
  UPSTREAM: {
    status: 502,
    message: 'The flight-data service sent an unexpected answer. Try again in a moment.',
  },
  TOO_MANY_LOCAL: {
    status: 429,
    message: 'Too many searches in a short time. Wait a few seconds and try again.',
  },
};

function toClientError(err, overrideMessage) {
  const code = err instanceof FlightDataError && CODES[err.code] ? err.code : 'UPSTREAM';
  const def = CODES[code];
  return {
    status: def.status,
    body: {
      error: {
        code,
        message: overrideMessage || def.message,
        retryAfterSeconds: (err && err.retryAfterSeconds) || null,
      },
    },
  };
}

module.exports = { FlightDataError, toClientError, ERROR_CODES: CODES };
