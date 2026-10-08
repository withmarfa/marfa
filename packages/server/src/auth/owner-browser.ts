import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { MarfaAuth } from "./instance.js";

export function requireSecureOwnerTransport(
  auth: Pick<MarfaAuth, "baseURL">,
): void {
  const url = new URL(auth.baseURL);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Owner setup and sign-in require HTTPS, except on loopback development hosts.",
    );
}
export function requireOwnerOrigin(
  auth: Pick<MarfaAuth, "baseURL">,
  headers: Headers,
  options: { allowNonBrowser?: boolean } = {},
): void {
  requireSecureOwnerTransport(auth);
  const origin = headers.get("origin");
  if (origin === new URL(auth.baseURL).origin) return;
  if (
    options.allowNonBrowser &&
    !origin &&
    !headers.has("cookie") &&
    !headers.has("sec-fetch-site")
  )
    return;
  throw new MarfaError(
    ErrorCode.FORBIDDEN,
    "This request must come from Marfa's own page.",
  );
}
