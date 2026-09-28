/**
 * Great-circle geometry on a spherical Earth (mean radius 6371.0088 km).
 * Accurate to ~0.3 % against the WGS-84 ellipsoid, which is far below
 * anything visible on a progress bar.
 */

export const EARTH_RADIUS_KM = 6371.0088;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function isCoord(p) {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** Central angle between two points, in radians (haversine). */
export function centralAngle(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const dφ = φ2 - φ1;
  const dλ = toRad(b.lng - a.lng);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(clamp(h, 0, 1)), Math.sqrt(clamp(1 - h, 0, 1)));
}

export function distanceKm(a, b) {
  return centralAngle(a, b) * EARTH_RADIUS_KM;
}

/** Initial great-circle bearing from a to b, degrees 0–360. */
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const dλ = toRad(b.lng - a.lng);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point at fraction f (0–1) along the great circle from a to b. */
export function intermediatePoint(a, b, f) {
  const δ = centralAngle(a, b);
  if (δ < 1e-12) return { lat: a.lat, lng: a.lng };
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lng);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lng);
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: ((toDeg(Math.atan2(y, x)) + 540) % 360) - 180,
  };
}

/**
 * How far along the origin→destination great circle an aircraft is (0–1).
 *
 * Primary method: project the aircraft onto the route great circle and take
 * the along-track distance (spherical right triangle, Napier's rule:
 * tan(δat) = tan(δ13)·cos(θ13 − θ12)). This is exact for an aircraft on or
 * near the route, and it ignores sideways offsets from airways.
 *
 * If the aircraft is far off the route (cross-track above 35 % of the route
 * length: a big detour, a hold or a diversion), projection becomes
 * meaningless, so the flown / (flown + remaining) distance ratio is used
 * instead.
 *
 * Returns { fraction, alongKm, remainingKm, crossTrackKm, routeKm, method } or null.
 */
export function routeProgress(origin, dest, pos) {
  if (!isCoord(origin) || !isCoord(dest) || !isCoord(pos)) return null;
  const δ12 = centralAngle(origin, dest);
  if (δ12 < 1e-6) return null;
  const δ13 = centralAngle(origin, pos);
  const δ23 = centralAngle(pos, dest);
  const routeKm = δ12 * EARTH_RADIUS_KM;

  const θ12 = toRad(bearingDeg(origin, dest));
  const θ13 = toRad(bearingDeg(origin, pos));
  const A = θ13 - θ12;
  const δxt = Math.asin(clamp(Math.sin(δ13) * Math.sin(A), -1, 1));
  const δat = Math.atan2(Math.sin(δ13) * Math.cos(A), Math.cos(δ13));

  let fraction;
  let method;
  if (Math.abs(δxt) <= 0.35 * δ12) {
    fraction = δat / δ12;
    method = 'projection';
  } else {
    fraction = δ13 / (δ13 + δ23);
    method = 'ratio';
  }
  fraction = clamp(fraction, 0, 1);
  return {
    fraction,
    alongKm: fraction * routeKm,
    remainingKm: δ23 * EARTH_RADIUS_KM,
    crossTrackKm: Math.abs(δxt) * EARTH_RADIUS_KM,
    routeKm,
    method,
  };
}
