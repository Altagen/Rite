import { useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { useServerSession } from './store/serverSessionStore';
import { SetupScreen } from './components/SetupScreen';
import { MainScreen } from './components/MainScreen';
import { ServerAuthScreen } from './components/ServerAuthScreen';
import { AccountsShell } from './components/AccountsShell';
import { useTranslation } from './i18n/i18n';
import { applyNativeContext, isNativeShell } from './utils/nativeShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConnectionError } from './components/ConnectionError';
import { OfflineBanner } from './components/OfflineBanner';
import { transport } from './utils/transport';

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
  const { mode, user, loadMode, connError } = useServerSession();
  const { t } = useTranslation();

  // On a native server-context window, activate its target server first (may
  // reload once); a local window or the web build is a no-op. Then discover
  // whether this endpoint is a shared server or a local vault.
  useEffect(() => {
    void applyNativeContext().then(loadMode);
  }, [loadMode]);

  // Boot failed to reach the server → keep retrying on our own until it comes up.
  useEffect(() => {
    if (!connError) return;
    const t = setInterval(() => void loadMode(), 4000);
    return () => clearInterval(t);
  }, [connError, loadMode]);

  // Live policy distribution (ADR 0017): the server nudges connected clients when an admin
  // changes a governed policy (health-check, shell, Quick SSH…); re-pull the mode so client
  // capabilities update at once instead of waiting for the next poll. The WS needs a session
  // token in accounts mode, so wait for login there.
  const wsReady = !!mode && (!mode.accounts || !!user);
  useEffect(() => {
    if (!wsReady) return;
    let unlisten: (() => void) | undefined;
    void transport()
      .listen('policy-updated', () => void loadMode())
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, [wsReady, loadMode]);

  // Local vault only: check first-run for the master-password flow.
  useEffect(() => {
    if (mode && !mode.accounts) {
      checkFirstRun();
    }
  }, [mode, checkFirstRun]);

  // Couldn't reach the server at boot (unreachable / still starting) → a clear full-page
  // state with auto-retry, not an endless spinner.
  if (connError && mode === null) {
    return (
      <>
        <OfflineBanner />
        <ConnectionError kind={connError} retrying onRetry={() => void loadMode()} />
      </>
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
        <OfflineBanner />
        <AccountsShell />
      </ErrorBoundary>
    );
  }

  // Local vault. Native (base-first, ADR 0014): always land in the base workspace
  // — local terminal + Quick SSH work with no vault; setting up / unlocking the
  // vault (to see saved connections) happens inside it. Web keeps the full-screen
  // first-run setup (the browser has no base-terminal use before a vault).
  if (isFirstRun === null) {
    return <Loading label={t('app.loading')} />;
  }
  if (isFirstRun && !isNativeShell()) {
    return (
      <ErrorBoundary level="feature" name="SetupScreen">
        <SetupScreen />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary level="feature" name="MainScreen">
      <OfflineBanner />
      <MainScreen />
    </ErrorBoundary>
  );
}

export default App;
