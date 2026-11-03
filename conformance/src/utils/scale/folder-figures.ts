/**
 * Small pure parts of the folder steps, kept here so they have tests: the
 * request that finds an edit on the server, and the first sync's figure.
 */

/** Notes read per poll. An edit is the newest change, so a few are enough. */
export const EDIT_POLL_LIMIT = 50;

/**
 * The request that lists the folder's notes by when they last changed, newest
 * first, so a note just edited is always on the page however many the folder
 * holds. `updated_after` is not used: the server orders by it, ascending, and
 * refuses it beside a sort.
 */
export function editPollPath(source: string): string {
  const query = new URLSearchParams({
    source,
    sort: "updated_at",
    direction: "desc",
    limit: String(EDIT_POLL_LIMIT),
  });
  return `/items?${query.toString()}`;
}

/** What `folder_first_sync` covers, said in the figure's note. */
export const FIRST_SYNC_COVERS =
  "from before `folders add` to the end of `folders push`: add, hydrate, scan and push and the gaps between them";

/** The first sync: the clock before `folders add` to the clock after the push. */
export function firstSyncMs(beforeAdd: number, afterPush: number): number {
  return afterPush - beforeAdd;
}
