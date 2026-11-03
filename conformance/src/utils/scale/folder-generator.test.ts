import { describe, expect, it } from "vitest";
import { folderNote, folderNoteTitle } from "./folder-generator.js";

describe("the generated notes folder", () => {
  it("makes the same note every time", () => {
    expect(folderNote(37)).toEqual(folderNote(37));
  });

  it("puts notes in nested area and topic folders with a title in the name", () => {
    const note = folderNote(12);
    expect(note.path).toMatch(/^[A-Za-z]+\/Topic \d\d\/.+ f12\.md$/);
    expect(note.text.startsWith(`# ${folderNoteTitle(12)}\n`)).toBe(true);
    expect(note.path.endsWith(`${folderNoteTitle(12)}.md`)).toBe(true);
  });

  it("gives every note its own path and title", () => {
    const paths = new Set<string>();
    const titles = new Set<string>();
    for (let n = 1; n <= 2_000; n++) {
      paths.add(folderNote(n).path.toLowerCase());
      titles.add(folderNoteTitle(n));
    }
    expect(paths.size).toBe(2_000);
    expect(titles.size).toBe(2_000);
  });

  it("links to earlier notes by title, about one and a half a note, and never to a later one", () => {
    let linkCount = 0;
    const total = 1_000;
    for (let n = 1; n <= total; n++) {
      const links = [...folderNote(n).text.matchAll(/\[\[([^\]]+)\]\]/g)];
      linkCount += links.length;
      for (const link of links) {
        const target = /f(\d+)$/.exec(link[1] ?? "");
        expect(target, `link in note ${n}`).not.toBeNull();
        expect(Number(target?.[1])).toBeLessThan(n);
        expect(link[1]).toBe(folderNoteTitle(Number(target?.[1])));
      }
    }
    expect(linkCount / total).toBeGreaterThan(1);
    expect(linkCount / total).toBeLessThan(2);
  });

  it("has some task lists and carries no personal detail", () => {
    let tasks = 0;
    for (let n = 1; n <= 200; n++) {
      const { text } = folderNote(n);
      if (text.includes("- [ ] ")) tasks++;
      expect(text).not.toMatch(/@|\/Users\/|\/home\//);
    }
    expect(tasks).toBeGreaterThan(10);
  });
});
