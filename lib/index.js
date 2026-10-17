/**
 * Host half of dsh-session-search.
 *
 * Search runs entirely in the browser: it scans the transcript DOM, so the host
 * has nothing to serve and registers no route, service or watcher. This module
 * exists because a profile bundle is a single plugin row that mounts both
 * halves — `dsh.bundle.patch` names this file, and dropping it would stop the
 * package from being composed at all, taking the client find bar with it.
 */

/** Cordis plugin name. */
export const name = "session-search";

/**
 * Mount nothing. Kept as a no-op export rather than an absent one so the
 * loader's expectation of a plugin entry still holds.
 */
export function apply() {}
