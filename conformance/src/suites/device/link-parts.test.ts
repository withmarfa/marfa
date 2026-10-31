import { afterEach, describe, expect, it } from "vitest";
import type { CliDevice } from "../../device/cli-adapter.js";
import type {
  Draft,
  LinkCandidates,
  LinkParts,
  Outcome,
} from "../../device/protocol.js";
import { hydratedHarness, startHarness, type Harness } from "./harness.js";

/**
 * "An app reads a link's parts and what it could name from the core."
 *
 * An editor highlights a link's name, heading and alias where they sit in its
 * text, and offers the items a link could name, without a parser of its own.
 * Both are read from the copy alone: the scripted server answers nothing, and
 * the harness throws at `stop` if the device asks it anything.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusal));
  return outcome.value;
}

async function parts(device: CliDevice, text: string): Promise<LinkParts[]> {
  return value(await device.linkParts(text));
}

async function create(device: CliDevice, draft: Draft): Promise<string> {
  const queued = value(await device.create(draft));
  if (queued.item_id === null || queued.item_id === undefined) {
    throw new Error(
      `the create answered no item id: ${JSON.stringify(queued)}`,
    );
  }
  return queued.item_id;
}

async function note(device: CliDevice, title: string): Promise<string> {
  return create(device, { type: "core.note", properties: { title } });
}

async function candidates(
  device: CliDevice,
  targets: string[],
  item?: string,
): Promise<LinkCandidates[]> {
  return value(await device.linkCandidates(targets, item));
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe("a link's parts", () => {
  it("splits a link into its name, heading and alias, placed in UTF-16 code units", async () => {
    harness = await startHarness("link-parts-split");
    // The emoji is two UTF-16 code units, and the accent is a combining mark.
    const text = "\u{1F600} [[ Plan #Goals | the plan ]] [[Café|x]] [[#Local]]";
    const found = await parts(harness.device, text);
    expect(found.map((link) => link.text)).toEqual([
      "[[ Plan #Goals | the plan ]]",
      "[[Café|x]]",
      "[[#Local]]",
    ]);
    for (const link of found) {
      expect(text.slice(link.start, link.end)).toBe(link.text);
      for (const part of [link.name, link.heading, link.alias]) {
        if (part !== null)
          expect(text.slice(part.start, part.end)).toBe(part.text);
      }
    }
    expect(found[0]).toMatchObject({
      target: "Plan #Goals | the plan",
      name: { text: "Plan" },
      heading: { text: "Goals" },
      alias: { text: "the plan" },
    });
    expect(found[1]).toMatchObject({
      name: { text: "Café" },
      heading: null,
      alias: { text: "x" },
    });
    // A link to a heading of the same text names nothing, and is still a link
    // an editor shows.
    expect(found[2]).toMatchObject({
      name: { text: "" },
      heading: { text: "Local" },
    });
  });

  it("reads the alias as everything after a bar that comes before any hash", async () => {
    harness = await startHarness("link-parts-alias-first");
    const [link] = await parts(harness.device, "[[Plan|C# notes]]");
    expect(link).toMatchObject({
      name: { text: "Plan" },
      heading: null,
      alias: { text: "C# notes" },
    });
  });

  it("reads a link in code, a comment or an embed as text", async () => {
    harness = await startHarness("link-parts-code");
    const text = [
      "`[[span]]` and ![[embed.png]] and %%[[hidden]]%% and <!-- [[gone]] -->",
      "```",
      "[[fenced]]",
      "```",
      "[[shown]]",
    ].join("\n");
    expect(
      (await parts(harness.device, text)).map((link) => link.text),
    ).toEqual(["[[shown]]"]);
  });

  it("closes a link at the last opening on its line, so an unclosed one takes nothing after it", async () => {
    harness = await startHarness("link-parts-unclosed");
    const names = async (text: string) =>
      (await parts(harness!.device, text)).map((link) => link.name.text);
    expect(await names("[[open\n[[next]]")).toEqual(["next"]);
    expect(await names("[[outer [[inner]] after")).toEqual(["inner"]);
    expect(await names("[[unclosed and [[a]] then [[b]] and [[a]]")).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(await names("[[a]]]] and [[[b]]")).toEqual(["a", "[b"]);
  });

  it("reads a body's edges by the same bounds, so an unclosed link takes nothing after it", async () => {
    harness = await hydratedHarness("link-bounds-body");
    const { device } = harness;
    const first = await note(device, "First");
    const second = await note(device, "Second");
    const host = await create(device, {
      type: "core.note",
      properties: {
        title: "Host",
        body: `[[open\n[[${first}]] and [[outer [[${second}]] after`,
      },
    });
    const links = value(await device.bodyLinks(host)).links;
    expect(links.map((link) => [link.text, link.target])).toEqual([
      [`[[${first}]]`, { state: "item", id: first }],
      [`[[${second}]]`, { state: "item", id: second }],
    ]);
    const edges = value(await device.queue())
      .filter((write) => write.kind === "create_edge" && write.item_id === host)
      .map((write) => write.target_id);
    expect(sorted(edges as string[])).toEqual(sorted([first, second]));
  });

  it("finds the brackets outside code but takes the name with the code in it", async () => {
    harness = await startHarness("link-parts-code-inside");
    const found = await parts(harness.device, "[[a `b` c]] [[d `]]` e|f]]");
    expect(found.map((link) => [link.name.text, link.alias?.text])).toEqual([
      ["a `b` c", undefined],
      ["d `]]` e", "f"],
    ]);
  });

  it("reads a blank pair of brackets as no link", async () => {
    harness = await startHarness("link-parts-blank");
    expect(await parts(harness.device, "[[ ]] [[]] [[x]]")).toHaveLength(1);
  });

  it("keeps a backslash as part of the text", async () => {
    harness = await startHarness("link-parts-backslash");
    const found = await parts(harness.device, "\\[[escaped]] [[x\\]]");
    expect(found.map((link) => link.name.text)).toEqual(["escaped", "x\\"]);
  });

  it("reads a long text with many unclosed links", async () => {
    harness = await startHarness("link-parts-long");
    const text = `${"[[".repeat(20_000)} ${"[[a]] ".repeat(10_000)}`;
    const found = await parts(harness.device, text);
    expect(found).toHaveLength(10_000);
  });
});

describe("a link's candidates", () => {
  it("lists every item a name answers to, without regard to case or Unicode form", async () => {
    harness = await hydratedHarness("link-candidates-fold");
    const { device } = harness;
    const plans = sorted([
      await note(device, "Plan"),
      await note(device, "PLAN"),
    ]);
    const composed = await note(device, "Café");
    const bare = await note(device, "Cafe");
    const spaced = await note(device, "Two  spaces");

    const [plan, decomposed, cafe, single, untrimmed] = await candidates(
      device,
      ["plan", "Café", "cafe", "Two spaces", "  Two  spaces | shown"],
    );
    expect(plan).toMatchObject({
      target: "plan",
      state: "ambiguous",
      item: null,
    });
    expect(sorted(plan.candidates)).toEqual(plans);
    // A held item that alone answers is still unresolved: the copy holds a
    // slice, and the server's lookup decides.
    expect(decomposed).toMatchObject({
      state: "unresolved",
      candidates: [composed],
    });
    expect(cafe).toMatchObject({ state: "unresolved", candidates: [bare] });
    // Inner whitespace is part of the name.
    expect(single).toMatchObject({ state: "unresolved", candidates: [] });
    expect(untrimmed).toMatchObject({
      state: "unresolved",
      candidates: [spaced],
    });
  });

  it("lists both readings where the whole text and the name before a mark each answer", async () => {
    harness = await hydratedHarness("link-candidates-whole");
    const { device } = harness;
    const both = sorted([await note(device, "C"), await note(device, "C#")]);
    const [answer] = await candidates(device, ["C#"]);
    expect(answer.state).toBe("ambiguous");
    expect(sorted(answer.candidates)).toEqual(both);
  });

  it("binds an id the copy holds, and lists no item the copy does not hold", async () => {
    harness = await hydratedHarness("link-candidates-id");
    const { device } = harness;
    const held = await note(device, "Held");
    const absent = "0198a3c2-6f00-7000-8000-00000000abcd";
    const [byId, byAbsentId, byTitle] = await candidates(device, [
      held,
      absent,
      "Only on the server",
    ]);
    expect(byId).toMatchObject({
      state: "bound",
      item: held,
      candidates: [held],
    });
    expect(byAbsentId).toMatchObject({
      state: "unresolved",
      item: null,
      candidates: [],
    });
    expect(byTitle).toMatchObject({
      state: "unresolved",
      item: null,
      candidates: [],
    });
  });

  it("never lists an item in the bin", async () => {
    harness = await hydratedHarness("link-candidates-bin");
    const { device } = harness;
    // The witness: the same title answers while the item is outside the bin.
    const active = await note(device, "Filed");
    expect((await candidates(device, ["Filed"]))[0].candidates).toEqual([
      active,
    ]);
    const binned = await create(device, {
      type: "core.note",
      properties: { title: "Binned" },
      state: "trashed",
    });
    const [byTitle, byId] = await candidates(device, ["Binned", binned]);
    expect(byTitle).toMatchObject({ state: "unresolved", candidates: [] });
    expect(byId).toMatchObject({ state: "unresolved", candidates: [] });
  });

  it("answers a link in an item's body as saving it there would bind it", async () => {
    harness = await hydratedHarness("link-candidates-body");
    const { device } = harness;
    const goals = await note(device, "Goals");
    const host = await create(device, {
      type: "core.note",
      properties: { title: "Host", body: "" },
      edges: { references: [goals] },
    });
    // The witness: without the host, a lone held title is unresolved.
    expect((await candidates(device, ["Goals"]))[0].state).toBe("unresolved");
    const [answer] = await candidates(device, ["goals|the goals"], host);
    expect(answer).toMatchObject({
      state: "bound",
      item: goals,
      candidates: [goals],
    });

    const refused = await device.linkCandidates(
      ["Goals"],
      "0198a3c2-6f00-7000-8000-00000000abcd",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("not_found");
  });
});
