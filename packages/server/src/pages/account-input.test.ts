import { describe, expect, it } from "vitest";
import { DisplayNameSchema } from "../display-name.js";
import {
  ACCOUNT_WORDS,
  codePoints,
  emailProblem,
  nameProblem,
  newPasswordProblem,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "./account-input.js";

describe("a name the owner types", () => {
  it("is refused when nothing is left of it, and says so in the words the page uses", () => {
    for (const raw of ["", " ", "   ", " ", "　"])
      expect(nameProblem(raw), JSON.stringify(raw)).toBe(
        ACCOUNT_WORDS.enterName,
      );
    expect(nameProblem("", ACCOUNT_WORDS.enterPasskeyName)).toBe(
      ACCOUNT_WORDS.enterPasskeyName,
    );
  });

  it("counts Unicode code points, so 200 astral characters pass and 201 do not", () => {
    expect(nameProblem("a".repeat(200))).toBeUndefined();
    expect(nameProblem("a".repeat(201))).toBe(ACCOUNT_WORDS.nameTooLong);
    expect(nameProblem("\u{1F600}".repeat(200))).toBeUndefined();
    expect(nameProblem("\u{1F600}".repeat(201))).toBe(
      ACCOUNT_WORDS.nameTooLong,
    );
    expect(codePoints("\u{1F600}a")).toBe(2);
  });

  it("refuses a control or bidirectional character, including a line break at the end", () => {
    for (const raw of [
      "Ada\n",
      "Ada\u0000",
      "A\u007fda",
      "A\u0085da",
      "A‮da",
      "A⁦da",
      "A‏da",
    ])
      expect(nameProblem(raw), JSON.stringify(raw)).toBe(
        ACCOUNT_WORDS.hiddenCharacter,
      );
    expect(nameProblem("Ada <b>Lovelace</b>")).toBeUndefined();
  });

  it("agrees with the server for every value tried", () => {
    const values = [
      "",
      " ",
      "Ada",
      "  Ada  ",
      "a".repeat(200),
      "a".repeat(201),
      "\u{1F600}".repeat(200),
      "\u{1F600}".repeat(201),
      "Ada\n",
      "A\u0007da",
      "A‮da",
      "A‏da",
      "<script>x</script>",
    ];
    for (const value of values)
      expect(
        nameProblem(value) === undefined,
        JSON.stringify(value.slice(0, 12)),
      ).toBe(DisplayNameSchema.safeParse(value).success);
  });
});

describe("an email address the owner types", () => {
  it("is refused when empty, too long or not shaped like an address", () => {
    expect(emailProblem("  ")).toBe(ACCOUNT_WORDS.enterEmail);
    expect(emailProblem(`${"a".repeat(250)}@a.co`)).toBe(
      ACCOUNT_WORDS.emailTooLong,
    );
    for (const raw of ["ada", "ada@", "@example.com", "a b@example.com"])
      expect(emailProblem(raw), raw).toBe(ACCOUNT_WORDS.emailShape);
  });

  it("allows an address of 254 characters and one with capitals", () => {
    expect(emailProblem(`${"a".repeat(244)}@a.co`)).toBeUndefined();
    expect(emailProblem("Ada@Example.COM")).toBeUndefined();
  });
});

describe("a new password", () => {
  it("must be 8 to 128 characters", () => {
    expect(newPasswordProblem("a".repeat(PASSWORD_MIN - 1))).toBe(
      ACCOUNT_WORDS.newPasswordLength,
    );
    expect(newPasswordProblem("a".repeat(PASSWORD_MIN))).toBeUndefined();
    expect(newPasswordProblem("a".repeat(PASSWORD_MAX))).toBeUndefined();
    expect(newPasswordProblem("a".repeat(PASSWORD_MAX + 1))).toBe(
      ACCOUNT_WORDS.newPasswordLength,
    );
  });
});
