/** Formatting helpers. Every function returns a clean string, never NaN/undefined. */

export const DASH = '—';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const pad2 = (n) => String(Math.trunc(n)).padStart(2, '0');

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export function fmtInt(n) {
  return isNum(n) ? intFmt.format(Math.round(n)) : DASH;
}

/** Countdown "02:28:43"; beyond 99 h "4D 03:12:45". Rounds up so 0 is only shown at 0. */
export function formatCountdown(ms) {
  if (!isNum(ms)) return '--:--:--';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hTotal = Math.floor(total / 3600);
  if (hTotal > 99) {
    const d = Math.floor(hTotal / 24);
    return `${d}D ${pad2(hTotal % 24)}:${pad2(m)}:${pad2(s)}`;
  }
  return `${pad2(hTotal)}:${pad2(m)}:${pad2(s)}`;
}

/** "2h 28m", "45m", "< 1m". */
export function formatDuration(ms) {
  if (!isNum(ms)) return DASH;
  const mins = Math.max(0, Math.round(ms / 60e3));
  if (mins < 1) return '< 1m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "JUST NOW", "12 SEC AGO", "3 MIN AGO", "2 HR AGO". */
export function formatAgo(ms) {
  if (!isNum(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3) return 'JUST NOW';
  if (s < 60) return `${s} SEC AGO`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} MIN AGO`;
  const h = Math.floor(m / 60);
  return `${h} HR AGO`;
}

const dtfCache = new Map();
function zoneFormatter(timeZone) {
  if (!dtfCache.has(timeZone)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      });
    } catch {
      f = null;
    }
    dtfCache.set(timeZone, f);
  }
  return dtfCache.get(timeZone);
}

/**
 * Wall-clock fields of `ms` at an airport. Uses the airport's IANA time zone
 * when known, otherwise the UTC offset reported with the flight times,
 * otherwise the viewer's own time zone.
 */
export function wallClock(ms, airport) {
  if (!isNum(ms)) return null;
  const tz = airport && airport.timezone;
  const f = tz ? zoneFormatter(tz) : null;
  if (f) {
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
    const hour = Number(p.hour) % 24;
    return {
      year: Number(p.year),
      month: Number(p.month),
      day: Number(p.day),
      hour,
      minute: Number(p.minute),
      weekday: WEEKDAY_INDEX[p.weekday] ?? 0,
    };
  }
  if (airport && isNum(airport.utcOffsetMin)) {
    const d = new Date(ms + airport.utcOffsetMin * 60e3);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      weekday: d.getUTCDay(),
    };
  }
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay(),
  };
}

/** "14:18" in airport local time. */
export function airportTime(ms, airport) {
  const w = wallClock(ms, airport);
  return w ? `${pad2(w.hour)}:${pad2(w.minute)}` : DASH;
}

/** "28 SEP". */
export function airportDate(ms, airport) {
  const w = wallClock(ms, airport);
  return w ? `${w.day} ${MONTHS[w.month - 1]}` : DASH;
}

/** "SUN 28 SEP". */
export function airportDayDate(ms, airport) {
  const w = wallClock(ms, airport);
  return w ? `${WEEKDAYS[w.weekday]} ${w.day} ${MONTHS[w.month - 1]}` : DASH;
}

/** Signed delay "+15m" / "-5m", or '' when on time or unknown. */
export function delayLabel(minutes) {
  if (!isNum(minutes) || Math.abs(minutes) < 5) return '';
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(Math.round(minutes));
  return abs >= 60 ? `${sign}${Math.floor(abs / 60)}h ${pad2(abs % 60)}m` : `${sign}${abs}m`;
}

/** "Zayed International Airport" → "Zayed International". */
export function shortAirportName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s+(international\s+)?airport$/i, (m, intl) => (intl ? ' International' : ''))
    .replace(/\s+airport\b/i, '')
    .trim();
}

export function titleCase(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/(^|[\s\-/(])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compass point for a heading: 112 → "ESE". */
export function compassPoint(deg) {
  if (!isNum(deg)) return '';
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function formatCoord(lat, lng) {
  if (!isNum(lat) || !isNum(lng)) return DASH;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(lng).toFixed(2)}°${ew}`;
}
