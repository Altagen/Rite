import { useEffect, useState } from 'react';
import { useAuthStore } from './store/authStore';
import { useServerSession } from './store/serverSessionStore';
import { SetupScreen } from './components/SetupScreen';
import { MainScreen } from './components/MainScreen';
import { ServerAuthScreen } from './components/ServerAuthScreen';
import { AccountsShell } from './components/AccountsShell';
import { Hub } from './components/Hub';
import { useTranslation } from './i18n/i18n';
import { applyNativeContext, isNativeShell, nativeContext } from './utils/nativeShell';
import { ErrorBoundary } from './components/ErrorBoundary';

function Loading({ label }: { label: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function App() {
  const { isFirstRun, checkFirstRun } = useAuthStore();
  const { mode, user, loadMode } = useServerSession();
  const { t } = useTranslation();

  // The native launch window shows the context hub until a context is picked
  // (ADR 0014). Picking "local vault" reuses this window (→ the local flow);
  // picking a server opens another window. Web has no hub.
  const isHubWindow = isNativeShell() && nativeContext()?.kind === 'hub';
  const [picked, setPicked] = useState(false);

  // On a native server-context window, activate its target server first (may
  // reload once); a local window or the web build is a no-op. Then discover
  // whether this endpoint is a shared server or a local vault.
  useEffect(() => {
    void applyNativeContext().then(loadMode);
  }, [loadMode]);

  // Local vault only: check first-run for the master-password flow.
  useEffect(() => {
    if (mode && !mode.accounts) {
      checkFirstRun();
    }
  }, [mode, checkFirstRun]);

  // Front door: the launch window lists contexts before any authentication.
  if (isHubWindow && !picked) {
    return (
      <ErrorBoundary level="feature" name="Hub">
        <Hub onOpenLocalInPlace={() => setPicked(true)} />
      </ErrorBoundary>
    );
  }

  // Waiting to learn the endpoint mode.
  if (mode === null) {
    return <Loading label={t('app.loading')} />;
  }

  // Shared server (ADR 0010): authenticate, then the server landing.
  if (mode.accounts) {
    if (!user) {
      return (
        <ErrorBoundary level="feature" name="ServerAuthScreen">
          <ServerAuthScreen />
        </ErrorBoundary>
      );
    }
    return (
      <ErrorBoundary level="feature" name="AccountsShell">
        <AccountsShell />
      </ErrorBoundary>
    );
  }

  // Local vault: master-password setup / main screen.
  if (isFirstRun === null) {
    return <Loading label={t('app.loading')} />;
  }
  if (isFirstRun) {
    return (
      <ErrorBoundary level="feature" name="SetupScreen">
        <SetupScreen />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary level="feature" name="MainScreen">
      <MainScreen />
    </ErrorBoundary>
  );
}

export default App;
