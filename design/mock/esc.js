/* HTML escaping for the prototypes, in one place.
 *
 * These mocks build markup as strings, which is the point — a template you can read
 * beside the screen it draws. That makes every `innerHTML` here a sink, so text that
 * is DATA rather than markup goes through `esc` first: a name typed into a dialog, a
 * value read back out of an input, anything parsed out of the layouts file, and `?u=`
 * on setup.html, which was a live reflected XSS in this prototype until CodeQL said so.
 *
 * The convention, so a reader does not have to guess which is which: `title`,
 * `subtitle` and `confirm` on `showModal` are text and are escaped for you. A `body`,
 * and a menu item's `icon` and `label`, are markup by design — escape the data you
 * interpolate into them at the call site, as the layout cards and the shell menu do.
 *
 * Loaded before every other script in the page, so `esc` is defined by the time any
 * of them runs. It is a plain script and not a module on purpose: these pages open
 * from the filesystem, and a module would not.
 */
function esc(v) {
  return String(v == null ? '' : v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
