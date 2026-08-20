/**
 * The form controls these pages use are actually styled.
 *
 * The shared stylesheet covered cards, buttons, inputs and typography, and
 * had no rule for a select at all. The configuration screen therefore put
 * raw browser dropdowns directly beneath a fully designed primary button,
 * and a badge rode on top of the calendar name beside it.
 *
 * Both were invisible for as long as nobody could see the page. They are
 * pinned structurally rather than visually because that is what caught them:
 * a rule either exists in the sheet or it does not.
 */
import { describe, it, expect } from "vitest";
import { AUTH_CSS } from "./auth-static/auth-css.js";
import { renderGoogleCalendarPicker } from "./connection-configure.js";

describe("form controls are styled", () => {
  it("covers every control these pages actually use", () => {
    // Asserted as selectors at the start of a rule, not as substrings.
    // "contains the word select" is true of almost any stylesheet, so it
    // passed happily against a sheet where the select rule had been deleted.
    for (const selector of [
      'input\\[type="text"\\]',
      'input\\[type="number"\\]',
      'input\\[type="checkbox"\\]',
      "select",
    ]) {
      expect(AUTH_CSS).toMatch(new RegExp(`^${selector}[\\s,:{]`, "m"));
    }
  });

  it("strips the native chrome off a select", () => {
    expect(AUTH_CSS).toContain("appearance: none");
    // Replaced elements cannot host a pseudo element, so the chevron has to
    // be a background image. Losing it leaves a dropdown with no affordance.
    expect(AUTH_CSS).toContain("background-image: url(");
  });
});

describe("one section-label style", () => {
  it("has no second, competing label primitive", () => {
    // `.eyebrow` was uppercase and grey, `.lsec` is sentence case and black,
    // and they did the same job on different pages. The second is the one
    // that stayed.
    expect(AUTH_CSS).toContain(".lsec");
    expect(AUTH_CSS).not.toContain(".eyebrow {");
  });
});

describe("a badge sits beside its label, not on top of it", () => {
  const picker = () =>
    renderGoogleCalendarPicker({
      connectionId: "01999a3f-96ad-4ec1-b378-399d4875cfa5",
      calendars: [
        {
          id: "primary",
          summary: "A calendar with a fairly long name",
          primary: true,
          backgroundColor: "#3f51b5",
          accessRole: "owner",
        },
      ],
      writeFamilyChoices: ["google", "core"],
      defaultWriteFamily: "google",
    });

  it("keeps the badge outside the bold element", () => {
    const html = picker();
    // The overlap was structural: the badge was nested inside a
    // display:block <b>, so nothing held the two apart.
    expect(html).not.toMatch(/<b>[^<]*<span class="ccard__badge"/);
    expect(html).toContain('class="ccard__name"');
  });

  it("gives the row a rule that separates them", () => {
    expect(AUTH_CSS).toContain(".ccard__name");
    // And the long name truncates rather than pushing the badge off the card.
    expect(AUTH_CSS).toContain("text-overflow: ellipsis");
  });
});
