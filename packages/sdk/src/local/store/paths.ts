/**
 * Whether a store path names a file on this machine, and which file.
 *
 * Two things need the answer and they need the same one. The database asks
 * it to decide whether to make the store's parent directory; the lock asks
 * it to decide whether there is a file to contend over at all. They used to
 * answer it separately, and had already drifted: the database tested
 * `startsWith("http")` while the lock tested `^(https?|libsql):`, so a
 * relative path beginning `httpd/` was remote to one and local to the
 * other. Neither was wrong on its own, which is how the two survived side
 * by side — a rule stated twice is two rules, free to diverge, and this one
 * had.
 */

/**
 * The on-disk file a store path names, or `undefined` when it names none.
 *
 * `:memory:` has no file, and neither does a remote libsql or HTTP URL. A
 * `file:` URL does, and it is returned with the scheme and any query string
 * removed, because a caller wants a path it can pass to `dirname` rather
 * than a URL.
 */
export function localFilePathFor(pathOrUrl: string): string | undefined {
  if (pathOrUrl === ":memory:") return undefined;
  // The `//` matters. Without it this also claims a relative path whose
  // first segment merely starts with one of these words.
  if (/^(https?|libsql):\/\//.test(pathOrUrl)) return undefined;

  const withoutScheme = pathOrUrl.startsWith("file:")
    ? pathOrUrl.slice("file:".length)
    : pathOrUrl;
  const withoutQuery = withoutScheme.split("?")[0] ?? withoutScheme;

  // `toLibsqlUrl` maps `:memory:` to `file::memory:?cache=shared`, so that
  // form can arrive here already expanded. It is still memory, and treating
  // it as a file would have the lock contend over a path named `:memory:`.
  if (withoutQuery === ":memory:" || withoutQuery === "") return undefined;

  return withoutQuery;
}
