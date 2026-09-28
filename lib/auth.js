'use strict';

const crypto = require('crypto');

/**
 * Optional password gate for a publicly hosted copy (SITE_PASSWORD).
 *
 * Uses the browser's built-in password prompt (HTTP Basic auth; any user
 * name, the password must match). Hosting platforms serve the site over
 * HTTPS, so the password is encrypted in transit. The browser remembers it
 * for the session, so the prompt appears once.
 *
 * Repeated wrong guesses from one address are slowed down with a lockout.
 */
function passwordGate(password, { maxFailures = 10, lockoutMs = 10 * 60e3, exempt = [] } = {}) {
  if (!password) return (req, res, next) => next();

  const expected = crypto.createHash('sha256').update(String(password)).digest();
  const failures = new Map();

  return (req, res, next) => {
    if (exempt.includes(req.path)) return next();

    const key = req.ip || 'unknown';
    const now = Date.now();
    const record = failures.get(key);
    if (record && record.count >= maxFailures && now - record.last < lockoutMs) {
      res.set('Retry-After', String(Math.ceil((lockoutMs - (now - record.last)) / 1000)));
      return res.status(429).type('text').send('Too many wrong passwords. Try again in a few minutes.');
    }

    const m = String(req.headers.authorization || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const given = decoded.slice(decoded.indexOf(':') + 1);
      // Hash both sides so the comparison is constant-time regardless of length.
      const givenHash = crypto.createHash('sha256').update(given).digest();
      if (crypto.timingSafeEqual(givenHash, expected)) {
        failures.delete(key);
        return next();
      }
      const r = failures.get(key) || { count: 0, last: 0 };
      failures.set(key, { count: now - r.last > lockoutMs ? 1 : r.count + 1, last: now });
      if (failures.size > 5000) failures.clear();
    }

    res.set('WWW-Authenticate', 'Basic realm="Until Landing", charset="UTF-8"');
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('text').send('Password required.');
  };
}

module.exports = { passwordGate };
