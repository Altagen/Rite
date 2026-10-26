/**
 * Conventional Commits, with one commit excused by name.
 *
 * The release pull request lints every commit in `main..develop`, which is the first time
 * a merged subject is seen in a range rather than on its own branch — and one of them is
 * 101 characters where the limit is 100. Not as it was written: it was 94, and the squash
 * merge that landed it appended ` (#362)`. `develop` is protected, so that history cannot
 * be rewritten, and the release would be blocked by a subject nobody can now change.
 *
 * Excused by its own text rather than by raising the limit, so the rule still holds for
 * every commit written from here on. Nothing else appends to a subject any more: merges
 * into `develop` are rebases now, which keep the subject exactly as committed — that
 * change was made after a squash cost a release its granular notes.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    (message) =>
      message.startsWith(
        'chore: say what zeroize covers, kill every surviving mutant, and stop reusing a rotted harness',
      ),
  ],
};
