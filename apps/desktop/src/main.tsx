import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConfirmDialog } from './components/ConfirmDialog';
import { applyDevHarness } from './utils/devHarness';
import './index.css';

// Dev-only: `?harness=admin|teams|collections|app` seeds a synthetic server session so the
// accounts surfaces are browsable in the backend-less Vite mock. No-op in production.
applyDevHarness();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary level="app" name="RootApp">
    <I18nProvider>
      <App />
      {/* Outside App on purpose: every branch of its render can raise a confirmation,
          including the admin-only deployment where there is no workspace. */}
      <ConfirmDialog />
    </I18nProvider>
  </ErrorBoundary>,
);
