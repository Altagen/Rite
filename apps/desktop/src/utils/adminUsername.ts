/**
 * The first administrator's name, by convention.
 *
 * The browser bootstrap (`Create the server administrator`) asks for a password and
 * nothing else: the name is `admin`, shown but not editable. Two reasons. A free field
 * on that screen is a name chosen once, under no pressure to remember it, on the one
 * account an instance cannot be opened without — a typo there is a locked instance.
 * And the compose path already fixes it: `deploy/compose.bootstrap.yml` defaults
 * `RITE_ADMIN_USER` to `admin`, so a free field made the two paths disagree.
 *
 * The API stays permissive — `RITE_ADMIN_USER` can still name anyone, which is what an
 * operator provisioning as code expects. This is the UI's convention, not a server rule.
 */
export const ADMIN_USERNAME = 'admin';
