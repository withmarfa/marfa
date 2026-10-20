import { afterEach, describe, expect, it } from "vitest";
import { pageAssetUrl } from "../pages/assets.js";
import { pageLinks, visibleText } from "../pages/reading.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import { renderForgotPasswordPage } from "./test-render.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("the forgot-password page", () => {
  it("says there is no email reset and that recovery is on the machine Marfa runs on", () => {
    const text = visibleText(renderForgotPasswordPage());
    expect(text).toContain("Marfa sends no email");
    expect(text).toContain("on the machine Marfa runs on");
  });

  it("gives the recovery command the CLI has, for a Mac, for Docker and for Railway", () => {
    const html = renderForgotPasswordPage();
    const text = visibleText(html);
    expect(text).toContain("If Marfa runs on your Mac");
    expect(text).toContain("marfa --socket PATH owner recover");
    expect(text).toContain("control/marfa.sock");
    // The command refuses a relative socket path, so the page asks for the whole one.
    expect(text).toContain(
      "Replace PATH with the full path of the private socket",
    );
    expect(text).toContain("If Marfa runs in Docker");
    expect(text).toContain(
      "docker exec -it marfa marfa --socket /data/control/marfa.sock owner recover",
    );
    expect(text).toContain("If Marfa runs on Railway");
    expect(text).toContain(
      'marfa --socket "$MARFA_CONTROL_SOCKET" owner recover',
    );
  });

  it("says what recovery does and leaves alone", () => {
    const text = visibleText(renderForgotPasswordPage());
    expect(text).toContain("asks for a new password");
    expect(text).toContain("signs you out of every browser");
    expect(text).toContain("lifts any password lock");
    expect(text).toContain("Connected apps, keys and passkeys keep working");
  });

  it("offers a way back to sign in", () => {
    expect(pageLinks(renderForgotPasswordPage())).toContainEqual({
      href: "/auth/sign-in",
      text: "Back to sign in",
    });
  });

  it("is served to anyone, uncached, and names no absolute path of the machine it runs on", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/auth/forgot-password");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain(`href="${pageAssetUrl("pages.css")}"`);
    const text = visibleText(html);
    expect(text).toContain("Reset your password");
    // The socket is named by its place beside the database, never by an
    // absolute path of this machine.
    expect(text).toContain("control/marfa.sock");
    // The one absolute path is the image's own, the same in every container.
    expect(text.replaceAll("/data/control/marfa.sock", "")).not.toMatch(
      /\/\S*control\/marfa\.sock/,
    );
  });

  it("is reachable from the sign-in page", async () => {
    ctx = await createTestContext();
    const signIn = await request(ctx.app, "GET", "/auth/sign-in");
    expect(pageLinks(await signIn.text())).toContainEqual({
      href: "/auth/forgot-password",
      text: "Forgot password?",
    });
  });
});
