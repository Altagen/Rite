import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary level="app" name="RootApp">
    <I18nProvider>
      <App />
    </I18nProvider>
  </ErrorBoundary>
);
