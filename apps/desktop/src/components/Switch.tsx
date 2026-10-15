/**
 * The one boolean control.
 *
 * Settings used a native `<input type="checkbox">` while the admin console drew a pill
 * switch by hand, nine times over. The checkbox was the visible half of the problem: no
 * CSS of ours applies to it, so each engine draws its own — WebKitGTK in the desktop
 * shell, the browser's own in a tab. Same bundle, same account, two different controls,
 * which is exactly what the two shells must never look like.
 *
 * `design/mock/rite.css` (`.toggle`) is the shape: a pill with a knob that slides.
 *
 * `role="switch"` rather than `checkbox` because that is what it looks like and what it
 * is — on or off, applied at once, no form to submit. The accessible name is passed
 * explicitly: a row's visible text includes its explanation, which is a sentence, not a
 * name.
 */

/** The visual only, for a control whose clickable element is something else (a whole row). */
export function SwitchPill({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-6 w-11 flex-none items-center rounded-full p-0.5 transition-colors ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </span>
  );
}

/** The control on its own, for a row that is laid out by its caller. */
export function Switch({
  checked,
  label,
  onChange,
  disabled,
  testId,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className="flex-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <SwitchPill checked={checked} />
    </button>
  );
}
