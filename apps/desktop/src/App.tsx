import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { SetupScreen } from './components/SetupScreen';
import { MainScreen } from './components/MainScreen';
import { useTranslation } from './i18n/i18n';
import { ErrorBoundary } from './components/ErrorBoundary';

function App() {
  const { isFirstRun, checkFirstRun } = useAuthStore();
  const { t } = useTranslation();

  // Check first run status on mount
  useEffect(() => {
    checkFirstRun();
  }, [checkFirstRun]);

  // Loading state
  if (isFirstRun === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="text-sm text-muted-foreground">{t('app.loading')}</p>
        </div>
      </div>
    );
  }

  // First run - show setup screen (with skip option)
  if (isFirstRun) {
    return (
      <ErrorBoundary level="feature" name="SetupScreen">
        <SetupScreen />
      </ErrorBoundary>
    );
  }

  // Main screen - handles locked/unlocked states internally
  // Local terminal and Quick SSH available even when locked
  return (
    <ErrorBoundary level="feature" name="MainScreen">
      <MainScreen />
    </ErrorBoundary>
  );
}

export default App;
