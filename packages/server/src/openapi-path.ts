/**
 * `/items/:id/purge` as the document spells it: `/items/{id}/purge`.
 *
 * One function, because the request log's `route` and the document's paths
 * have to be spelled alike for `check:statuses` to pair a request with its
 * operation, and two copies are two spellings that can drift apart.
 */
export function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}
