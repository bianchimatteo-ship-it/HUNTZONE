import { useEffect, useRef, useState } from 'react';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { type GeoJSONSource, type Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import type { GeoCoordinate, LocationSample } from '../location/geolocation';
import { createAccuracyGeometry, createPlayAreaGeometry } from './geometry';
import { createStadiaMap, STADIA_STYLE_URL } from './stadiaMapProvider';

type FocusCommand = { point: GeoCoordinate; token: number };
type MarkerProperties = { kind: 'device' | 'center' };

const emptyMarkers: FeatureCollection<Point, MarkerProperties> = { type: 'FeatureCollection', features: [] };
const emptyGeometry: FeatureCollection = { type: 'FeatureCollection', features: [] };

function marker(point: GeoCoordinate, kind: MarkerProperties['kind']): Feature<Point, MarkerProperties> {
  return {
    type: 'Feature',
    properties: { kind },
    geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
  };
}

export default function StadiaMap({
  center,
  radiusMeters,
  deviceSample,
  focusCommand,
  onChooseCenter,
}: {
  center: GeoCoordinate | null;
  radiusMeters: number;
  deviceSample: LocationSample | null;
  focusCommand: FocusCommand | null;
  onChooseCenter: (coordinate: GeoCoordinate) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const chooseRef = useRef(onChooseCenter);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => { chooseRef.current = onChooseCenter; }, [onChooseCenter]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setLoaded(false);
    setError(false);
    let alive = true;
    let map: MapLibreMap;
    try {
      map = createStadiaMap(container);
    } catch {
      setError(true);
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    map.on('load', () => {
      if (!alive) return;
      try {
        map.addSource('play-area', { type: 'geojson', data: emptyGeometry });
        map.addSource('gps-accuracy', { type: 'geojson', data: emptyGeometry });
        map.addSource('map-markers', { type: 'geojson', data: emptyMarkers });
        map.addLayer({ id: 'play-area-fill', type: 'fill', source: 'play-area', paint: { 'fill-color': '#e3c46e', 'fill-opacity': 0.13 } });
        map.addLayer({ id: 'play-area-line', type: 'line', source: 'play-area', paint: { 'line-color': '#e3c46e', 'line-width': 2, 'line-dasharray': [3, 2] } });
        map.addLayer({ id: 'gps-accuracy-fill', type: 'fill', source: 'gps-accuracy', paint: { 'fill-color': '#86bd91', 'fill-opacity': 0.16 } });
        map.addLayer({ id: 'gps-accuracy-line', type: 'line', source: 'gps-accuracy', paint: { 'line-color': '#9bcda3', 'line-width': 2 } });
        map.addLayer({
          id: 'map-markers', type: 'circle', source: 'map-markers',
          paint: {
            'circle-radius': ['match', ['get', 'kind'], 'device', 9, 8],
            'circle-color': ['match', ['get', 'kind'], 'device', '#8bc99a', '#e3c46e'],
            'circle-stroke-color': '#11140f', 'circle-stroke-width': 3,
          },
        });
        map.addLayer({
          id: 'map-marker-labels', type: 'symbol', source: 'map-markers',
          layout: { 'text-field': ['match', ['get', 'kind'], 'device', 'TU', 'CENTRO'], 'text-size': 12, 'text-offset': [0, 1.7], 'text-anchor': 'top' },
          paint: { 'text-color': '#f1f2ec', 'text-halo-color': '#151814', 'text-halo-width': 1.5 },
        });
        setLoaded(true);
      } catch {
        setError(true);
      }
    });
    map.on('error', () => {
      if (alive) setError(true);
    });
    map.on('click', event => chooseRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }));

    const resize = () => map.resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(container);
    window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    return () => {
      alive = false;
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      map.remove();
      mapRef.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || error) return;
    try {
      const area = map.getSource('play-area') as GeoJSONSource | undefined;
      const accuracy = map.getSource('gps-accuracy') as GeoJSONSource | undefined;
      const markers = map.getSource('map-markers') as GeoJSONSource | undefined;
      if (!area || !accuracy || !markers) return;
      area.setData(center ? createPlayAreaGeometry(center, radiusMeters) : emptyGeometry);
      accuracy.setData(deviceSample
        ? createAccuracyGeometry(deviceSample, deviceSample.accuracyMeters)
        : emptyGeometry);
      markers.setData({
        type: 'FeatureCollection',
        features: [
          ...(deviceSample ? [marker(deviceSample, 'device')] : []),
          ...(center ? [marker(center, 'center')] : []),
        ],
      });
    } catch {
      setError(true);
    }
  }, [center, deviceSample, error, loaded, radiusMeters]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focusCommand) return;
    map.flyTo({ center: [focusCommand.point.longitude, focusCommand.point.latitude], zoom: 16, duration: 650 });
  }, [focusCommand, loaded]);

  return <div className="stadia-map-shell">
    <div className="stadia-map-stage" role="region" aria-label="Mappa interattiva: trascina per spostarti, usa i controlli per lo zoom, tocca per scegliere il centro del campo">
      <div className={`stadia-map-canvas ${error ? 'stadia-map-canvas--hidden' : ''}`} ref={containerRef} />
      {error && <div className="map-provider-error" role="alert"><span aria-hidden="true">⌖</span><h3>Mappa non disponibile</h3><p>Non è stato possibile caricare la mappa Stadia Maps. Controlla la connessione e l’autorizzazione del dominio, poi riprova.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>RIPROVA A CARICARE</button></div>}
      {!loaded && !error && <div className="map-loading" role="status">Caricamento mappa…</div>}
      {loaded && !error && !center && <div className="map-center-hint" aria-live="polite">Tocca la mappa per scegliere il centro</div>}
    </div>
    <div className="map-attribution" aria-label="Attribuzione cartografica">
      © <a href="https://stadiamaps.com/attribution/" target="_blank" rel="noreferrer">Stadia Maps</a>
      {' '}© <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>
      {' '}© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
      {' '}· Renderer <a href="https://maplibre.org/" target="_blank" rel="noreferrer">MapLibre</a>
    </div>
    <span className="sr-only">Stile richiesto: {STADIA_STYLE_URL}</span>
  </div>;
}
