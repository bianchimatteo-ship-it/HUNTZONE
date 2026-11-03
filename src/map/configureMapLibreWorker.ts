import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// Vite emits this worker as a base-aware asset for dev, root hosting and Pages.
setWorkerUrl(workerUrl);

export { workerUrl as mapLibreWorkerUrl };
