import { describe, expect, it } from "vitest";
import {
  addsAccess,
  dataSummary,
  heldSummary,
  levelOfValue,
  listWords,
  powersSummary,
  profileSummary,
  type Level,
  type LevelPick,
} from "./access-summary.js";

describe("levelOfValue", () => {
  it("reads the level a value gives, and an empty value as the level the app holds", () => {
    expect(levelOfValue("", "none")).toBe("none");
    expect(levelOfValue("", "read")).toBe("read");
    expect(levelOfValue("core.note:read", "none")).toBe("read");
    expect(levelOfValue("core.note:write", "read")).toBe("write");
    expect(levelOfValue("edge.parent-of:write", "none")).toBe("write");
  });

  it("counts only a level above the one held as adding access", () => {
    expect(addsAccess("read", "read")).toBe(false);
    expect(addsAccess("read", "write")).toBe(false);
    expect(addsAccess("write", "read")).toBe(true);
    expect(addsAccess("none", "none")).toBe(false);
  });
});

describe("listWords", () => {
  it("joins as a sentence does", () => {
    expect(listWords(["a"])).toBe("a");
    expect(listWords(["a", "b"])).toBe("a and b");
    expect(listWords(["a", "b", "c"])).toBe("a, b, and c");
  });
});

describe("dataSummary", () => {
  const pick = (
    noun: string,
    level: Level,
    held: Level = "none",
  ): LevelPick => ({ noun, level, held });

  it("says what the choice gives, edit first", () => {
    expect(
      dataSummary(
        [
          pick("notes", "write"),
          pick("tasks", "read"),
          pick("drafts", "write"),
        ],
        "No access to your data",
      ),
    ).toBe("Read and edit notes and drafts; read tasks");
  });

  it("counts a long list and names the first few", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((n) => pick(n, "write"));
    expect(dataSummary(many, "")).toBe(
      "Read and edit 6 kinds of data, including a, b, and c",
    );
  });

  it("leaves out a choice that adds nothing to what the app holds, and says the empty line when none does", () => {
    expect(
      dataSummary(
        [pick("notes", "read", "read"), pick("tasks", "write", "read")],
        "Nothing new",
      ),
    ).toBe("Read and edit tasks");
    expect(dataSummary([pick("notes", "read", "read")], "Nothing new")).toBe(
      "Nothing new",
    );
    expect(dataSummary([pick("notes", "none")], "No access to your data")).toBe(
      "No access to your data",
    );
  });
});

describe("profileSummary", () => {
  it("names the switches that are on and the levels chosen", () => {
    expect(
      profileSummary(
        [],
        ["Your name and picture", "Your email address"],
        "No access to your profile",
      ),
    ).toBe("See your name and picture and your email address");
    expect(
      profileSummary(
        [{ noun: "your profile", level: "write", held: "read" }],
        [],
        "No access to your profile",
      ),
    ).toBe("Read and edit your profile");
    expect(profileSummary([], [], "No access to your profile")).toBe(
      "No access to your profile",
    );
  });
});

describe("powersSummary", () => {
  it("counts what is on, or says each is off", () => {
    expect(powersSummary(2, 4)).toBe("2 of 4 turned on");
    expect(powersSummary(0, 1)).toBe("1 thing asked, off until you turn it on");
    expect(powersSummary(0, 3)).toBe(
      "3 things asked, each off until you turn it on",
    );
  });

  it("counts even when none is on, for a page where nothing is asked", () => {
    expect(powersSummary(0, 3, true)).toBe("0 of 3 turned on");
    expect(powersSummary(2, 3, true)).toBe("2 of 3 turned on");
  });
});

describe("heldSummary", () => {
  it("says what the app holds, then the powers", () => {
    expect(
      heldSummary(
        [
          { noun: "tasks", level: "write" },
          { noun: "events", level: "read" },
        ],
        [],
        ["Make keys"],
      ),
    ).toBe("Read and edit tasks; read events. Can also make keys");
    expect(heldSummary([], [], ["Make keys", "Read the activity log"])).toBe(
      "Can also do 2 things that control Marfa",
    );
  });
});

describe("dataSummary while types are chosen", () => {
  const type = (noun: string, level: Level): LevelPick => ({
    noun,
    level,
    held: "none",
    type: true,
  });
  const types = (count: number, level: Level = "write") =>
    Array.from({ length: count }, (_, i) => type(`kind${String(i)}s`, level));
  const links: LevelPick = {
    noun: "links between items",
    level: "write",
    held: "none",
  };
  const EMPTY = "No access to your data";

  it("counts the types alone, and names a row that is not a type beside the count", () => {
    expect(dataSummary(types(21), EMPTY, 21)).toBe(
      "Read and edit 21 of your 21 types",
    );
    expect(dataSummary([...types(21), links], EMPTY, 21)).toBe(
      "Read and edit 21 of your 21 types and links between items",
    );
  });

  it("keeps the count right as types are lowered", () => {
    const lowered = [
      ...types(17),
      type("alphas", "read"),
      type("betas", "read"),
      type("gammas", "none"),
      type("deltas", "none"),
    ];
    expect(dataSummary([...lowered, links], EMPTY, 21)).toBe(
      "Read and edit 17 of your 21 types and links between items; read alphas and betas",
    );
    expect(dataSummary(lowered, EMPTY, 21)).toBe(
      "Read and edit 17 of your 21 types; read alphas and betas",
    );
  });

  it("names a few types and leaves the links as they were when the count says little", () => {
    expect(dataSummary([...types(6), links], EMPTY, 21)).toBe(
      "Read and edit 7 kinds of data, including kind0s, kind1s, and kind2s",
    );
  });
});

describe("two things that read alike", () => {
  const pick = (
    noun: string,
    level: Level,
    alias?: string,
    type = false,
  ): LevelPick => ({ noun, level, held: "none", alias, type });

  it("are each named by what they stand for, where their nouns match", () => {
    expect(
      dataSummary(
        [
          pick("tasks", "write", "core.task"),
          pick("tasks", "write", "aic.ticket.task"),
          pick("notes", "write", "core.note"),
        ],
        "",
      ),
    ).toBe("Read and edit core.task, aic.ticket.task, and notes");
    expect(
      dataSummary(
        [
          pick("tasks", "write", "core.task"),
          pick("tasks", "read", "aic.ticket.task"),
        ],
        "",
      ),
    ).toBe("Read and edit core.task; read aic.ticket.task");
  });

  it("keep a noun that is its own, and one with no identifier", () => {
    expect(
      dataSummary(
        [
          pick("tasks", "read", "core.task"),
          pick("notes", "read", "core.note"),
        ],
        "",
      ),
    ).toBe("Read tasks and notes");
    expect(
      dataSummary(
        [pick("profiles", "read", "aic.me.profile"), pick("profiles", "read")],
        "",
      ),
    ).toBe("Read aic.me.profile and profiles");
  });

  it("are named by identifier in what an app holds", () => {
    expect(
      heldSummary(
        [
          { noun: "tasks", level: "read", alias: "core.task" },
          { noun: "tasks", level: "write", alias: "aic.ticket.task" },
        ],
        [],
        [],
      ),
    ).toBe("Read and edit aic.ticket.task; read core.task");
  });

  it("are named by identifier where what is held reads alike, in the line for what is held and the line for what is asked", () => {
    const held = [{ noun: "tasks", alias: "core.task" }];
    const asked = [{ noun: "tasks", alias: "aic.ticket.task" }];
    expect(
      dataSummary(
        [pick("tasks", "write", "aic.ticket.task")],
        "",
        undefined,
        held,
      ),
    ).toBe("Read and edit aic.ticket.task");
    expect(
      heldSummary(
        [{ noun: "tasks", level: "read", alias: "core.task" }],
        [],
        [],
        asked,
      ),
    ).toBe("Read core.task");
    // The witness: the same type on both sides is one thing, named as it was.
    expect(
      dataSummary([pick("tasks", "write", "core.task")], "", undefined, held),
    ).toBe("Read and edit tasks");
  });
});
