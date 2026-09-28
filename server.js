'use strict';

/**
 * Flight Study Tracker: tiny backend.
 *
 * Serves the static frontend from /public and proxies flight-data requests so
 * the API key stays on the server. The browser only ever talks to /api/*
 * on this server; it never sees the key.
 *
 * Runs the same way on your computer and on a host such as Render. When
 * SITE_PASSWORD is set, every page and API route asks for that password.
 */

require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const { createProvider } = require('./providers');
const { parseFlightCode, parseDateParam } = require('./lib/flight-code');
const { selectInstance } = require('./lib/select');
const { FlightDataError, toClientError } = require('./lib/errors');
const { passwordGate } = require('./lib/auth');

// Render sets RENDER=true. Behind its proxy the visitor's IP is in
// X-Forwarded-For, and the server must listen on all interfaces.
const ON_RENDER = !!process.env.RENDER;

const REFRESH_SECONDS = clampInt(process.env.REFRESH_INTERVAL_SECONDS, 60, 30, 600);

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Per-IP sliding-window limiter so a stuck tab can't drain the API quota. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'local';
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      const { status, body } = toClientError(new FlightDataError('TOO_MANY_LOCAL'));
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(status).json(body);
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 1000) hits.clear();
    next();
  };
}

function sendError(res, err, overrideMessage, meta) {
  if (!(err instanceof FlightDataError)) console.error('[server] unexpected error:', err);
  else if (!['NOT_FOUND', 'INVALID_FLIGHT', 'INVALID_DATE', 'NO_API_KEY'].includes(err.code)) {
    console.warn(`[server] ${err.code}: ${err.message}`);
  }
  const { status, body } = toClientError(err, overrideMessage, meta);
  if (body.error.retryAfterSeconds) res.set('Retry-After', String(body.error.retryAfterSeconds));
  res.status(status).json(body);
}

function createApp({
  provider,
  sitePassword = process.env.SITE_PASSWORD,
  trustProxy = ON_RENDER || process.env.TRUST_PROXY === '1',
} = {}) {
  const app = express();
  const flightProvider = provider || createProvider(process.env);
  const meta = { label: flightProvider.label, keyEnv: flightProvider.keyEnv };
  const fail = (res, err, overrideMessage) => sendError(res, err, overrideMessage, meta);

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });

  // Health check for hosting platforms (no data, no password needed).
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use(passwordGate(sitePassword, { exempt: ['/healthz'] }));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/config', (req, res) => {
    res.json({
      provider: flightProvider.name,
      providerLabel: flightProvider.label,
      keyEnv: flightProvider.keyEnv,
      liveAvailable: flightProvider.isConfigured(),
      refreshSeconds: REFRESH_SECONDS,
    });
  });

  const limited = rateLimiter({ windowMs: 60e3, max: 40 });

  // Search: find every instance of a flight number and pick the right one.
  api.get('/search', limited, async (req, res) => {
    const code = parseFlightCode(req.query.flight);
    if (!code) return fail(res, new FlightDataError('INVALID_FLIGHT'));
    const date = parseDateParam(req.query.date);
    if (date === undefined) return fail(res, new FlightDataError('INVALID_DATE'));

    try {
      const instances = await flightProvider.findInstances(code, { date });
      const selection = selectInstance(instances, { date, now: Date.now(), display: code.code });
      res.json({
        query: { flight: code.code, type: code.type, display: code.display, date },
        serverTime: Date.now(),
        ...selection,
      });
    } catch (err) {
      const notFound = err instanceof FlightDataError && err.code === 'NOT_FOUND';
      fail(
        res,
        err,
        notFound
          ? date
            ? `Couldn't find ${code.code} departing on ${date}. Check the flight number and date, or leave the date empty.`
            : `Couldn't find a flight ${code.code}. Check the flight number and try again.`
          : undefined,
      );
    }
  });

  // Refresh one already-chosen instance.
  api.get('/flight', limited, async (req, res) => {
    const code = parseFlightCode(req.query.flight);
    if (!code) return fail(res, new FlightDataError('INVALID_FLIGHT'));
    const dep = /^[A-Z0-9]{3}$/.test(String(req.query.dep || '')) ? String(req.query.dep) : null;
    const arr = /^[A-Z0-9]{3}$/.test(String(req.query.arr || '')) ? String(req.query.arr) : null;
    const schedNum = Number(req.query.sched);
    const sched = req.query.sched && Number.isFinite(schedNum) && schedNum > 0 ? schedNum : null;
    const date = parseDateParam(req.query.date) || null;

    try {
      const instance = await flightProvider.refreshInstance(code, { dep, arr, sched, date });
      res.json({ serverTime: Date.now(), instance });
    } catch (err) {
      fail(res, err);
    }
  });

  api.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route.' } }));
  app.use('/api', api);

  app.use(
    express.static(path.join(__dirname, 'public'), {
      extensions: ['html'],
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    }),
  );

  return app;
}

if (require.main === module) {
  const port = clampInt(process.env.PORT, 3000, 1, 65535);
  const host = (process.env.HOST || (ON_RENDER ? '0.0.0.0' : '127.0.0.1')).trim();
  const provider = createProvider(process.env);
  const app = createApp({ provider });
  const server = app.listen(port, host, () => {
    const shownHost = host === '0.0.0.0' ? 'localhost' : host === '127.0.0.1' ? 'localhost' : host;
    console.log('');
    console.log('  ✈  Flight Study Tracker');
    console.log(`     Open  ${process.env.RENDER_EXTERNAL_URL || `http://${shownHost}:${port}`}`);
    console.log(
      provider.isConfigured()
        ? `     Live data: ${provider.label} (key loaded, refresh every ${REFRESH_SECONDS}s)`
        : `     Live data: OFF. Add ${provider.keyEnv} to .env (or Render → Environment) and restart. Demo Mode still works.`,
    );
    console.log(`     Password: ${process.env.SITE_PASSWORD ? 'on (SITE_PASSWORD)' : 'off'}`);
    if (host === '0.0.0.0' && !ON_RENDER) console.log('     Listening on your local network too (HOST=0.0.0.0).');
    console.log('');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${port} is already in use. Close the other program or set PORT=3001 in .env.\n`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { createApp };
