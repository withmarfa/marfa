import { v7 as uuidv7 } from "uuid";
import type { CreateItemInput } from "../client/api.js";

/**
 * Generate a UUIDv7 (time-sortable, no coordination needed).
 */
export function generateId(): string {
  return uuidv7();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function isoOffset(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function createItem(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return {
    type: "core.note",
    properties: {
      title: "Test item",
      body: "Created by the Marfa conformance suite.",
    },
    ...overrides,
  };
}

export function createNote(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.note",
    properties: {
      title: "Test Note",
      body: "This is a test note created by the Marfa conformance suite.",
    },
    ...overrides,
  });
}

/**
 * Create a core.highlight item. `text` is required; the other properties
 * are optional. The moment the highlight was made is the item's system
 * `timestamp`, not a `highlighted_at` property.
 */
export function createHighlight(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.highlight",
    properties: {
      text: "A memorable passage about distributed systems.",
      color: "yellow",
      locator_type: "offset",
      start_location: "100",
      end_location: "200",
    },
    ...overrides,
  });
}

export function createBookmark(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.bookmark",
    properties: {
      url: "https://example.com/article",
      title: "Distributed Systems for Fun and Profit",
      description: "An interesting article about distributed systems",
    },
    ...overrides,
  });
}

export function createTask(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.task",
    properties: {
      title: "Review pull request",
      description: "Check the conformance suite changes",
      status: "pending",
      priority: "medium",
    },
    ...overrides,
  });
}

/**
 * Create a `core.message` item. `body` and `from` are both required; `to` is
 * an optional array. Participant identifiers are format-agnostic strings — a
 * phone number, an email address, or a handle are all valid — so the generator
 * uses an email-shaped value only because it reads clearly, not because the
 * type constrains the format.
 */
export function createMessage(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.message",
    properties: {
      body: "Hey, the new conformance suite is looking great!",
      from: "alice@example.com",
      to: ["bob@example.com"],
    },
    ...overrides,
  });
}

export function createEvent(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.event",
    properties: {
      title: "Team standup",
      starts_at: isoNow(),
      place: "Conference room B",
    },
    ...overrides,
  });
}

export function createEntity(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.entity",
    properties: {
      name: "Acme Corp",
      description: "A test organization",
      url: "https://acme.example.com",
    },
    ...overrides,
  });
}

export function createPerson(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.entity.person",
    properties: {
      name: "Alice Smith",
      given_name: "Alice",
      family_name: "Smith",
      email: "alice@example.com",
      organization: "Acme Corp",
    },
    ...overrides,
  });
}

export function createPlace(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.entity.place",
    properties: {
      name: "The Ivy",
      place: "1-5 West Street, London WC2H 9NQ",
      latitude: 51.5114,
      longitude: -0.1272,
      country: "GB",
      locality: "London",
    },
    ...overrides,
  });
}

export function createWork(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media",
    properties: {
      title: "Designing Data-Intensive Applications",
      author: "Martin Kleppmann",
    },
    ...overrides,
  });
}

export function createBook(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.book",
    properties: {
      title: "Designing Data-Intensive Applications",
      author: "Martin Kleppmann",
      isbn: "978-1449373320",
      page_count: 616,
    },
    ...overrides,
  });
}

export function createArticle(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.article",
    properties: {
      title: "The future of distributed systems",
      body: "A deep dive into the latest trends in distributed computing.",
      author: "Jane Doe",
      word_count: 2500,
    },
    ...overrides,
  });
}

export function createFilm(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.film",
    properties: {
      title: "2001: A Space Odyssey",
      director: "Stanley Kubrick",
      duration: 8940,
      published_at: "1968-04-02T00:00:00.000Z",
    },
    ...overrides,
  });
}

export function createSong(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.song",
    properties: {
      title: "Bohemian Rhapsody",
      author: "Queen",
      duration: 354,
      album: "A Night at the Opera",
      track_number: 11,
    },
    ...overrides,
  });
}

export function createAlbum(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.album",
    properties: {
      title: "A Night at the Opera",
      author: "Queen",
      release_type: "album",
      num_tracks: 12,
    },
    ...overrides,
  });
}

/**
 * Create a series work item. A series carries no episode or season counts:
 * membership is an edge, so the counts are derived from the graph rather
 * than restated on the item, where they would drift the moment an episode
 * is added.
 */
export function createSeries(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.series",
    properties: {
      title: "The Wire",
      author: "David Simon",
      medium: "tv",
      status: "ended",
    },
    ...overrides,
  });
}

/**
 * Create an episode work item. One type covers every serial form (a
 * television episode, a podcast installment, one part of a radio serial),
 * distinguished by `medium` rather than by a type of its own. Override
 * `medium` to generate a fixture for a different form.
 */
export function createEpisode(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.media.episode",
    properties: {
      title: "The Target",
      medium: "tv",
      episode_number: 1,
      season_number: 1,
      duration: 3540,
    },
    ...overrides,
  });
}

export function createFile(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.file",
    properties: {
      blob_ref:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mime_type: "application/pdf",
      title: "Test document",
    },
    ...overrides,
  });
}

export function createImage(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.file.image",
    properties: {
      blob_ref:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mime_type: "image/jpeg",
      width: 1920,
      height: 1080,
    },
    ...overrides,
  });
}

export function createAudio(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.file.audio",
    properties: {
      blob_ref:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mime_type: "audio/mp3",
      duration: 180,
    },
    ...overrides,
  });
}

export function createVideo(
  overrides: Partial<CreateItemInput> = {},
): CreateItemInput {
  return createItem({
    type: "core.file.video",
    properties: {
      blob_ref:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mime_type: "video/mp4",
      width: 1920,
      height: 1080,
      duration: 600,
    },
    ...overrides,
  });
}
