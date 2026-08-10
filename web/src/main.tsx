import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

function showUpdateBanner() {
  if (document.getElementById('sw-update-banner')) return;
  const banner = document.createElement('button');
  banner.id = 'sw-update-banner';
  banner.className = 'update-banner';
  banner.textContent = 'Updated — tap to reload';
  banner.addEventListener('click', () => window.location.reload());
  document.body.appendChild(banner);
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // A controllerchange only means "new version deployed" if this page was
    // already controlled — otherwise it's just the first install claiming.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('SW registration failed:', err));
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', showUpdateBanner);
    }
  });
}
