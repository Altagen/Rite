import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyDevHarness } from './utils/devHarness';
import './index.css';

// Dev-only: `?harness=admin|teams|collections|app` seeds a synthetic server session so the
// accounts surfaces are browsable in the backend-less Vite mock. No-op in production.
applyDevHarness();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary level="app" name="RootApp">
    <I18nProvider>
      <App />
    </I18nProvider>
  </ErrorBoundary>
);
