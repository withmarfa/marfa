/**
 * A deterministic notes folder shaped like a real one: Markdown notes in
 * nested area and topic folders that link to each other with `[[wikilinks]]`
 * and hold the odd task list. The same position always makes the same note.
 * Nothing in it is personal.
 *
 * A title ends in `f<position>`, so no note's title is another's, and none is
 * the title of an item `generator.ts` seeds, which would make a link
 * ambiguous. Attachments are left out: they are blobs, which the booted
 * server may have no store for.
 */

const WORDS = (
  "marfa note idea plan draft review sync folder device server rust swift " +
  "connector budget memory speed light reliable design decision ticket epic " +
  "garden kitchen travel book film music photo walk river city friend family " +
  "meeting call email invoice tax health run sleep coffee tea letter project"
).split(" ");

const AREAS = [
  "Work",
  "Home",
  "Reading",
  "Travel",
  "Health",
  "Money",
  "Projects",
  "Journal",
] as const;

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, low: number, high: number) =>
  low + Math.floor(r() * (high - low + 1));

function sentence(r: () => number, words: number): string {
  const text = Array.from(
    { length: words },
    () => WORDS[Math.floor(r() * WORDS.length)],
  ).join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function folderNoteTitle(n: number): string {
  const r = rng(n * 31);
  return `${sentence(r, int(r, 2, 5)).slice(0, -1)} f${n}`;
}

export interface FolderNote {
  /** Relative to the folder's root, with `/` between its parts. */
  path: string;
  text: string;
}

/** The note at position `n`, from 1. */
export function folderNote(n: number): FolderNote {
  const r = rng(n);
  const area = AREAS[n % AREAS.length];
  const topic = `Topic ${String(n % 40).padStart(2, "0")}`;
  const lines = [`# ${folderNoteTitle(n)}`, ""];
  for (let p = int(r, 1, 6); p > 0; p--) {
    let paragraph = Array.from({ length: int(r, 1, 4) }, () =>
      sentence(r, int(r, 6, 16)),
    ).join(" ");
    if (r() < 0.4 && n > 1) {
      paragraph += ` See [[${folderNoteTitle(int(r, 1, n - 1))}]].`;
    }
    lines.push(paragraph, "");
  }
  if (r() < 0.25) {
    lines.push(`- [ ] ${sentence(r, 5)}`, `- [x] ${sentence(r, 4)}`, "");
  }
  return {
    path: `${area}/${topic}/${folderNoteTitle(n)}.md`,
    text: lines.join("\n"),
  };
}
