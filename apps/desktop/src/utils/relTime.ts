/**
 * "When was this last used", in words, from an epoch time in SECONDS.
 *
 * One implementation because there were three, and they disagreed twice over.
 *
 * On the unit: every timestamp Rite stores is epoch **seconds** — the server writes
 * `unixepoch()` and `recordLastUsed` mirrors it with `Date.now() / 1000`. One of the three
 * copies divided a difference by a thousand as if it had been handed milliseconds, so every
 * machine row in a collection read a number of weeks since 1970. The parameter is named for
 * its unit now, and `e2e/rel-time-check.mjs` pins it.
 *
 * On the words: the other two translated "never" and "just now" and then appended `m ago`,
 * `h ago`, `w ago` in English whatever the locale. All of it comes from the locales here.
 *
 * `t` is passed in rather than imported so this stays pure and a check can drive it.
 */

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface RelTimeOptions {
  /** What to render when there is no timestamp. Defaults to the `time.never` wording. */
  never?: string;
}

export function relTime(
  epochSeconds: number | null | undefined,
  t: Translate,
  options: RelTimeOptions = {},
): string {
  if (!epochSeconds) return options.never ?? t('time.never');
  // The one mistake this can be handed is milliseconds, and the magnitude says so without
  // ambiguity: 1e12 seconds is the year 33658. Converted rather than rendered wrong — with
  // the clamp below, a millisecond value would otherwise read "just now" forever, which is
  // a wrong time nobody would notice. The warning is for whoever passed it.
  let at = epochSeconds;
  if (at > 1e12) {
    console.warn('[relTime] given milliseconds; this takes epoch seconds');
    at = Math.floor(at / 1000);
  }
  // Clamped at zero: a clock that moved backwards must not read "in 3 minutes".
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - at));
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.daysAgo', { n: days });
  return t('time.weeksAgo', { n: Math.floor(days / 7) });
}
