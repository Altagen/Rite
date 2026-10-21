/**
 * The eye on a secret field, written once.
 *
 * It was written five times, in three different shapes: the heroicons eye/eye-slash pair on
 * the unlock and setup screens, a different eye-slash in the connection form's auth section,
 * and the words "Show"/"Hide" in Settings and on the forced-password screen. Three answers to
 * one question, which is how the three screens that had NO eye at all went unnoticed — the
 * sign-in screen among them, where it is needed most: it is the first password anyone types
 * into Rite, on a keyboard layout they may have guessed wrong.
 *
 * Sits inside a `relative` wrapper, over an input with right padding (`pr-10`). `tabIndex={-1}`
 * on purpose: Tab should go from the password to the submit button, not detour through a
 * control that changes nothing but what the eye sees.
 */

import { useTranslation } from '../i18n/i18n';

export function RevealToggle({
  shown,
  onToggle,
  disabled,
}: {
  shown: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      tabIndex={-1}
      aria-label={shown ? t('common.hidePassword') : t('common.showPassword')}
      title={shown ? t('common.hidePassword') : t('common.showPassword')}
      data-testid="reveal-password"
      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground disabled:opacity-50"
    >
      {shown ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
          />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-5 w-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )}
    </button>
  );
}
