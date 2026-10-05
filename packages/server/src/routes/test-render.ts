/**
 * The two page renderers that carry an inline script, for tests that look at
 * a page's markup rather than at the nonce on its script.
 *
 * Each takes the nonce its response's policy names, which a request supplies
 * and a bare render does not. These give it a fixed one, so a test that asks
 * what a page says does not have to invent what the page is allowed to run.
 */
import { renderConsentScreen as render } from "./consent.js";
import { renderDevicePage as renderDevice } from "./device-pages.js";

/** The nonce the wrappers below hand every render. */
export const TEST_NONCE = "test-nonce";

export function renderConsentScreen(
  params: Omit<Parameters<typeof render>[0], "nonce">,
): string {
  return render({ ...params, nonce: TEST_NONCE });
}

export function renderDevicePage(
  params: Omit<Parameters<typeof renderDevice>[0], "nonce">,
): string {
  return renderDevice({ ...params, nonce: TEST_NONCE });
}
