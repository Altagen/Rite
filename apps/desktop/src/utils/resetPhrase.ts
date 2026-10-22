/**
 * The phrase someone types to confirm a destructive reset.
 *
 * Deliberately **not** translated: it is compared byte for byte in code, and the locales
 * quote it inside their instruction ("Type DELETE ALL DATA to confirm", "Saisir DELETE ALL
 * DATA pour confirmer"). Translating it would mean the French instruction asking for a
 * phrase the comparison then refuses — a reset nobody can complete, on the screen reached
 * when someone is already locked out.
 *
 * One constant because it was five literals across two screens. `e2e/i18n-check.mjs` holds
 * every locale's instruction to quoting it, so a well-meant translation fails the gate
 * instead of the reader.
 */
export const RESET_PHRASE = 'DELETE ALL DATA';
