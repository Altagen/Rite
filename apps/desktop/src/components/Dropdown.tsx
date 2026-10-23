/**
 * One dropdown, for every choice in the preferences.
 *
 * There were two. Auto-lock and host-key verification were a button with a menu under
 * it; machine status and the terminal theme were a native `<select>`. Same gesture,
 * two widgets, two shapes, two sets of colours — and the native one does not inherit
 * the app's theme on every platform, so the same dialog had a light control in a dark
 * window. A control that looks different per row teaches people that rows mean
 * different things.
 *
 * Deliberately not a generic combobox: no search, no multi-select, no portal. It is
 * the control the preferences need, which is a short list of named choices.
 */

import { useEffect, useRef, useState } from 'react';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Labels the button for assistive technology and for tests. */
  label: string;
  testId?: string;
}

export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  label,
  testId,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click elsewhere or press Escape and it closes: a popover that needs its own
  // button pressed again is a popover people leave open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className="flex w-full items-center justify-between rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none"
        data-testid={testId}
      >
        <span>{current?.label ?? ''}</span>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="absolute z-10 mt-1 w-full divide-y divide-border rounded border border-border bg-background shadow-lg"
        >
          {options.map((option) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setOpen(false);
                if (option.value !== value) onChange(option.value);
              }}
              className={`w-full px-3 py-2 text-left transition-colors hover:bg-muted ${
                option.value === value ? 'font-medium text-primary' : ''
              }`}
              data-testid={testId ? `${testId}-${option.value}` : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
