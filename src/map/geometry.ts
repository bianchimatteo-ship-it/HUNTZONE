import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import type { GeoCoordinate } from '../location/geolocation';

export type PlayAreaGeometry = Feature<Polygon | MultiPolygon>;

export function isValidPlayRadius(radiusMeters: number): boolean {
  return Number.isInteger(radiusMeters) && radiusMeters >= 100 && radiusMeters <= 3000;
}

export function isValidCoordinate(point: GeoCoordinate): boolean {
  return Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
    && Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180;
}

function destination(center: GeoCoordinate, distanceMeters: number, bearingDegrees: number): [number, number] {
  const earthRadius = 6_371_008.8;
  const angularDistance = distanceMeters / earthRadius;
  const bearing = bearingDegrees * Math.PI / 180;
  const latitude = center.latitude * Math.PI / 180;
  const longitude = center.longitude * Math.PI / 180;
  const destinationLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance)
    + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const destinationLongitude = longitude + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
    Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(destinationLatitude),
  );
  return [destinationLongitude * 180 / Math.PI, destinationLatitude * 180 / Math.PI];
}

function clipVertical(ring: Position[], boundary: number, keepGreater: boolean): Position[] {
  const inside = (point: Position) => keepGreater ? point[0] >= boundary : point[0] <= boundary;
  const output: Position[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const previous = ring[(index + ring.length - 1) % ring.length];
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const fraction = (boundary - previous[0]) / (current[0] - previous[0]);
      output.push([boundary, previous[1] + (current[1] - previous[1]) * fraction]);
    }
    if (currentInside) output.push(current);
  }
  return output;
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length < 3) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring.length >= 4 ? ring : [];
}

function createGeodesicCircle(center: GeoCoordinate, radiusMeters: number, steps: number, kind: 'play-area' | 'accuracy'): PlayAreaGeometry {
  const unwrapped: Position[] = [];
  let previousLongitude = center.longitude;
  for (let index = 0; index < steps; index += 1) {
    const [rawLongitude, latitude] = destination(center, radiusMeters, index * 360 / steps);
    let longitude = rawLongitude;
    while (longitude - previousLongitude > 180) longitude -= 360;
    while (longitude - previousLongitude < -180) longitude += 360;
    unwrapped.push([longitude, latitude]);
    previousLongitude = longitude;
  }
  const firstLongitude = unwrapped[0][0];
  let closingLongitude = firstLongitude;
  while (closingLongitude - previousLongitude > 180) closingLongitude -= 360;
  while (closingLongitude - previousLongitude < -180) closingLongitude += 360;
  unwrapped.push([closingLongitude, unwrapped[0][1]]);

  const minLongitude = Math.min(...unwrapped.map(point => point[0]));
  const maxLongitude = Math.max(...unwrapped.map(point => point[0]));
  const firstStrip = Math.floor((minLongitude + 180) / 360);
  const lastStrip = Math.floor((maxLongitude + 180) / 360);
  const polygons: Position[][][] = [];

  for (let strip = firstStrip; strip <= lastStrip; strip += 1) {
    const west = -180 + strip * 360;
    const east = 180 + strip * 360;
    let clipped = clipVertical(unwrapped.slice(0, -1), west, true);
    clipped = clipVertical(clipped, east, false);
    clipped = closeRing(clipped.map(([longitude, latitude]) => [longitude - strip * 360, latitude]));
    if (clipped.length) polygons.push([clipped]);
  }

  if (!polygons.length) throw new RangeError('Could not construct a valid play-area polygon.');
  const properties = { center: [center.longitude, center.latitude], radiusMeters, kind };
  if (polygons.length === 1) return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: polygons[0] } };
  return { type: 'Feature', properties, geometry: { type: 'MultiPolygon', coordinates: polygons } };
}

/** Creates a geodesic play-area circle and splits it at the antimeridian for valid GeoJSON. */
export function createPlayAreaGeometry(center: GeoCoordinate, radiusMeters: number, steps = 96): PlayAreaGeometry {
  if (!isValidCoordinate(center)) throw new RangeError('Center coordinates are invalid.');
  if (!isValidPlayRadius(radiusMeters)) throw new RangeError('Play radius must be an integer from 100 to 3000 metres.');
  if (!Number.isInteger(steps) || steps < 16 || steps > 512) throw new RangeError('Circle steps must be an integer from 16 to 512.');
  return createGeodesicCircle(center, radiusMeters, steps, 'play-area');
}

export function createAccuracyGeometry(center: GeoCoordinate, accuracyMeters: number, steps = 64): PlayAreaGeometry {
  if (!isValidCoordinate(center)) throw new RangeError('Center coordinates are invalid.');
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0 || accuracyMeters > 100_000) throw new RangeError('GPS accuracy is invalid.');
  if (!Number.isInteger(steps) || steps < 16 || steps > 512) throw new RangeError('Circle steps must be an integer from 16 to 512.');

  return createGeodesicCircle(center, accuracyMeters, steps, 'accuracy');
}
