import React from 'react';
import ReactDOM from 'react-dom/client';
import './map/configureMapLibreWorker';
import App from './App';
import { LocationProvider } from './location/LocationProvider';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocationProvider><App /></LocationProvider>
  </React.StrictMode>,
);
