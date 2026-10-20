/**
 * One shape for a setting, used by every section of the preferences.
 *
 * Settings grew a layout per section: a label above a dropdown here, a checkbox with
 * two nested spans there, a bare input stack in the master-password pane. Nothing was
 * wrong with any one of them and the whole read as a patchwork — and it read worst on
 * the desktop, which is the shell that shows the most sections (the shell picker, focus
 * mode, the master password and the danger zone are local-only, and they were the
 * ragged ones). The two shells serve the same bundle, so this was never per-shell CSS:
 * it was fourteen sections inventing fourteen layouts.
 *
 * `design/mock/rite.css` (`.settings-row`) is the shape being matched: what the setting
 * is on the left, the control that changes it on the right, one hairline between rows
 * and none under the last.
 */

import type { ReactNode } from 'react';
import { SwitchPill } from './Switch';

/** The row geometry, shared by all three so they stack into one list. */
const ROW = 'flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0';

/** A section's heading and, when it needs one, the sentence under it. */
export function SettingsHead({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <>
      <h3 className="text-lg font-semibold">{title}</h3>
      {hint ? (
        <p className="mb-2 mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      ) : (
        <div className="mb-2" />
      )}
    </>
  );
}

/** A setting whose control fits beside it: a dropdown, a button, a short field. */
export function SettingsRow({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={ROW}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

/**
 * The same row for a boolean, as the switch itself — the whole row is the button, so the
 * text toggles it too, which is both the a11y answer and a far bigger target than a 24px
 * pill. `SwitchPill` draws it, so a preference and an instance setting are the same
 * control (`Switch.tsx` says why that is not a detail).
 *
 * `title` is a string, not a node: it is also the accessible name, and the row's visible
 * text is title plus explanation — a sentence, which is no name at all.
 */
export function SettingsToggle({
  title,
  hint,
  checked,
  onChange,
  disabled,
  testId,
}: {
  title: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`${ROW} w-full text-left disabled:cursor-not-allowed`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        {hint && (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>
        )}
      </span>
      <SwitchPill checked={checked} />
    </button>
  );
}

/**
 * A setting whose control cannot share the line — a list of shells, three password
 * fields, a red box. Same head, stacked underneath, so it still reads as one of the
 * rows rather than as a different kind of screen.
 */
export function SettingsField({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** A dropdown is `w-full` by design, so a row gives it a width to be full of. */
export function SettingsControl({ children }: { children: ReactNode }) {
  return <div className="w-56">{children}</div>;
}
