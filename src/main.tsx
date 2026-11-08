import React from 'react';
import ReactDOM from 'react-dom/client';
import OnlineApp from './OnlineApp';
import { LocationProvider } from './location/LocationProvider';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocationProvider><OnlineApp /></LocationProvider>
  </React.StrictMode>,
);
