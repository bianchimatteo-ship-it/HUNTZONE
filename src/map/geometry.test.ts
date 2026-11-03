import { describe, expect, it } from 'vitest';
import { createAccuracyGeometry, createPlayAreaGeometry, isValidPlayRadius } from './geometry';

function positions(geometry: ReturnType<typeof createPlayAreaGeometry>['geometry']): number[][][] {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  return geometry.coordinates.flat(1);
}

describe('geodesic play area', () => {
  it('accepts every integer radius from 100 through 3000 metres, including intermediate values', () => {
    expect(isValidPlayRadius(100)).toBe(true);
    expect(isValidPlayRadius(1377)).toBe(true);
    expect(isValidPlayRadius(3000)).toBe(true);
    expect(isValidPlayRadius(99)).toBe(false);
    expect(isValidPlayRadius(3001)).toBe(false);
    expect(isValidPlayRadius(1377.5)).toBe(false);
  });

  it('uses spherical distance geometry and preserves the selected centre and radius', () => {
    const area = createPlayAreaGeometry({ latitude: 45.4642, longitude: 9.19 }, 840);
    expect(area.geometry.type).toBe('Polygon');
    expect(area.properties).toMatchObject({ center: [9.19, 45.4642], radiusMeters: 840, kind: 'play-area' });
    const ring = area.geometry.type === 'Polygon' ? area.geometry.coordinates[0] : area.geometry.coordinates[0][0];
    expect(ring).toHaveLength(97);
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring.some(([longitude, latitude]) => longitude !== 9.19 || latitude !== 45.4642)).toBe(true);
  });

  it.each([
    [{ latitude: 91, longitude: 0 }, 100],
    [{ latitude: 0, longitude: -181 }, 100],
    [{ latitude: 0, longitude: 0 }, 99],
    [{ latitude: 0, longitude: 0 }, 3001],
    [{ latitude: 0, longitude: 0 }, 100.5],
  ])('rejects invalid centre/radius inputs', (center, radius) => {
    expect(() => createPlayAreaGeometry(center, radius)).toThrow(RangeError);
  });

  it('splits play-area geometry at the antimeridian with valid longitude coordinates', () => {
    const area = createPlayAreaGeometry({ latitude: 10, longitude: 179.99 }, 3000);
    expect(area.geometry.type).toBe('MultiPolygon');
    const rings = positions(area.geometry);
    expect(rings.length).toBe(2);
    for (const ring of rings) {
      expect(ring[0]).toEqual(ring.at(-1));
      for (const [longitude, latitude] of ring) {
        expect(longitude).toBeGreaterThanOrEqual(-180);
        expect(longitude).toBeLessThanOrEqual(180);
        expect(latitude).toBeGreaterThanOrEqual(-90);
        expect(latitude).toBeLessThanOrEqual(90);
      }
    }
  });

  it('keeps GPS accuracy circles geodesic and separate from the 100m play-radius minimum', () => {
    const accuracy = createAccuracyGeometry({ latitude: 45, longitude: 9 }, 17.5);
    expect(accuracy.geometry.type).toBe('Polygon');
    expect(accuracy.properties).toMatchObject({ radiusMeters: 17.5, kind: 'accuracy' });
    expect(() => createAccuracyGeometry({ latitude: 91, longitude: 0 }, 10)).toThrow(RangeError);
  });

  it('recomputes coordinates when either centre or radius changes', () => {
    const first = createPlayAreaGeometry({ latitude: 45, longitude: 9 }, 500);
    const moved = createPlayAreaGeometry({ latitude: 46, longitude: 10 }, 500);
    const resized = createPlayAreaGeometry({ latitude: 45, longitude: 9 }, 1500);
    expect(JSON.stringify(moved.geometry)).not.toBe(JSON.stringify(first.geometry));
    expect(JSON.stringify(resized.geometry)).not.toBe(JSON.stringify(first.geometry));
  });
});
