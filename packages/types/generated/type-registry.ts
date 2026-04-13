// Auto-generated from core/*.json — do not edit manually.
// Run `pnpm --filter @mymehq/types generate` to regenerate.

import type { TypeSchema, ItemState } from "../src/schema-types.js";

const coreBookmark: TypeSchema = {
  id: "core.bookmark",
  label: "Bookmark",
  version: 1,
  fields: {
    url: { type: "url", description: "The saved URL" },
    body: {
      type: "string",
      description: "Captured text (a highlight, excerpt, or clipping)",
    },
    title: { type: "string", description: "Title of the saved content" },
    description: { type: "string", description: "Summary" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreCollection: TypeSchema = {
  id: "core.collection",
  label: "Collection",
  version: 1,
  fields: {
    title: { type: "string", description: "Collection name", required: true },
    description: { type: "string", description: "What this collection is" },
    body: { type: "string", description: "Longer description" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
    image_url: { type: "url", description: "Cover image" },
    notes: { type: "string", description: "Personal annotations" },
  },
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "active" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreEntity: TypeSchema = {
  id: "core.entity",
  label: "Entity",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreEvent: TypeSchema = {
  id: "core.event",
  label: "Event",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreFile: TypeSchema = {
  id: "core.file",
  label: "File",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreMessage: TypeSchema = {
  id: "core.message",
  label: "Message",
  version: 1,
  fields: {
    body: { type: "string", description: "Message text", required: true },
    sender: { type: "string", description: "Who sent it" },
    recipients: {
      type: "array",
      description: "Primary recipients",
      items_type: "string",
    },
    subject: { type: "string", description: "Subject line" },
    cc: {
      type: "array",
      description: "Carbon copy recipients",
      items_type: "string",
    },
    bcc: {
      type: "array",
      description: "Blind carbon copy recipients",
      items_type: "string",
    },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
    url: { type: "url", description: "Link to the original message" },
    notes: { type: "string", description: "Personal annotations" },
  },
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreNote: TypeSchema = {
  id: "core.note",
  label: "Note",
  version: 1,
  fields: {
    body: { type: "string", description: "The note text", required: true },
    title: { type: "string", description: "Heading or title" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
    language: { type: "string", description: "BCP 47 language code" },
    notes: { type: "string", description: "Personal annotations" },
  },
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreTask: TypeSchema = {
  id: "core.task",
  label: "Task",
  version: 1,
  fields: {
    title: { type: "string", description: "What needs doing", required: true },
    description: { type: "string", description: "Brief context" },
    body: { type: "string", description: "Detailed description" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWork: TypeSchema = {
  id: "core.work",
  label: "Work",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreEntityPerson: TypeSchema = {
  id: "core.entity.person",
  parent: "core.entity",
  label: "Person",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreEntityPlace: TypeSchema = {
  id: "core.entity.place",
  parent: "core.entity",
  label: "Place",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreFileAudio: TypeSchema = {
  id: "core.file.audio",
  parent: "core.file",
  label: "Audio",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreFileImage: TypeSchema = {
  id: "core.file.image",
  parent: "core.file",
  label: "Image",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreFileVideo: TypeSchema = {
  id: "core.file.video",
  parent: "core.file",
  label: "Video",
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkAlbum: TypeSchema = {
  id: "core.work.album",
  parent: "core.work",
  label: "Album",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkArticle: TypeSchema = {
  id: "core.work.article",
  parent: "core.work",
  label: "Article",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "The article text", required: true },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkBook: TypeSchema = {
  id: "core.work.book",
  parent: "core.work",
  label: "Book",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkFilm: TypeSchema = {
  id: "core.work.film",
  parent: "core.work",
  label: "Film",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkPodcast: TypeSchema = {
  id: "core.work.podcast",
  parent: "core.work",
  label: "Podcast",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkSeries: TypeSchema = {
  id: "core.work.series",
  parent: "core.work",
  label: "Series",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkSong: TypeSchema = {
  id: "core.work.song",
  parent: "core.work",
  label: "Song",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

const coreWorkTvEpisode: TypeSchema = {
  id: "core.work.tv_episode",
  parent: "core.work",
  label: "TV Episode",
  version: 1,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    format: {
      type: "enum",
      description: "How to interpret body",
      enum_values: ["plaintext", "markdown", "html"],
    },
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
  states: ["new", "active", "archived", "trashed"] as ItemState[],
  default_state: "new" as ItemState,
  transitions: {
    new: ["active", "archived", "trashed"] as ItemState[],
    active: ["archived", "trashed"] as ItemState[],
    archived: ["active", "trashed"] as ItemState[],
    trashed: ["active"] as ItemState[],
  },
};

export const ALL_TYPES: TypeSchema[] = [
  coreBookmark,
  coreCollection,
  coreEntity,
  coreEvent,
  coreFile,
  coreMessage,
  coreNote,
  coreTask,
  coreWork,
  coreEntityPerson,
  coreEntityPlace,
  coreFileAudio,
  coreFileImage,
  coreFileVideo,
  coreWorkAlbum,
  coreWorkArticle,
  coreWorkBook,
  coreWorkFilm,
  coreWorkPodcast,
  coreWorkSeries,
  coreWorkSong,
  coreWorkTvEpisode,
];
