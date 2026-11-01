import { describe, expect, it } from "vitest";
import {
  pageField,
  pageForms,
  pageLinks,
  visibleText,
} from "../pages/reading.js";
import { HOSTILE, LONG_UNBROKEN } from "../pages/test-fixture.js";
import { signInValue, suggestedPasskeyName } from "./account-pages.js";
import { renderPasswordPage } from "./password-page.js";
import { renderProfilePage } from "./profile-page.js";

const profile = (
  owner = {
    name: "Ada Lovelace",
    email: "ada@example.net",
    hasPicture: false,
  },
) => renderProfilePage({ nonce: "abc123", instanceName: "Marfa", owner });

const password = (
  passkeys: Parameters<typeof renderPasswordPage>[0]["passkeys"] = [],
  more: { addressProblem?: boolean; suggestedName?: string } = {},
) =>
  renderPasswordPage({
    nonce: "abc123",
    instanceName: "Marfa",
    passkeys,
    now: Date.parse("2026-10-12T12:00:00.000Z"),
    suggestedName: more.suggestedName ?? "Safari on macOS",
    addressProblem: more.addressProblem ?? false,
  });

const TWO = [
  {
    id: "pk-one",
    name: "Safari on macOS",
    added: new Date("2026-10-03T09:30:00.000Z"),
    lastUsed: new Date("2026-10-09T08:00:00.000Z"),
  },
  {
    id: "pk-two",
    name: null,
    added: new Date("2026-10-09T23:45:00.000Z"),
    lastUsed: null,
  },
];

describe("the Profile page", () => {
  it("shows the name, email and picture, each with a way to change it", () => {
    const text = visibleText(profile());
    expect(text).toContain(
      "Your name, email and picture. Apps see them only if you let them.",
    );
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("ada@example.net. You sign in with it.");
    expect(text).toContain("Change name");
    expect(text).toContain("Shown to apps you let see your profile.");
    expect(text).toContain("Change email");
    expect(text).toContain(
      "You sign in with this email. Marfa sends no email, so there's nothing to confirm.",
    );
    expect(text).toContain("No picture set");
    expect(text).toContain("Change picture");
    expect(text).toContain(
      "Choose a PNG, JPEG or WebP picture of 2 MiB or less.",
    );
    expect(text).not.toMatch(/address/i);
  });

  it("takes a picture as a file, not a web address", () => {
    const out = profile();
    expect(pageField(out, "avatar")?.type).toBe("file");
    expect(out).toContain('accept="image/png,image/jpeg,image/webp"');
  });

  it("shows the picture itself in place of the letter tile once one is set, with a way to remove it", () => {
    const without = profile();
    expect(without).toContain('class="tile"');
    expect(without).not.toContain("<img");
    expect(visibleText(without)).not.toContain("Remove picture");
    const out = profile({
      name: "Ada Lovelace",
      email: "ada@example.net",
      hasPicture: true,
    });
    expect(out).toMatch(/<img[^>]*src="\/owner\/picture"/);
    expect(out).toMatch(/<img[^>]*alt=""/);
    expect(out).not.toContain('class="tile"');
    expect(visibleText(out)).toContain("Remove picture");
    expect(visibleText(out)).toContain("Picture set");
    expect(visibleText(out)).not.toContain("No picture set");
  });

  it("starts each field with the current value and checks nothing in the browser itself", () => {
    const out = profile();
    expect(pageField(out, "name")?.value).toBe("Ada Lovelace");
    expect(pageField(out, "email")?.value).toBe("ada@example.net");
    expect(pageField(out, "email")?.type).toBe("email");
    // The final form is the dialog that confirms it's you, which every console page carries.
    const forms = pageForms(out);
    expect(forms.map((form) => form.method)).toEqual([
      "dialog",
      "dialog",
      "dialog",
      "get",
    ]);
    for (const form of forms) expect(form.novalidate).toBe(true);
  });

  it("escapes what the owner typed and holds a name with no place to break", () => {
    const out = profile({
      name: HOSTILE,
      email: `${LONG_UNBROKEN}@example.net`,
      hasPicture: false,
    });
    expect(out).not.toContain("<script>window.__injected");
    expect(out).not.toContain("<b>bold</b>");
    expect(pageField(out, "name")?.value).toBe(HOSTILE);
    expect(visibleText(out)).toContain(LONG_UNBROKEN);
  });

  it("is headed Profile, with the instance as the first crumb", () => {
    const out = profile();
    expect(out).toMatch(/<h1 class="title">Profile<\/h1>/);
    expect(pageLinks(out).some((link) => link.href === "/")).toBe(true);
  });
});

describe("the Password and passkeys page", () => {
  it("offers the password change with its warning, in a dialog that takes both passwords", () => {
    const out = password();
    const text = visibleText(out);
    expect(text).toContain(
      "How you sign in. Marfa sends no email, so a forgotten password is reset on the machine Marfa runs on.",
    );
    expect(text).toContain("Changing it signs out your other browsers");
    expect(text).toContain(
      "Your other browsers will be signed out. Connected apps and keys keep their access.",
    );
    expect(text).toContain("8 to 128 characters.");
    expect(pageField(out, "currentPassword")?.type).toBe("password");
    expect(pageField(out, "newPassword")?.type).toBe("password");
  });

  it("says there are no passkeys yet, with nothing to manage", () => {
    const out = password([]);
    const text = visibleText(out);
    expect(text).toContain("No passkeys yet");
    expect(text).toContain("Add one to sign in without typing your password.");
    expect(text).not.toContain("Manage passkey");
    expect(out).not.toContain("data-passkey-id");
  });

  it("lists each passkey with its name, its date and a dialog to manage it", () => {
    const out = password(TWO);
    const text = visibleText(out);
    expect(text).toContain("Safari on macOS");
    expect(text).toContain("Added October 3, 2026");
    expect(text).toContain("Added October 9, 2026");
    expect(text).toContain("Remove Safari on macOS?");
    expect(text).toContain("Unnamed passkey");
    expect(text).toContain("Remove this passkey?");
    expect(text).not.toContain("Remove Passkey?");
    expect(text).toContain("You can still sign in with your password.");
    expect(text).not.toContain("No passkeys yet");
    for (const id of ["pk-one", "pk-two"])
      expect(
        out.match(new RegExp(`data-passkey-id="${id}"`, "g")),
      ).toHaveLength(2);
  });

  it("says when each passkey was last used, and that none is recorded for the other", () => {
    const text = visibleText(password(TWO));
    expect(text).toContain("Last used 3 days ago");
    expect(text).toContain("No use recorded");
  });

  it("writes each date as a time element, with the UTC date for a browser that cannot localize it", () => {
    const out = password(TWO);
    expect(
      [...out.matchAll(/<time\b[^>]*>[^<]*<\/time>/g)].map((match) => match[0]),
    ).toEqual([
      '<time datetime="2026-10-03T09:30:00.000Z" data-local-date="">October 3, 2026</time>',
      '<time datetime="2026-10-09T23:45:00.000Z" data-local-date="">October 9, 2026</time>',
    ]);
  });

  it("starts the rename field with the passkey's name, and empty for an unnamed one", () => {
    const out = password(TWO);
    const values = [...out.matchAll(/<input[^>]*name="name"[^>]*>/g)].map(
      (match) => /value="([^"]*)"/.exec(match[0])?.[1],
    );
    expect(values).toEqual(["Safari on macOS", "Safari on macOS", ""]);
  });

  it("starts the Add dialog with the name it suggests", () => {
    const out = password([], { suggestedName: "Firefox on Linux" });
    expect(pageField(out, "name")?.value).toBe("Firefox on Linux");
  });

  it("escapes a passkey's name and keeps a long one from breaking the page", () => {
    const out = password([
      { id: "pk-one", name: HOSTILE, added: new Date(0), lastUsed: null },
      { id: "pk-two", name: LONG_UNBROKEN, added: new Date(0), lastUsed: null },
    ]);
    expect(out).not.toContain("<script>window.__injected");
    expect(out).not.toContain("<b>bold</b>");
    expect(visibleText(out)).toContain(HOSTILE);
    expect(visibleText(out)).toContain(LONG_UNBROKEN);
  });

  it("always states what a passkey needs from the address", () => {
    for (const addressProblem of [false, true])
      expect(visibleText(password([], { addressProblem }))).toContain(
        "Passkeys need a secure HTTPS address, or localhost for development.",
      );
  });

  it("shows the notice about the address only where the address cannot hold a passkey", () => {
    const shown = /<div[^>]*data-notice="unsupported"[^>]*>/;
    expect(shown.exec(password([], { addressProblem: true }))?.[0]).not.toMatch(
      /\bhidden\b/,
    );
    expect(shown.exec(password([], { addressProblem: false }))?.[0]).toMatch(
      /\bhidden\b/,
    );
  });

  it("keeps the Add button hidden until the page's script runs", () => {
    const button = /<button[^>]*data-account-add="passkey-add"[^>]*>/.exec(
      password(),
    )?.[0];
    expect(button).toMatch(/\bhidden\b/);
  });
});

describe("what Home says about signing in", () => {
  it("counts passkeys, and says password only when there are none", () => {
    expect(signInValue(0)).toBe("Password only");
    expect(signInValue(1)).toBe("1 passkey");
    expect(signInValue(2)).toBe("2 passkeys");
  });
});

describe("the name a new passkey starts with", () => {
  const SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

  it("names the browser and system", () => {
    expect(suggestedPasskeyName(SAFARI, [])).toBe("Safari on macOS");
  });

  it("falls back to Passkey where the browser is unknown", () => {
    expect(suggestedPasskeyName(null, [])).toBe("Passkey");
    expect(suggestedPasskeyName("", [])).toBe("Passkey");
    expect(suggestedPasskeyName("\u0000", [])).toBe("Passkey");
  });

  it("numbers a name the owner already has, whatever its case", () => {
    expect(suggestedPasskeyName(SAFARI, ["Safari on macOS"])).toBe(
      "Safari on macOS 2",
    );
    expect(
      suggestedPasskeyName(SAFARI, [
        "safari on macos",
        null,
        "Safari on macOS 2",
      ]),
    ).toBe("Safari on macOS 3");
  });
});
