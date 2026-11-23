import { expect } from "vitest";

/** The instance's own id, which an item's `app_url` carries. */
export async function instanceIdOf(
  apiUrl: string,
  apiKey: string,
): Promise<string> {
  const response = await fetch(apiUrl, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = (await response.json()) as { instance_id?: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(typeof body.instance_id).toBe("string");
  return body.instance_id as string;
}

/** The origin of an item's `web_url` while no sign-in address is stored: localhost and the bound port. */
export function unsetSignInOrigin(apiUrl: string): string {
  const port = new URL(apiUrl).port;
  return port === "" || port === "80"
    ? "http://localhost"
    : `http://localhost:${port}`;
}

/** What an item with this id answers as `web_url` and `app_url`. */
export function itemLinks(
  origin: string,
  instance: string,
  id: string,
): { web_url: string; app_url: string } {
  return {
    web_url: `${origin}/i/${id}`,
    app_url: `marfa://${instance}/${id}`,
  };
}
