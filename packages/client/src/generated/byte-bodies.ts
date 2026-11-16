// Generated from openapi.json by scripts/generate-schema.ts — do not edit.

/** The media type each door that takes raw bytes declares, by method and path. */
export const BYTE_BODIES: Readonly<Record<string, string>> = {
  "POST /blobs": "application/octet-stream",
  "PUT /owner/avatar": "application/octet-stream",
  "PUT /profile/avatar": "application/octet-stream",
  "POST /restore": "application/x-tar"
};
