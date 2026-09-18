import type { CreateItemInput } from "../client/api.js";
import {
  createNote,
  createBookmark,
  createTask,
  createEntity,
  createWork,
  createFile,
} from "./items.js";

export interface BulkOptions {
  tagRate?: number; // Fraction of items with tags (default 0.3)
  source?: string;
}

export interface BulkResult {
  items: CreateItemInput[];
  stats: {
    total: number;
    notes: number;
    bookmarks: number;
    tasks: number;
    entities: number;
    works: number;
    files: number;
    tagged: number;
  };
}

const SAMPLE_TAGS: string[] = [
  "work",
  "personal",
  "research",
  "learning",
  "starred",
  "archived",
  "pinned",
  "priority-high",
  "priority-medium",
  "priority-low",
];

/**
 * 40% notes, 20% bookmarks, 10% tasks, 10% entities, 10% works, 10% files, in
 * creation order. `bulk.test.ts` asserts the mix, so changing it here is a
 * two-file change.
 */
export function generateBulkItems(
  count: number,
  options: BulkOptions = {},
): BulkResult {
  const { tagRate = 0.3, source } = options;

  const items: CreateItemInput[] = [];
  const stats = {
    total: 0,
    notes: 0,
    bookmarks: 0,
    tasks: 0,
    entities: 0,
    works: 0,
    files: 0,
    tagged: 0,
  };

  for (let i = 0; i < count; i++) {
    const rand = Math.random();
    let item: CreateItemInput;
    if (rand < 0.4) {
      item = createNote();
      stats.notes++;
    } else if (rand < 0.6) {
      item = createBookmark();
      stats.bookmarks++;
    } else if (rand < 0.7) {
      item = createTask();
      stats.tasks++;
    } else if (rand < 0.8) {
      item = createEntity();
      stats.entities++;
    } else if (rand < 0.9) {
      item = createWork();
      stats.works++;
    } else {
      item = createFile();
      stats.files++;
    }

    if (source) {
      item.source = source;
      item.source_id = `bulk-${i}`;
    }

    const tags: string[] = [];
    if (Math.random() < tagRate) {
      const numTags = 1 + Math.floor(Math.random() * 3);
      for (let j = 0; j < numTags; j++) {
        const tag = SAMPLE_TAGS[Math.floor(Math.random() * SAMPLE_TAGS.length)];
        if (!tags.includes(tag)) {
          tags.push(tag);
        }
      }
      stats.tagged++;
    }

    if (tags.length > 0) {
      item.tags = tags;
    }

    items.push(item);
    stats.total++;
  }

  return { items, stats };
}

export function getScaleCount(scale: "small" | "medium" | "large"): number {
  switch (scale) {
    case "small":
      return 1_000;
    case "medium":
      return 10_000;
    case "large":
      return 100_000;
  }
}
