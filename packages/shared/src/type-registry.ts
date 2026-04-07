import { z } from "zod";
import type { ItemState } from "./types.js";
import { isValidTypeIdentifier } from "./validation.js";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Supported field types in a type schema. */
export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "url"
  | "email"
  | "datetime"
  | "date"
  | "enum"
  | "array"
  | "object";

/** Defines a single field within a type schema. */
export interface FieldDefinition {
  type: FieldType;
  description?: string;
  required?: boolean;
  enum_values?: string[];
  items_type?: string;
}

/** A complete type schema — the data contract for a Myme type. */
export interface TypeSchema {
  id: string;
  parent?: string;
  label?: string;
  description?: string;
  version: number;
  fields: Record<string, FieldDefinition>;
  states: ItemState[];
  default_state: ItemState;
  transitions: Record<string, ItemState[]>;
}

// ---------------------------------------------------------------------------
// Universal fields (available on every type)
// ---------------------------------------------------------------------------

const UNIVERSAL_FIELDS: Record<string, FieldDefinition> = {
  attachments: { type: "array", items_type: "object" },
  links: { type: "array", items_type: "string" },
};
// Auto-generated from @myme/types JSON schemas — do not edit manually.
// Generated at: 2026-04-03T20:01:30.422Z
// Run `pnpm generate` in the types repo to regenerate.

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

// Internal mutable map — exposed as ReadonlyMap to prevent accidental mutation.
const _registry = new Map<string, TypeSchema>(
  ALL_TYPES.map((schema) => [schema.id, schema]),
);

/** The type registry — all registered type schemas indexed by type identifier. */
export const TYPE_REGISTRY: ReadonlyMap<string, TypeSchema> = _registry;

/** Returns the type schema for the given type identifier, or undefined. */
export function getTypeSchema(typeId: string): TypeSchema | undefined {
  return _registry.get(typeId);
}

/** Returns true if the type identifier belongs to the core namespace. */
export function isCoreType(id: string): boolean {
  return id.startsWith("core.");
}

/** Registers a type schema into the in-memory registry. Clears the zod cache. */
export function registerTypeSchema(schema: TypeSchema): void {
  _registry.set(schema.id, schema);
  zodSchemaCache.delete(schema.id);
}

/** Removes a type schema from the in-memory registry. Clears the zod cache. */
export function unregisterTypeSchema(id: string): void {
  _registry.delete(id);
  zodSchemaCache.delete(id);
}

/**
 * Returns the fully resolved fields for a type, including inherited parent
 * fields and universal fields (attachments, links).
 *
 * Subtype fields override parent fields of the same name.
 */
export function getResolvedFields(
  typeId: string,
): Record<string, FieldDefinition> | undefined {
  const schema = TYPE_REGISTRY.get(typeId);
  if (!schema) return undefined;

  const fields: Record<string, FieldDefinition> = { ...UNIVERSAL_FIELDS };

  // Collect the inheritance chain (parent first, then child)
  const chain: TypeSchema[] = [];
  let current: TypeSchema | undefined = schema;
  while (current) {
    chain.unshift(current);
    current = current.parent ? TYPE_REGISTRY.get(current.parent) : undefined;
  }

  // Merge fields — later entries override earlier ones
  for (const ancestor of chain) {
    Object.assign(fields, ancestor.fields);
  }

  return fields;
}

/** Returns true if typeId is a subtype of (or equal to) parentId. */
export function isSubtypeOf(typeId: string, parentId: string): boolean {
  if (typeId === parentId) return true;
  let current = TYPE_REGISTRY.get(typeId);
  while (current?.parent) {
    if (current.parent === parentId) return true;
    current = TYPE_REGISTRY.get(current.parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation — Zod schema generation from field definitions
// ---------------------------------------------------------------------------

function fieldToZod(field: FieldDefinition): z.ZodType {
  let schema: z.ZodType;

  switch (field.type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "url":
      schema = z.url();
      break;
    case "email":
      schema = z.email();
      break;
    case "datetime":
      schema = z.string();
      break;
    case "date":
      schema = z.string();
      break;
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        schema = z.enum(field.enum_values as [string, ...string[]]);
      } else {
        schema = z.string();
      }
      break;
    case "array":
      schema = z.array(z.unknown());
      break;
    case "object":
      schema = z.record(z.string(), z.unknown());
      break;
  }

  return field.required ? schema : schema.optional();
}

// Cache generated Zod schemas to avoid re-creation on every validation call.
const zodSchemaCache = new Map<string, z.ZodType>();

function getZodSchema(typeId: string): z.ZodType | undefined {
  const cached = zodSchemaCache.get(typeId);
  if (cached) return cached;

  const fields = getResolvedFields(typeId);
  if (!fields) return undefined;

  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    shape[name] = fieldToZod(field);
  }

  const schema = z.looseObject(shape);
  zodSchemaCache.set(typeId, schema);
  return schema;
}

/** Validation result for property validation. */
export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; errors: { field: string; message: string }[] };

/**
 * Validates item properties against the type schema.
 * Standard fields are validated; custom fields are passed through.
 */
export function validateProperties(
  typeId: string,
  properties: Record<string, unknown>,
): ValidationResult {
  const schema = getZodSchema(typeId);
  if (!schema) {
    return {
      success: false,
      errors: [{ field: "_type", message: `Unknown type: ${typeId}` }],
    };
  }

  const result = schema.safeParse(properties);
  if (result.success) {
    return {
      success: true,
      data: result.data as Record<string, unknown>,
    };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "_root",
    message: issue.message,
  }));
  return { success: false, errors };
}

// ---------------------------------------------------------------------------
// State transition validation
// ---------------------------------------------------------------------------

/**
 * Validates whether a state transition is allowed for the given type.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateTransition(
  typeId: string,
  currentState: ItemState,
  nextState: ItemState,
): string | null {
  const schema = TYPE_REGISTRY.get(typeId);
  if (!schema) {
    return `Unknown type: ${typeId}`;
  }

  if (!schema.states.includes(currentState)) {
    return `Invalid current state "${currentState}" for type ${typeId}`;
  }

  if (!schema.states.includes(nextState)) {
    return `Invalid target state "${nextState}" for type ${typeId}`;
  }

  const allowed = schema.transitions[currentState];
  if (!allowed?.includes(nextState)) {
    return `Transition from "${currentState}" to "${nextState}" is not allowed for type ${typeId}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Type schema validation — validates the shape of a TypeSchema object
// ---------------------------------------------------------------------------

/**
 * Validates whether an input object is a valid TypeSchema.
 * Returns a ValidationResult with either the parsed schema or field errors.
 */
/** Result of validating a type schema. */
export type TypeSchemaValidationResult =
  | { success: true; data: TypeSchema }
  | { success: false; errors: { field: string; message: string }[] };

export function validateTypeSchema(input: unknown): TypeSchemaValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      success: false,
      errors: [{ field: "_root", message: "Expected an object" }],
    };
  }

  const obj = input as Record<string, unknown>;
  const errors: { field: string; message: string }[] = [];

  // id
  if (typeof obj.id !== "string" || !isValidTypeIdentifier(obj.id)) {
    errors.push({
      field: "id",
      message: "Required valid type identifier (dot-notation, e.g. acme.deal)",
    });
  }

  // label (optional — defaults to type id)
  if (obj.label !== undefined && typeof obj.label !== "string") {
    errors.push({ field: "label", message: "Must be a string" });
  }

  // version (optional — defaults to 1)
  if (obj.version !== undefined) {
    if (
      typeof obj.version !== "number" ||
      !Number.isInteger(obj.version) ||
      obj.version < 1
    ) {
      errors.push({ field: "version", message: "Must be a positive integer" });
    }
  }

  // fields
  if (typeof obj.fields !== "object" || obj.fields === null) {
    errors.push({ field: "fields", message: "Required object" });
  } else {
    const fields = obj.fields as Record<string, unknown>;
    for (const [name, def] of Object.entries(fields)) {
      if (typeof def !== "object" || def === null) {
        errors.push({
          field: `fields.${name}`,
          message: "Field definition must be an object",
        });
        continue;
      }
      const fd = def as Record<string, unknown>;
      if (typeof fd.type !== "string" || fd.type.length === 0) {
        errors.push({
          field: `fields.${name}.type`,
          message: "Field type is required and must be a non-empty string",
        });
      }
      if (fd.type === "enum") {
        if (!Array.isArray(fd.enum_values)) {
          errors.push({
            field: `fields.${name}.enum_values`,
            message: "Enum fields require an enum_values array",
          });
        } else if (
          !fd.enum_values.every((v: unknown) => typeof v === "string")
        ) {
          errors.push({
            field: `fields.${name}.enum_values`,
            message: "Enum values must be strings",
          });
        }
      }
    }
  }

  // states (custom types can define their own states)
  if (!Array.isArray(obj.states) || obj.states.length === 0) {
    errors.push({ field: "states", message: "Required non-empty array" });
  } else {
    for (const s of obj.states) {
      if (typeof s !== "string" || s.length === 0) {
        errors.push({
          field: "states",
          message: `Invalid state "${String(s)}". Must be a non-empty string`,
        });
      }
    }
  }

  // default_state
  if (
    typeof obj.default_state !== "string" ||
    (Array.isArray(obj.states) &&
      !(obj.states as string[]).includes(obj.default_state))
  ) {
    errors.push({
      field: "default_state",
      message: "Must be one of the defined states",
    });
  }

  // transitions
  if (typeof obj.transitions !== "object" || obj.transitions === null) {
    errors.push({ field: "transitions", message: "Required object" });
  } else if (Array.isArray(obj.states)) {
    const states = obj.states as string[];
    const transitions = obj.transitions as Record<string, unknown>;
    for (const [from, toList] of Object.entries(transitions)) {
      if (!states.includes(from)) {
        errors.push({
          field: `transitions.${from}`,
          message: `Key "${from}" is not a valid state`,
        });
      }
      if (!Array.isArray(toList)) {
        errors.push({
          field: `transitions.${from}`,
          message: "Must be an array of states",
        });
      } else {
        for (const to of toList) {
          if (!states.includes(to as string)) {
            errors.push({
              field: `transitions.${from}`,
              message: `Target "${String(to)}" is not a valid state`,
            });
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const schema: TypeSchema = {
    id: obj.id as string,
    label: typeof obj.label === "string" ? obj.label : undefined,
    version: typeof obj.version === "number" ? obj.version : 1,
    fields: obj.fields as Record<string, FieldDefinition>,
    states: obj.states as ItemState[],
    default_state: obj.default_state as ItemState,
    transitions: obj.transitions as Record<string, ItemState[]>,
  };
  if (typeof obj.description === "string") {
    schema.description = obj.description;
  }
  if (typeof obj.parent === "string") {
    schema.parent = obj.parent;
  }

  return { success: true, data: schema };
}
