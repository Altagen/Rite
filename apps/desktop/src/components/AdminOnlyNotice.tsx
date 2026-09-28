/**
 * Shown on an admin-only server (RITE_SERVE_WEBUI=off) to a signed-in user who is
 * not an admin: there is no client workspace here, and they can't open the console.
 */
export function AdminOnlyNotice({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-xl">
        <h1 className="mb-2 text-lg font-semibold">Admin console only</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          This server exposes only the administration console, and your account isn&rsquo;t an
          administrator. Contact an admin if you need access.
        </p>
        <button
          onClick={onSignOut}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
