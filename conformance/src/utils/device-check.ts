/**
 * The check step a device code passes before its approval page opens: the
 * owner compares the code with the device and confirms it matches
 * (`keys-and-oauth/device-check-confirm`). The confirmation holds only for
 * the browser session that made it.
 */

/** Posts the owner's confirmation of `userCode` from the browser `cookie` signs in, following no redirect. */
export function postDeviceCheck(
  base: string,
  origin: string,
  cookie: string,
  userCode: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/auth/device/check`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({ user_code: userCode }),
  });
}

/** Confirms `userCode` as the owner does, and fails unless the server sends the browser on to the approval page. */
export async function checkDeviceCode(
  base: string,
  origin: string,
  cookie: string,
  userCode: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const checked = await postDeviceCheck(
    base,
    origin,
    cookie,
    userCode,
    headers,
  );
  const sent = checked.headers.get("location") ?? "";
  if (
    checked.status !== 302 ||
    new URL(sent, base).pathname !== "/auth/device/consent"
  ) {
    throw new Error(
      `the check of the device code was refused: ${String(checked.status)} ${sent}`,
    );
  }
}
