// Auto-generated from core/*.json — do not edit manually.
// Run `pnpm --filter @mymehq/types generate` to regenerate.

import type { TypeSchema } from "../src/schema-types.js";

const coreBookmark: TypeSchema = {
  id: "core.bookmark",
  label: "Bookmark",
  description:
    "Content you captured from elsewhere — a saved URL, a highlight, an excerpt, a clipped paragraph.",
  version: 1,
  fields: {
    url: { type: "url", description: "The saved URL" },
    body: {
      type: "string",
      description: "Captured text (a highlight, excerpt, or clipping)",
    },
    title: { type: "string", description: "Title of the saved content" },
    description: { type: "string", description: "Summary" },
    source_url: {
      type: "url",
      description: "Where the content was sourced from",
    },
    source_title: { type: "string", description: "Title of the source" },
    author: { type: "string", description: "Who created the original content" },
    published_at: {
      type: "datetime",
      description: "When the original content was published",
    },
    image_url: { type: "url", description: "Preview image" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreEntity: TypeSchema = {
  id: "core.entity",
  label: "Entity",
  description:
    "A non-person entity — a company, band, team, charity, brand, school.",
  version: 1,
  fields: {
    name: { type: "string", description: "Display name", required: true },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "What the entity is" },
    email: { type: "email", description: "Contact email" },
    phone: { type: "string", description: "Contact phone (E.164 recommended)" },
    place: { type: "string", description: "Location (human-readable address)" },
    image_url: { type: "url", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "name" },
};

const coreEvent: TypeSchema = {
  id: "core.event",
  label: "Event",
  description: "Something that happens at a time.",
  version: 1,
  fields: {
    title: { type: "string", description: "Event name", required: true },
    description: { type: "string", description: "Event details" },
    starts_at: { type: "datetime", description: "Start time" },
    ends_at: { type: "datetime", description: "End time" },
    duration: { type: "number", description: "Duration in seconds" },
    place: { type: "string", description: "Location" },
    latitude: { type: "number", description: "Venue latitude" },
    longitude: { type: "number", description: "Venue longitude" },
    url: { type: "url", description: "Event link" },
    precision: {
      type: "enum",
      description: "Temporal precision",
      enum_values: ["year", "month", "day", "time"],
    },
    status: {
      type: "string",
      description:
        "Recommended values: tentative, confirmed, cancelled, rescheduled",
    },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

const coreFile: TypeSchema = {
  id: "core.file",
  label: "File",
  description:
    "A file or binary reference — the generic fallback for non-media files.",
  version: 1,
  fields: {
    blob_ref: {
      type: "string",
      description: "Reference to the binary content (sha256:<hex>)",
      required: true,
    },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title" },
};

const coreHighlight: TypeSchema = {
  id: "core.highlight",
  label: "Highlight",
  description:
    "A user's engagement with content — the highlighted passage plus optional annotation. The canonical relationship (what was highlighted) is carried by an annotates edge; the moment of highlighting is the system timestamp.",
  version: 1,
  fields: {
    text: {
      type: "string",
      description: "The highlighted passage",
      required: true,
    },
    note: { type: "string", description: "User annotation on the highlight" },
    color: {
      type: "enum",
      description: "Highlight colour",
      enum_values: ["yellow", "blue", "green", "pink", "orange", "purple"],
    },
    locator_type: {
      type: "enum",
      description: "How start_location / end_location are interpreted",
      enum_values: ["offset", "page", "time", "cfi", "order", "none"],
    },
    start_location: {
      type: "string",
      description: "Start locator, typed by locator_type",
    },
    end_location: {
      type: "string",
      description: "End locator, typed by locator_type",
    },
  },
  display_hints: { title_field: "text", body_field: "note" },
};

const coreMedia: TypeSchema = {
  id: "core.media",
  label: "Media",
  description:
    "Content produced by someone that the user engages with — a film, podcast, book, article, song, show.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreNote: TypeSchema = {
  id: "core.note",
  label: "Note",
  description: "Text content you created.",
  version: 1,
  fields: {
    body: { type: "string", description: "The note text", required: true },
    title: { type: "string", description: "Heading or title" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreTask: TypeSchema = {
  id: "core.task",
  label: "Task",
  description: "Something to be done.",
  version: 1,
  fields: {
    title: { type: "string", description: "What needs doing", required: true },
    description: { type: "string", description: "Brief context" },
    body: { type: "string", description: "Detailed description" },
    due_at: { type: "datetime", description: "Deadline" },
    starts_at: { type: "datetime", description: "When to start" },
    completed_at: { type: "datetime", description: "When completed" },
    status: {
      type: "string",
      description:
        "Recommended values: pending, in_progress, completed, cancelled",
    },
    priority: {
      type: "enum",
      description: "Task priority",
      enum_values: ["low", "medium", "high", "urgent"],
    },
    place: { type: "string", description: "Location" },
    precision: {
      type: "enum",
      description: "Temporal precision",
      enum_values: ["year", "month", "day", "time"],
    },
    url: { type: "url", description: "Related link" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreEntityPerson: TypeSchema = {
  id: "core.entity.person",
  parent: "core.entity",
  label: "Person",
  description:
    "Contact information for an individual. Inherits all core.entity fields.",
  version: 1,
  fields: {
    name: { type: "string", description: "Display name", required: true },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "What the entity is" },
    email: { type: "email", description: "Contact email" },
    phone: { type: "string", description: "Contact phone (E.164 recommended)" },
    place: { type: "string", description: "Location (human-readable address)" },
    image_url: { type: "url", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Personal annotations" },
    given_name: { type: "string", description: "Given (first) name" },
    family_name: { type: "string", description: "Family (last) name" },
    middle_name: { type: "string", description: "Middle or additional name" },
    prefix: { type: "string", description: "Honorific prefix (Dr, Mr, Prof)" },
    suffix: { type: "string", description: "Honorific suffix (PhD, Jr, OBE)" },
    nickname: { type: "string", description: "Familiar name or alias" },
    organization: { type: "string", description: "Associated organization" },
    job_title: { type: "string", description: "Position or job title" },
    department: {
      type: "string",
      description: "Department within the organization",
    },
    birthday: { type: "date", description: "Date of birth (ISO 8601)" },
    pronouns: { type: "string", description: "Pronouns" },
  },
  display_hints: { title_field: "name" },
};

const coreEntityPlace: TypeSchema = {
  id: "core.entity.place",
  parent: "core.entity",
  label: "Place",
  description: "A location or venue. Inherits all core.entity fields.",
  version: 1,
  fields: {
    name: { type: "string", description: "Display name", required: true },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "What the entity is" },
    email: { type: "email", description: "Contact email" },
    phone: { type: "string", description: "Contact phone (E.164 recommended)" },
    place: { type: "string", description: "Location (human-readable address)" },
    image_url: { type: "url", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Personal annotations" },
    street_address: { type: "string", description: "Street line" },
    locality: { type: "string", description: "City or town" },
    region: { type: "string", description: "State, province, or county" },
    postal_code: { type: "string", description: "Postcode or ZIP code" },
    country: { type: "string", description: "ISO 3166-1 alpha-2 country code" },
    timezone: { type: "string", description: "IANA timezone" },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: {
      type: "number",
      description: "Altitude in meters above sea level",
    },
  },
  display_hints: { title_field: "name" },
};

const coreFileAudio: TypeSchema = {
  id: "core.file.audio",
  parent: "core.file",
  label: "Audio",
  description:
    "Recordings, music files, voice memos. Inherits all core.file fields.",
  version: 1,
  fields: {
    blob_ref: {
      type: "string",
      description: "Reference to the binary content (sha256:<hex>)",
      required: true,
    },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: {
      type: "string",
      description: "BCP 47 language code (for spoken content)",
    },
    notes: { type: "string", description: "Personal annotations" },
    duration: {
      type: "number",
      description: "Length in seconds",
      required: true,
    },
  },
  display_hints: { title_field: "title" },
};

const coreFileImage: TypeSchema = {
  id: "core.file.image",
  parent: "core.file",
  label: "Image",
  description: "Photos, screenshots, diagrams. Inherits all core.file fields.",
  version: 1,
  fields: {
    blob_ref: {
      type: "string",
      description: "Reference to the binary content (sha256:<hex>)",
      required: true,
    },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    width: { type: "integer", description: "Width in pixels", required: true },
    height: {
      type: "integer",
      description: "Height in pixels",
      required: true,
    },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters" },
  },
  display_hints: { title_field: "title" },
};

const coreFileVideo: TypeSchema = {
  id: "core.file.video",
  parent: "core.file",
  label: "Video",
  description: "Video files. Inherits all core.file fields.",
  version: 1,
  fields: {
    blob_ref: {
      type: "string",
      description: "Reference to the binary content (sha256:<hex>)",
      required: true,
    },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: {
      type: "string",
      description: "BCP 47 language code (for spoken content)",
    },
    notes: { type: "string", description: "Personal annotations" },
    width: { type: "integer", description: "Width in pixels", required: true },
    height: {
      type: "integer",
      description: "Height in pixels",
      required: true,
    },
    duration: {
      type: "number",
      description: "Length in seconds",
      required: true,
    },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters" },
  },
  display_hints: { title_field: "title" },
};

const coreMediaAlbum: TypeSchema = {
  id: "core.media.album",
  parent: "core.media",
  label: "Album",
  description: "An album. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    release_type: {
      type: "string",
      description: "Recommended values: album, ep, single",
    },
    num_tracks: { type: "integer", description: "Total track count" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaArticle: TypeSchema = {
  id: "core.media.article",
  parent: "core.media",
  label: "Article",
  description: "An article. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "The article text", required: true },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    section: { type: "string", description: "Section of the publication" },
    word_count: { type: "integer", description: "Word count" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaBook: TypeSchema = {
  id: "core.media.book",
  parent: "core.media",
  label: "Book",
  description: "A book. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    isbn: {
      type: "string",
      description: "International Standard Book Number (ISO 2108)",
    },
    page_count: { type: "integer", description: "Number of pages" },
    edition: { type: "string", description: "Edition designation" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaFilm: TypeSchema = {
  id: "core.media.film",
  parent: "core.media",
  label: "Film",
  description: "A film. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    duration: { type: "number", description: "Runtime in seconds" },
    director: { type: "string", description: "Primary director" },
    content_rating: {
      type: "string",
      description: "Age or content classification",
    },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaPodcast: TypeSchema = {
  id: "core.media.podcast",
  parent: "core.media",
  label: "Podcast",
  description: "A podcast episode. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    episode_number: { type: "integer", description: "Position in the show" },
    season_number: { type: "integer", description: "Which season" },
    duration: { type: "number", description: "Episode length in seconds" },
    episode_type: {
      type: "string",
      description: "Recommended values: full, trailer, bonus",
    },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaSeries: TypeSchema = {
  id: "core.media.series",
  parent: "core.media",
  label: "Series",
  description: "A TV show or series. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    season_count: { type: "integer", description: "Number of seasons" },
    episode_count: {
      type: "integer",
      description: "Total episodes across all seasons",
    },
    status: {
      type: "string",
      description: "Recommended values: ongoing, ended, cancelled",
    },
    network: {
      type: "string",
      description: "Broadcasting network or streaming service",
    },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaSong: TypeSchema = {
  id: "core.media.song",
  parent: "core.media",
  label: "Song",
  description: "A song. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    duration: { type: "number", description: "Track length in seconds" },
    isrc: {
      type: "string",
      description: "International Standard Recording Code (ISO 3901)",
    },
    album: { type: "string", description: "Containing album name" },
    track_number: { type: "integer", description: "Position within the album" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

const coreMediaTvEpisode: TypeSchema = {
  id: "core.media.tv_episode",
  parent: "core.media",
  label: "TV Episode",
  description: "A TV episode. Inherits all core.media fields.",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: {
      type: "datetime",
      description: "When originally published or released",
    },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
    episode_number: {
      type: "integer",
      description: "Position within the season",
    },
    season_number: { type: "integer", description: "Which season" },
    duration: { type: "number", description: "Episode runtime in seconds" },
    director: { type: "string", description: "Episode director" },
  },
  display_hints: { title_field: "title", body_field: "body" },
};

export const ALL_TYPES: TypeSchema[] = [
  coreBookmark,
  coreEntity,
  coreEvent,
  coreFile,
  coreHighlight,
  coreMedia,
  coreNote,
  coreTask,
  coreEntityPerson,
  coreEntityPlace,
  coreFileAudio,
  coreFileImage,
  coreFileVideo,
  coreMediaAlbum,
  coreMediaArticle,
  coreMediaBook,
  coreMediaFilm,
  coreMediaPodcast,
  coreMediaSeries,
  coreMediaSong,
  coreMediaTvEpisode,
];
