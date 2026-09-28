'use strict';

/**
 * Parses what a person types into the search box ("EY416", "ey 416",
 * "EY0416", "ETD416") into a normalized flight designator.
 *
 * IATA designators are 2 characters (letters or digits, never two digits),
 * ICAO designators are 3 letters. The numeric part is 1–4 digits with an
 * optional operational suffix letter.
 */
function parseFlightCode(input) {
  const raw = String(input == null ? '' : input)
    .toUpperCase()
    .replace(/[\s\-_.\/]/g, '');

  if (!raw || raw.length > 10) return null;

  let m = raw.match(/^([A-Z]{3})(\d{1,4})([A-Z]?)$/);
  if (m) {
    const number = stripZeros(m[2]) + m[3];
    return {
      type: 'icao',
      airline: m[1],
      number,
      code: m[1] + number,
      display: `${m[1]} ${number}`,
    };
  }

  m = raw.match(/^([A-Z0-9]{2})(\d{1,4})([A-Z]?)$/);
  if (m && !/^\d{2}$/.test(m[1])) {
    const number = stripZeros(m[2]) + m[3];
    return {
      type: 'iata',
      airline: m[1],
      number,
      code: m[1] + number,
      display: `${m[1]} ${number}`,
    };
  }

  return null;
}

function stripZeros(digits) {
  const s = digits.replace(/^0+/, '');
  return s === '' ? '0' : s;
}

/** Validates an optional YYYY-MM-DD date string. */
function parseDateParam(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    return undefined;
  }
  return s;
}

module.exports = { parseFlightCode, parseDateParam };
