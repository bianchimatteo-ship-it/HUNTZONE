import { useEffect, useRef, useState } from 'react';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { type GeoJSONSource, type Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import type { GeoCoordinate, LocationSample } from '../location/geolocation';
import { createAccuracyGeometry, createPlayAreaGeometry } from './geometry';
import { createStadiaMap, STADIA_STYLE_URL } from './stadiaMapProvider';
import 'maplibre-gl/dist/maplibre-gl.css';
import './stadia-map.css';

export type MapLoadStatus =
  | 'INITIALIZING' | 'LOADING_STYLE' | 'LOADING_TILES' | 'READY' | 'DEGRADED'
  | 'WEBGL_UNSUPPORTED' | 'AUTH_ERROR' | 'STYLE_ERROR' | 'WORKER_ERROR'
  | 'NETWORK_ERROR' | 'TIMEOUT' | 'FATAL_ERROR';

type FocusCommand = { point: GeoCoordinate; token: number };
type MarkerProperties = { kind: 'device' | 'center' };
type MapErrorEvent = { error?: unknown; sourceId?: string; tile?: unknown; source?: unknown };
type MapDiagnostic = { code: string; detail: string };

const LOAD_TIMEOUT_MS = 18_000;
const emptyMarkers: FeatureCollection<Point, MarkerProperties> = { type: 'FeatureCollection', features: [] };
const emptyGeometry: FeatureCollection = { type: 'FeatureCollection', features: [] };

function marker(point: GeoCoordinate, kind: MarkerProperties['kind']): Feature<Point, MarkerProperties> {
  return { type: 'Feature', properties: { kind }, geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] } };
}

function errorInfo(event: MapErrorEvent): { message: string; statusCode?: number; resource: boolean } {
  const error = event.error;
  const details = error && typeof error === 'object' ? error as { message?: unknown; status?: unknown; statusCode?: unknown; url?: unknown; name?: unknown } : {};
  const message = [details.name, details.message, details.url, typeof error === 'string' ? error : '']
    .filter(value => typeof value === 'string').join(' ');
  const status = Number(details.statusCode ?? details.status);
  const statusCode = Number.isInteger(status) ? status : undefined;
  return { message, statusCode, resource: Boolean(event.sourceId || event.tile || event.source) };
}

export function classifyMapError(event: MapErrorEvent, mapLoaded: boolean): { status: MapLoadStatus; diagnostic: MapDiagnostic } {
  const info = errorInfo(event);
  const message = info.message.toLowerCase();
  let status: MapLoadStatus;
  let code: string;
  if (info.statusCode === 401 || info.statusCode === 403 || /\b(401|403)\b/.test(message)) {
    status = 'AUTH_ERROR'; code = `HTTP_${info.statusCode ?? (message.match(/\b(401|403)\b/)?.[1] ?? 'AUTH')}`;
  } else if (/worker|web worker|worker script/.test(message)) {
    status = 'WORKER_ERROR'; code = 'WORKER_UNREACHABLE';
  } else if (/webgl|context creation|gpu process/.test(message)) {
    status = 'WEBGL_UNSUPPORTED'; code = 'WEBGL2_UNAVAILABLE';
  } else if (info.resource) {
    status = 'DEGRADED'; code = 'TILE_ERROR';
  } else if (/style|\.json/.test(message)) {
    status = 'STYLE_ERROR'; code = 'STYLE_NOT_LOADED';
  } else if (/network|fetch|timeout|timed out|failed to load|err_/.test(message)) {
    status = 'NETWORK_ERROR'; code = 'NETWORK_FAILURE';
  } else {
    status = mapLoaded ? 'DEGRADED' : 'FATAL_ERROR'; code = 'UNKNOWN_MAP_ERROR';
  }
  if (mapLoaded) status = 'DEGRADED';
  return { status, diagnostic: { code, detail: info.statusCode ? `HTTP ${info.statusCode}` : code.replaceAll('_', ' ').toLowerCase() } };
}

function userMessage(status: MapLoadStatus): string {
  switch (status) {
    case 'WEBGL_UNSUPPORTED': return 'Questo browser o dispositivo non riesce ad avviare la grafica della mappa.';
    case 'AUTH_ERROR': return 'Stadia Maps ha rifiutato la richiesta. Verifica l’accesso autorizzato per questo dominio.';
    case 'STYLE_ERROR': return 'Lo stile cartografico non è stato caricato.';
    case 'WORKER_ERROR': return 'Il componente cartografico non è riuscito ad avviarsi.';
    case 'NETWORK_ERROR': return 'Connessione alla mappa interrotta. Controlla la rete e riprova.';
    case 'TIMEOUT': return 'La mappa non ha terminato il caricamento in tempo.';
    case 'DEGRADED': return 'Alcune tile non sono disponibili; la mappa resta utilizzabile.';
    default: return 'La mappa non è riuscita ad avviarsi. Riprova tra poco.';
  }
}

const fatalStatuses = new Set<MapLoadStatus>([
  'WEBGL_UNSUPPORTED', 'AUTH_ERROR', 'STYLE_ERROR', 'WORKER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'FATAL_ERROR',
]);

export default function StadiaMap({
  center, radiusMeters, deviceSample, focusCommand, onChooseCenter, onStatusChange,
}: {
  center: GeoCoordinate | null;
  radiusMeters: number;
  deviceSample: LocationSample | null;
  focusCommand: FocusCommand | null;
  onChooseCenter: (coordinate: GeoCoordinate) => void;
  onStatusChange?: (status: MapLoadStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const chooseRef = useRef(onChooseCenter);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<MapLoadStatus>('INITIALIZING');
  const [diagnostic, setDiagnostic] = useState<MapDiagnostic | null>(null);
  const loadedRef = useRef(false);
  useEffect(() => { chooseRef.current = onChooseCenter; }, [onChooseCenter]);
  useEffect(() => { onStatusChange?.(status); }, [onStatusChange, status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    loadedRef.current = false;
    setStatus('INITIALIZING');
    setDiagnostic(null);
    let alive = true;
    let styleLoaded = false;
    let map: MapLibreMap;
    let timeoutId: number | null = null;
    const setFailure = (next: MapLoadStatus, code: string) => {
      setStatus(next);
      setDiagnostic({ code, detail: code.replaceAll('_', ' ').toLowerCase() });
    };
    try {
      setStatus('LOADING_STYLE');
      map = createStadiaMap(container);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      const webglUnsupported = /webgl|context|gpu/.test(message);
      const workerFailure = /worker/.test(message);
      setFailure(webglUnsupported ? 'WEBGL_UNSUPPORTED' : workerFailure ? 'WORKER_ERROR' : 'FATAL_ERROR',
        webglUnsupported ? 'WEBGL2_UNAVAILABLE' : workerFailure ? 'WORKER_UNREACHABLE' : 'MAP_INITIALIZATION_FAILED');
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
    timeoutId = window.setTimeout(() => {
      if (!alive || loadedRef.current) return;
      if (styleLoaded) {
        setStatus('DEGRADED');
        setDiagnostic({ code: 'TILE_LOAD_TIMEOUT', detail: 'tile load timeout' });
      } else setFailure('TIMEOUT', 'MAP_LOAD_TIMEOUT');
    }, LOAD_TIMEOUT_MS);
    map.on('style.load', () => { if (alive && !loadedRef.current) { styleLoaded = true; setStatus('LOADING_TILES'); } });
    map.on('load', () => {
      if (!alive) return;
      loadedRef.current = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = null;
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
        const updateZoom = () => { container.dataset.mapZoom = map.getZoom().toFixed(2); };
        updateZoom();
        map.on('zoomend', updateZoom);
        map.on('moveend', updateZoom);
        setDiagnostic(null);
        setStatus('READY');
      } catch {
        setFailure('FATAL_ERROR', 'MAP_RENDER_SETUP_FAILED');
      }
    });
    map.on('error', (event: MapErrorEvent) => {
      if (!alive) return;
      const result = classifyMapError(event, loadedRef.current);
      setStatus(result.status);
      setDiagnostic(result.diagnostic);
    });
    map.on('click', event => chooseRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }));

    const resize = () => map.resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(container);
    window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    return () => {
      alive = false;
      loadedRef.current = false;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      map.remove();
      mapRef.current = null;
    };
  }, [attempt]);

  const hasFatalState = fatalStatuses.has(status);
  const mapVisible = status === 'READY' || status === 'DEGRADED';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapVisible) return;
    try {
      const area = map.getSource('play-area') as GeoJSONSource | undefined;
      const accuracy = map.getSource('gps-accuracy') as GeoJSONSource | undefined;
      const markers = map.getSource('map-markers') as GeoJSONSource | undefined;
      if (!area || !accuracy || !markers) return;
      area.setData(center ? createPlayAreaGeometry(center, radiusMeters) : emptyGeometry);
      accuracy.setData(deviceSample ? createAccuracyGeometry(deviceSample, deviceSample.accuracyMeters) : emptyGeometry);
      markers.setData({
        type: 'FeatureCollection',
        features: [...(deviceSample ? [marker(deviceSample, 'device')] : []), ...(center ? [marker(center, 'center')] : [])],
      });
    } catch {
      setStatus('FATAL_ERROR');
      setDiagnostic({ code: 'OVERLAY_UPDATE_FAILED', detail: 'overlay update failed' });
    }
  }, [center, deviceSample, mapVisible, radiusMeters]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapVisible || !focusCommand) return;
    map.flyTo({ center: [focusCommand.point.longitude, focusCommand.point.latitude], zoom: 16, duration: 650 });
  }, [focusCommand, mapVisible]);

  return <div className="stadia-map-shell" data-map-state={status} data-map-diagnostic={diagnostic?.code ?? ''}>
    <div className="stadia-map-stage" role="region" aria-label="Mappa interattiva: trascina per spostarti, usa i controlli per lo zoom, tocca per scegliere il centro del campo">
      <div className={`stadia-map-canvas ${hasFatalState ? 'stadia-map-canvas--hidden' : ''}`} ref={containerRef} />
      {!mapVisible && !hasFatalState && <div className="map-loading" role="status">{status === 'LOADING_TILES' ? 'Caricamento cartografia…' : 'Avvio della mappa…'}</div>}
      {hasFatalState && <div className="map-provider-error" role="alert"><span aria-hidden="true">⌖</span><h3>{status === 'WEBGL_UNSUPPORTED' ? 'Grafica non supportata' : status === 'AUTH_ERROR' ? 'Accesso cartografico rifiutato' : 'Mappa non disponibile'}</h3><p>{userMessage(status)}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>RIPROVA A CARICARE</button>{diagnostic && <details className="map-diagnostics"><summary>DETTAGLI PER IL SUPPORTO</summary><code>{diagnostic.detail}</code></details>}</div>}
      {status === 'DEGRADED' && <div className="map-degraded" role="status"><span>{userMessage(status)}</span><button type="button" onClick={() => setAttempt(value => value + 1)}>RICARICA</button>{diagnostic && <details><summary>DETTAGLI</summary><code>{diagnostic.detail}</code></details>}</div>}
      {mapVisible && !center && <div className="map-center-hint" aria-live="polite">Tocca la mappa per scegliere il centro</div>}
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
