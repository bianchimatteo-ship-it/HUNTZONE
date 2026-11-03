import { Map as MapLibreMap, type Map as MapLibreMapInstance } from 'maplibre-gl';

export const STADIA_STYLE_URL = 'https://tiles-eu.stadiamaps.com/styles/alidade_smooth_dark.json';

export function createStadiaMap(container: HTMLElement): MapLibreMapInstance {
  return new MapLibreMap({
    container,
    style: STADIA_STYLE_URL,
    center: [0, 20],
    zoom: 1.5,
    minZoom: 1,
    maxZoom: 19,
    attributionControl: false,
    cooperativeGestures: true,
    touchPitch: false,
  });
}
