import { z } from "zod";
import type { ItemState } from "./types.js";

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
  required?: boolean;
  enum_values?: string[];
  items_type?: string;
}

/** A complete type schema — the data contract for a Myme type. */
export interface TypeSchema {
  id: string;
  parent?: string;
  label: string;
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

// Auto-generated from @mymehq/types JSON schemas — do not edit manually.
// Generated at: 2026-04-03T06:15:30.930Z
// Run `pnpm generate` in the types repo to regenerate.

const coreBookmark: TypeSchema = {
  id: "core.bookmark",
  label: "Bookmark",
  version: 1,
  fields: {
    url: { type: "url" },
    body: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    format: { type: "enum", enum_values: ["plaintext", "markdown", "html"] },
    source_url: { type: "url" },
    source_title: { type: "string" },
    author: { type: "string" },
    published_at: { type: "datetime" },
    image_url: { type: "url" },
    language: { type: "string" },
    notes: { type: "string" },
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
    title: { type: "string", required: true },
    description: { type: "string" },
    body: { type: "string" },
    format: { type: "enum", enum_values: ["plaintext", "markdown", "html"] },
    image_url: { type: "url" },
    notes: { type: "string" },
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
    name: { type: "string", required: true },
    url: { type: "url" },
    description: { type: "string" },
    email: { type: "email" },
    phone: { type: "string" },
    place: { type: "string" },
    image_url: { type: "url" },
    legal_name: { type: "string" },
    founded: { type: "date" },
    notes: { type: "string" },
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
    title: { type: "string", required: true },
    description: { type: "string" },
    starts_at: { type: "datetime" },
    ends_at: { type: "datetime" },
    duration: { type: "number" },
    place: { type: "string" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    url: { type: "url" },
    precision: { type: "enum", enum_values: ["year", "month", "day", "time"] },
    status: { type: "string" },
    notes: { type: "string" },
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
    blob_ref: { type: "string", required: true },
    mime_type: { type: "string", required: true },
    title: { type: "string" },
    description: { type: "string" },
    url: { type: "url" },
    source_url: { type: "url" },
    author: { type: "string" },
    language: { type: "string" },
    notes: { type: "string" },
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
    body: { type: "string", required: true },
    sender: { type: "string" },
    recipients: { type: "array", items_type: "string" },
    subject: { type: "string" },
    cc: { type: "array", items_type: "string" },
    bcc: { type: "array", items_type: "string" },
    format: { type: "enum", enum_values: ["plaintext", "markdown", "html"] },
    url: { type: "url" },
    notes: { type: "string" },
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
    body: { type: "string", required: true },
    title: { type: "string" },
    format: { type: "enum", enum_values: ["plaintext", "markdown", "html"] },
    language: { type: "string" },
    notes: { type: "string" },
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
    title: { type: "string", required: true },
    description: { type: "string" },
    body: { type: "string" },
    format: { type: "enum", enum_values: ["plaintext", "markdown", "html"] },
    due_at: { type: "datetime" },
    starts_at: { type: "datetime" },
    completed_at: { type: "datetime" },
    status: { type: "string" },
    priority: {
      type: "enum",
      enum_values: ["low", "medium", "high", "urgent"],
    },
    place: { type: "string" },
    precision: { type: "enum", enum_values: ["year", "month", "day", "time"] },
    url: { type: "url" },
    notes: { type: "string" },
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
    title: { type: "string", required: true },
    body: { type: "string" },
    author: { type: "string" },
    url: { type: "url" },
    format: { type: "enum", enum_values: ["plaintext", "markdown", "html"] },
    description: { type: "string" },
    publisher: { type: "string" },
    published_at: { type: "datetime" },
    image_url: { type: "url" },
    language: { type: "string" },
    notes: { type: "string" },
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
    given_name: { type: "string" },
    family_name: { type: "string" },
    middle_name: { type: "string" },
    prefix: { type: "string" },
    suffix: { type: "string" },
    nickname: { type: "string" },
    organization: { type: "string" },
    job_title: { type: "string" },
    department: { type: "string" },
    birthday: { type: "date" },
    pronouns: { type: "string" },
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
    street_address: { type: "string" },
    locality: { type: "string" },
    region: { type: "string" },
    postal_code: { type: "string" },
    country: { type: "string" },
    timezone: { type: "string" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    altitude: { type: "number" },
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
    duration: { type: "number", required: true },
    language: { type: "string" },
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
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    latitude: { type: "number" },
    longitude: { type: "number" },
    altitude: { type: "number" },
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
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    duration: { type: "number", required: true },
    latitude: { type: "number" },
    longitude: { type: "number" },
    altitude: { type: "number" },
    language: { type: "string" },
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
    release_type: { type: "string" },
    num_tracks: { type: "integer" },
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
    body: { type: "string", required: true },
    section: { type: "string" },
    word_count: { type: "integer" },
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
    isbn: { type: "string" },
    page_count: { type: "integer" },
    edition: { type: "string" },
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
    duration: { type: "number" },
    director: { type: "string" },
    content_rating: { type: "string" },
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
    episode_number: { type: "integer" },
    season_number: { type: "integer" },
    duration: { type: "number" },
    episode_type: { type: "string" },
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
    season_count: { type: "integer" },
    episode_count: { type: "integer" },
    status: { type: "string" },
    network: { type: "string" },
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
    duration: { type: "number" },
    isrc: { type: "string" },
    album: { type: "string" },
    track_number: { type: "integer" },
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
    episode_number: { type: "integer" },
    season_number: { type: "integer" },
    duration: { type: "number" },
    director: { type: "string" },
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

/** The type registry — all registered type schemas indexed by type identifier. */
export const TYPE_REGISTRY: ReadonlyMap<string, TypeSchema> = new Map(
  ALL_TYPES.map((schema) => [schema.id, schema]),
);

/** Returns the type schema for the given type identifier, or undefined. */
export function getTypeSchema(typeId: string): TypeSchema | undefined {
  return TYPE_REGISTRY.get(typeId);
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
