import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { DevBrowserNotice } from './components/common/DevBrowserNotice';
import { bootstrapUiPlatform, isTauriRuntime } from './lib/platform';
import './styles/globals.css';

if (typeof document !== 'undefined' && !document.documentElement.getAttribute('data-theme')) {
  document.documentElement.setAttribute('data-theme', 'dark');
}

void bootstrapUiPlatform().then(() => {
  const children = isTauriRuntime() ? <App /> : <DevBrowserNotice />;

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {children}
    </React.StrictMode>,
  );
});
