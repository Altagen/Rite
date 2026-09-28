/**
 * Destructive-action panel: on-theme (respects the app palette) but unmistakably red,
 * and always placed LAST in a view. Shared by the admin surfaces (collection governance,
 * teams…) so every "danger zone" reads the same.
 */
export function DangerZone({
  title,
  desc,
  action,
  onAction,
  disabled = false,
}: {
  title: string;
  desc: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-red-500/40 bg-red-500/[0.05]">
      <div className="border-b border-red-500/25 px-5 py-3.5 text-sm font-semibold text-red-500">Danger zone</div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <div className="font-semibold">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
        </div>
        <button
          onClick={onAction}
          disabled={disabled}
          className="rounded-md border border-red-500/45 px-3 py-1.5 text-sm font-medium text-red-500 hover:border-red-500 hover:bg-red-500/[0.13] disabled:opacity-50"
        >
          {action}
        </button>
      </div>
    </div>
  );
}
