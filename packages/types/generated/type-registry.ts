// Auto-generated from core/*.json and core/system/*.json — do not edit manually.
// Run `pnpm --filter @withmarfa/types generate` to regenerate.

import type { TypeSchema } from "../src/schema-types.js";

const coreBookmark: TypeSchema = {
  id: "core.bookmark",
  label: "Bookmark",
  description: "Content you captured from elsewhere — a saved URL, a highlight, an excerpt, a clipped paragraph.",
  version: 0,
  fields: {
    url: { type: "url", description: "The saved URL" },
    body: { type: "string", description: "Captured text (a highlight, excerpt, or clipping)" },
    title: { type: "string", description: "Title of the saved content" },
    description: { type: "string", description: "Summary" },
    source_url: { type: "url", description: "Where the content was sourced from" },
    source_title: { type: "string", description: "Title of the source" },
    author: { type: "string", description: "Who created the original content" },
    published_at: { type: "datetime", description: "When the original content was published" },
    image_url: { type: "url", description: "Preview image" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreEntity: TypeSchema = {
  id: "core.entity",
  label: "Entity",
  description: "A non-person entity — a company, band, team, charity, brand, school.",
  version: 0,
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
  merge_policy: { default: "last_writer_wins" },
};

const coreEvent: TypeSchema = {
  id: "core.event",
  label: "Event",
  description: "Something that happens at a time.",
  version: 0,
  fields: {
    title: { type: "string", description: "Event name", required: true },
    description: { type: "string", description: "Event details" },
    starts_at: { type: "datetime", description: "The instant the event starts, ISO 8601. An instant carries no zone of its own however it is written; the timezone field is what anchors the event's wall-clock hour." },
    ends_at: { type: "datetime", description: "The instant the event ends, ISO 8601." },
    duration: { type: "number", description: "Duration in seconds; the length of each occurrence of a series that states no ends_at." },
    place: { type: "string", description: "Location" },
    latitude: { type: "number", description: "Venue latitude" },
    longitude: { type: "number", description: "Venue longitude" },
    url: { type: "url", description: "Event link" },
    precision: { type: "enum", description: "How much of the start instant is actually known, for an event dated from memory or from a source that gave only a year. Narrows an instant that exists; it does not say the event has no instant, which is what all_day says.", enum_values: ["year", "month", "day", "time"] },
    status: { type: "string", description: "Recommended values: tentative, confirmed, canceled, rescheduled" },
    notes: { type: "string", description: "Personal annotations" },
    recurrence: { type: "array", description: "RFC 5545 recurrence property lines (RRULE, RDATE, EXDATE). Present on the series itself; occurrences are computed from it at read time rather than stored, starting with starts_at itself. A write is refused when a line cannot be read or is not applied (EXRULE, an RDATE period), when the rule names no date that exists after the start, or when it produces no occurrence within the bound a read unfolds a rule to.", items_type: "string" },
    all_day: { type: "boolean", description: "True when the event occupies whole days rather than a span of time. A whole day has no instant, so a reader must take the calendar date from starts_at read in timezone and never re-derive it in the reader's own zone, which is how an all-day event ends up on the wrong day for anyone further west. Absent or false means the event has real start and end instants." },
    timezone: { type: "string", description: "IANA time zone the event's schedule keeps its wall-clock hour in, e.g. Europe/Berlin. Stored times stay instants; a recurring series expands in this zone so occurrences keep their local hour across a daylight-saving transition. Absent means the rule advances in UTC. This is the start zone: an event that ends somewhere else states that in end_timezone. A write is refused unless the zone database resolves it as a named zone." },
    end_timezone: { type: "string", description: "IANA time zone the event ends in, when that differs from timezone — a flight lands in a zone it did not depart from, and both ends are wall-clock facts a person reads off a ticket. Absent means the event ends in the zone it started in. Recurrence expands in timezone only; this field never anchors a rule. A write is refused unless the zone database resolves it as a named zone." },
    original_starts_at: { type: "datetime", description: "For an event that replaces one occurrence of a series, the start instant of the occurrence it replaces. Its series is named by a parent-of edge." },
  },
  display_hints: { title_field: "title", body_field: "description" },
  merge_policy: { fields: { notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreFile: TypeSchema = {
  id: "core.file",
  label: "File",
  description: "A file or binary reference — the generic fallback for non-media files.",
  version: 0,
  fields: {
    blob_ref: { type: "string", description: "Reference to the binary content (sha256:<hex>)", required: true },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    extracted_text: { type: "string", description: "Machine-extracted text content of the referenced blob (server enrichment: document text or image OCR)" },
    executable: { type: "boolean", description: "Whether the file may be run as a program; absent means it may not" },
  },
  display_hints: { title_field: "title" },
  merge_policy: { default: "last_writer_wins" },
};

const coreHighlight: TypeSchema = {
  id: "core.highlight",
  label: "Highlight",
  description: "A user's engagement with content — the highlighted passage plus optional annotation. The canonical relationship (what was highlighted) is carried by a references edge; the moment of highlighting is the item's own `occurred_at`.",
  version: 0,
  fields: {
    text: { type: "string", description: "The highlighted passage", required: true },
    note: { type: "string", description: "User annotation on the highlight" },
    color: { type: "enum", description: "Highlight color", enum_values: ["yellow", "blue", "green", "pink", "orange", "purple"] },
    locator_type: { type: "enum", description: "How start_location / end_location are interpreted", enum_values: ["offset", "page", "time", "cfi", "order", "none"] },
    start_location: { type: "string", description: "Start locator, typed by locator_type" },
    end_location: { type: "string", description: "End locator, typed by locator_type" },
  },
  display_hints: { title_field: "text", body_field: "note" },
  merge_policy: { fields: { note: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMedia: TypeSchema = {
  id: "core.media",
  label: "Media",
  description: "Content produced by someone that the user engages with — a film, podcast, book, article, song, show.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMessage: TypeSchema = {
  id: "core.message",
  label: "Message",
  description: "A light, cross-platform message. Threading is edge-based via in-thread; reply trees via parent-of. Tool-specific richness lives in app namespaces.",
  version: 0,
  fields: {
    body: { type: "string", description: "The message text", required: true },
    from: { type: "string", description: "Sender identifier — format-agnostic (phone number, email, handle, etc.)", required: true },
    to: { type: "array", description: "Recipient identifiers — same format-agnostic shape as from", items_type: "string" },
  },
  display_hints: { body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreNote: TypeSchema = {
  id: "core.note",
  label: "Note",
  description: "Text content you created.",
  version: 0,
  fields: {
    body: { type: "string", description: "The note text", required: true },
    title: { type: "string", description: "Heading or title" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreTask: TypeSchema = {
  id: "core.task",
  label: "Task",
  description: "Something to be done.",
  version: 0,
  fields: {
    title: { type: "string", description: "What needs doing", required: true },
    description: { type: "string", description: "Brief context" },
    body: { type: "string", description: "Detailed description" },
    due_at: { type: "datetime", description: "Deadline" },
    starts_at: { type: "datetime", description: "When to start" },
    completed_at: { type: "datetime", description: "When completed" },
    status: { type: "string", description: "Recommended values: pending, in_progress, completed, canceled" },
    priority: { type: "enum", description: "Task priority", enum_values: ["low", "medium", "high", "urgent"] },
    place: { type: "string", description: "Location" },
    precision: { type: "enum", description: "Temporal precision", enum_values: ["year", "month", "day", "time"] },
    url: { type: "url", description: "Related link" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreEntityPerson: TypeSchema = {
  id: "core.entity.person",
  parent: "core.entity",
  label: "Person",
  description: "Contact information for an individual. Inherits all core.entity fields.",
  version: 0,
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
    department: { type: "string", description: "Department within the organization" },
    birthday: { type: "date", description: "Date of birth (ISO 8601)" },
    pronouns: { type: "string", description: "Pronouns" },
  },
  display_hints: { title_field: "name" },
  merge_policy: { default: "last_writer_wins" },
};

const coreEntityPlace: TypeSchema = {
  id: "core.entity.place",
  parent: "core.entity",
  label: "Place",
  description: "A location or venue. Inherits all core.entity fields.",
  version: 0,
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
    country: { type: "string", description: "ISO 3166-1 alpha-2 country code", format: "iso3166" },
    timezone: { type: "string", description: "IANA timezone" },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters above sea level" },
  },
  display_hints: { title_field: "name" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileAudio: TypeSchema = {
  id: "core.file.audio",
  parent: "core.file",
  label: "Audio",
  description: "Recordings, music files, voice memos. Inherits all core.file fields.",
  version: 0,
  fields: {
    blob_ref: { type: "string", description: "Reference to the binary content (sha256:<hex>)", required: true },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: { type: "string", description: "BCP 47 language code (for spoken content)", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    extracted_text: { type: "string", description: "Machine-extracted text content of the referenced blob (server enrichment: document text or image OCR)" },
    executable: { type: "boolean", description: "Whether the file may be run as a program; absent means it may not" },
    duration: { type: "number", description: "Length in seconds (server enrichment: derived from the file when the client does not supply it)" },
  },
  display_hints: { title_field: "title" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileImage: TypeSchema = {
  id: "core.file.image",
  parent: "core.file",
  label: "Image",
  description: "Photos, screenshots, diagrams. Inherits all core.file fields.",
  version: 0,
  fields: {
    blob_ref: { type: "string", description: "Reference to the binary content (sha256:<hex>)", required: true },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    extracted_text: { type: "string", description: "Machine-extracted text content of the referenced blob (server enrichment: document text or image OCR)" },
    executable: { type: "boolean", description: "Whether the file may be run as a program; absent means it may not" },
    width: { type: "integer", description: "Width in pixels (server enrichment: derived from the file when the client does not supply it)" },
    height: { type: "integer", description: "Height in pixels (server enrichment: derived from the file when the client does not supply it)" },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters" },
  },
  display_hints: { title_field: "title" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileVideo: TypeSchema = {
  id: "core.file.video",
  parent: "core.file",
  label: "Video",
  description: "Video files. Inherits all core.file fields.",
  version: 0,
  fields: {
    blob_ref: { type: "string", description: "Reference to the binary content (sha256:<hex>)", required: true },
    mime_type: { type: "string", description: "MIME type", required: true },
    title: { type: "string", description: "Filename or title" },
    description: { type: "string", description: "What the file contains" },
    url: { type: "url", description: "Web address" },
    source_url: { type: "url", description: "Where the file was sourced from" },
    author: { type: "string", description: "Who created the file" },
    language: { type: "string", description: "BCP 47 language code (for spoken content)", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    extracted_text: { type: "string", description: "Machine-extracted text content of the referenced blob (server enrichment: document text or image OCR)" },
    executable: { type: "boolean", description: "Whether the file may be run as a program; absent means it may not" },
    width: { type: "integer", description: "Width in pixels (server enrichment: derived from the file when the client does not supply it)" },
    height: { type: "integer", description: "Height in pixels (server enrichment: derived from the file when the client does not supply it)" },
    duration: { type: "number", description: "Length in seconds (server enrichment: derived from the file when the client does not supply it)" },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters" },
  },
  display_hints: { title_field: "title" },
  merge_policy: { default: "last_writer_wins" },
};

const coreMediaAlbum: TypeSchema = {
  id: "core.media.album",
  parent: "core.media",
  label: "Album",
  description: "An album. Inherits all core.media fields.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    release_type: { type: "string", description: "Recommended values: album, ep, single" },
    num_tracks: { type: "integer", description: "Total track count" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
  roles: ["container"],
};

const coreMediaArticle: TypeSchema = {
  id: "core.media.article",
  parent: "core.media",
  label: "Article",
  description: "An article. Inherits all core.media fields.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "The article text", required: true },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    section: { type: "string", description: "Section of the publication" },
    word_count: { type: "integer", description: "Word count" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaBook: TypeSchema = {
  id: "core.media.book",
  parent: "core.media",
  label: "Book",
  description: "A book. Inherits all core.media fields.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    isbn: { type: "string", description: "International Standard Book Number (ISO 2108)" },
    page_count: { type: "integer", description: "Number of pages" },
    edition: { type: "string", description: "Edition designation" },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaEpisode: TypeSchema = {
  id: "core.media.episode",
  parent: "core.media",
  label: "Episode",
  description: "Any member of an ongoing series: a TV episode, a podcast episode, one part of a serial. Inherits all core.media fields. Joins its series through the in-collection edge, so one episode can belong to several series and outlives any of them.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    medium: { type: "enum", description: "What the episode is made of.", enum_values: ["tv", "podcast", "radio", "video", "mixed"] },
    season_number: { type: "integer", description: "Which season, where the series has them" },
    episode_number: { type: "integer", description: "Position within the season, or within the series when unseasoned" },
    duration: { type: "number", description: "Runtime in seconds" },
    media_url: { type: "url", description: "Direct address of the media file itself: an episode's audio or video enclosure, a track's audio file, a film's stream. Distinct from url, which is the web page about the work." },
    mime_type: { type: "string", description: "MIME type of the resource at media_url, such as audio/mpeg or video/mp4. Describes what media_url points at, not what this item is." },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaFilm: TypeSchema = {
  id: "core.media.film",
  parent: "core.media",
  label: "Film",
  description: "A film. Inherits all core.media fields.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    duration: { type: "number", description: "Runtime in seconds" },
    director: { type: "string", description: "Primary director" },
    content_rating: { type: "string", description: "Age or content classification" },
    media_url: { type: "url", description: "Direct address of the media file itself: an episode's audio or video enclosure, a track's audio file, a film's stream. Distinct from url, which is the web page about the work." },
    mime_type: { type: "string", description: "MIME type of the resource at media_url, such as audio/mpeg or video/mp4. Describes what media_url points at, not what this item is." },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaSeries: TypeSchema = {
  id: "core.media.series",
  parent: "core.media",
  label: "Series",
  description: "Any ongoing media container: a TV show, a podcast, a radio serial, a video series. Inherits all core.media fields. Episodes join it through the in-collection edge; containment is never part of a type name.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    medium: { type: "enum", description: "What the series is made of.", enum_values: ["tv", "podcast", "radio", "video", "mixed"] },
    status: { type: "enum", description: "Whether the series is still producing new members.", enum_values: ["ongoing", "ended", "canceled"] },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
  roles: ["container"],
};

const coreMediaSong: TypeSchema = {
  id: "core.media.song",
  parent: "core.media",
  label: "Song",
  description: "A song. Inherits all core.media fields.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the work", required: true },
    body: { type: "string", description: "Text content or description" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
    duration: { type: "number", description: "Track length in seconds" },
    isrc: { type: "string", description: "International Standard Recording Code (ISO 3901)" },
    album: { type: "string", description: "Containing album name" },
    track_number: { type: "integer", description: "Position within the album" },
    media_url: { type: "url", description: "Direct address of the media file itself: an episode's audio or video enclosure, a track's audio file, a film's stream. Distinct from url, which is the web page about the work." },
    mime_type: { type: "string", description: "MIME type of the resource at media_url, such as audio/mpeg or video/mp4. Describes what media_url points at, not what this item is." },
  },
  display_hints: { title_field: "title", body_field: "body" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

export const ALL_TYPES: TypeSchema[] = [
  coreBookmark,
  coreEntity,
  coreEvent,
  coreFile,
  coreHighlight,
  coreMedia,
  coreMessage,
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
  coreMediaEpisode,
  coreMediaFilm,
  coreMediaSeries,
  coreMediaSong,
];

const systemConnection: TypeSchema = {
  id: "system.connection",
  label: "Connection",
  description: "An OAuth client this user has authorized, written when the user approves the client's consent or device sign-in. `kind` is `app`. Lifecycle bounded to active | revoked. Has no tier.",
  version: 0,
  fields: {
    kind: { type: "enum", description: "Discriminator for connection variant", required: true, enum_values: ["app"] },
    client_id: { type: "string", description: "OAuth client identifier" },
    scopes: { type: "array", description: "Granted scope strings", items_type: "string" },
    status: { type: "enum", description: "Lifecycle status", required: true, enum_values: ["active", "revoked"] },
    granted_at: { type: "datetime", description: "When the grant was approved", required: true },
    last_used_at: { type: "datetime", description: "Most recent successful use of any token issued under this grant" },
    revoked_at: { type: "datetime", description: "When the grant was revoked, if any" },
  },
};

const systemFolder: TypeSchema = {
  id: "system.folder",
  label: "Folder",
  description: "A folder's settings, held here and shared by every machine bound to the folder; each machine chooses only the directory. The settings are written only through `/folders`: created, changed at a version, and revoked. Lifecycle bounded to active | revoked. Has no tier.",
  version: 0,
  fields: {
    title: { type: "string", description: "The folder's name", required: true },
    search: { type: "object", description: "Which items the folder holds. `types`: type identifiers, each with its subtypes; empty or absent holds every type the folder's key reads. `tier`: `library` or `feed`, the one tier the folder holds; absent is `library`. `state`: `active`, `archived` or both; absent is both. `filter`: an expression in the listing grammar's `filter`. `beneath`: an item id; the item and everything under it by `parent-of`." },
    defaults: { type: "object", description: "What a new file takes where its frontmatter leaves a blank, never applied to an edit: `type`, `tier`, `properties`, `tags`, and `edges` as a map from edge type to item ids, each edge running from the new file to the item named except `parent-of`, which runs from the item named so the new file is its child; a folder whose search follows an edge gives every new file that edge." },
    include: { type: "array", description: "Paths the folder takes, as gitignore patterns relative to its root; empty or absent takes every path. A dot-led path is taken only where a line names a dot-led name on its way, and no line reaches what the built-in lists name", items_type: "string" },
    ignore: { type: "array", description: "Paths the folder leaves alone, as gitignore patterns relative to its root, winning over `include`; the built-in lists, of files a machine or an editor writes for itself and of secrets, apply whatever either list says", items_type: "string" },
    first_placement: { type: "object", description: "Where a new item of a type made elsewhere first appears: a map from type identifier to a directory relative to the folder's root. Placement only; it never decides membership." },
    removal_threshold: { type: "object", description: "When a removal pauses for confirmation: more than `files` files and more than `fraction` of the folder at once. Absent members are 10 and 0.25." },
    revoked_at: { type: "datetime", description: "When the folder was revoked" },
  },
};

export const ALL_SYSTEM_TYPES: TypeSchema[] = [
  systemConnection,
  systemFolder,
];

export const ALL_TYPE_IDS = [
  "core.bookmark",
  "core.entity",
  "core.entity.person",
  "core.entity.place",
  "core.event",
  "core.file",
  "core.file.audio",
  "core.file.image",
  "core.file.video",
  "core.highlight",
  "core.media",
  "core.media.album",
  "core.media.article",
  "core.media.book",
  "core.media.episode",
  "core.media.film",
  "core.media.series",
  "core.media.song",
  "core.message",
  "core.note",
  "core.task",
  "system.connection",
  "system.folder",
] as const;

export type PlatformTypeId = (typeof ALL_TYPE_IDS)[number];

export const SHIPPED_TYPE_SHAPES = {
  "core.bookmark": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "source_title": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "title": {
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "version": 0
  },
  "core.entity": {
    "display_hints": {
      "title_field": "name"
    },
    "fields": {
      "description": {
        "type": "string"
      },
      "email": {
        "type": "email"
      },
      "founded": {
        "type": "date"
      },
      "image_url": {
        "type": "url"
      },
      "legal_name": {
        "type": "string"
      },
      "name": {
        "required": true,
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "phone": {
        "type": "string"
      },
      "place": {
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "version": 0
  },
  "core.entity.person": {
    "display_hints": {
      "title_field": "name"
    },
    "fields": {
      "birthday": {
        "type": "date"
      },
      "department": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "email": {
        "type": "email"
      },
      "family_name": {
        "type": "string"
      },
      "founded": {
        "type": "date"
      },
      "given_name": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "job_title": {
        "type": "string"
      },
      "legal_name": {
        "type": "string"
      },
      "middle_name": {
        "type": "string"
      },
      "name": {
        "required": true,
        "type": "string"
      },
      "nickname": {
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "organization": {
        "type": "string"
      },
      "phone": {
        "type": "string"
      },
      "place": {
        "type": "string"
      },
      "prefix": {
        "type": "string"
      },
      "pronouns": {
        "type": "string"
      },
      "suffix": {
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "parent": "core.entity",
    "version": 0
  },
  "core.entity.place": {
    "display_hints": {
      "title_field": "name"
    },
    "fields": {
      "altitude": {
        "type": "number"
      },
      "country": {
        "format": "iso3166",
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "email": {
        "type": "email"
      },
      "founded": {
        "type": "date"
      },
      "image_url": {
        "type": "url"
      },
      "latitude": {
        "type": "number"
      },
      "legal_name": {
        "type": "string"
      },
      "locality": {
        "type": "string"
      },
      "longitude": {
        "type": "number"
      },
      "name": {
        "required": true,
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "phone": {
        "type": "string"
      },
      "place": {
        "type": "string"
      },
      "postal_code": {
        "type": "string"
      },
      "region": {
        "type": "string"
      },
      "street_address": {
        "type": "string"
      },
      "timezone": {
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "parent": "core.entity",
    "version": 0
  },
  "core.event": {
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "all_day": {
        "type": "boolean"
      },
      "description": {
        "type": "string"
      },
      "duration": {
        "type": "number"
      },
      "end_timezone": {
        "type": "string"
      },
      "ends_at": {
        "type": "datetime"
      },
      "latitude": {
        "type": "number"
      },
      "longitude": {
        "type": "number"
      },
      "notes": {
        "type": "string"
      },
      "original_starts_at": {
        "type": "datetime"
      },
      "place": {
        "type": "string"
      },
      "precision": {
        "enum_values": [
          "year",
          "month",
          "day",
          "time"
        ],
        "type": "enum"
      },
      "recurrence": {
        "items_type": "string",
        "type": "array"
      },
      "starts_at": {
        "type": "datetime"
      },
      "status": {
        "type": "string"
      },
      "timezone": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "notes": "keep_both_copies"
      }
    },
    "version": 0
  },
  "core.file": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "blob_ref": {
        "required": true,
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "executable": {
        "type": "boolean"
      },
      "extracted_text": {
        "type": "string"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "mime_type": {
        "required": true,
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "title": {
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "version": 0
  },
  "core.file.audio": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "blob_ref": {
        "required": true,
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "duration": {
        "type": "number"
      },
      "executable": {
        "type": "boolean"
      },
      "extracted_text": {
        "type": "string"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "mime_type": {
        "required": true,
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "title": {
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "parent": "core.file",
    "version": 0
  },
  "core.file.image": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "altitude": {
        "type": "number"
      },
      "author": {
        "type": "string"
      },
      "blob_ref": {
        "required": true,
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "executable": {
        "type": "boolean"
      },
      "extracted_text": {
        "type": "string"
      },
      "height": {
        "type": "integer"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "latitude": {
        "type": "number"
      },
      "longitude": {
        "type": "number"
      },
      "mime_type": {
        "required": true,
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "title": {
        "type": "string"
      },
      "url": {
        "type": "url"
      },
      "width": {
        "type": "integer"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "parent": "core.file",
    "version": 0
  },
  "core.file.video": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "altitude": {
        "type": "number"
      },
      "author": {
        "type": "string"
      },
      "blob_ref": {
        "required": true,
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "duration": {
        "type": "number"
      },
      "executable": {
        "type": "boolean"
      },
      "extracted_text": {
        "type": "string"
      },
      "height": {
        "type": "integer"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "latitude": {
        "type": "number"
      },
      "longitude": {
        "type": "number"
      },
      "mime_type": {
        "required": true,
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "title": {
        "type": "string"
      },
      "url": {
        "type": "url"
      },
      "width": {
        "type": "integer"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "parent": "core.file",
    "version": 0
  },
  "core.highlight": {
    "display_hints": {
      "body_field": "note",
      "title_field": "text"
    },
    "fields": {
      "color": {
        "enum_values": [
          "yellow",
          "blue",
          "green",
          "pink",
          "orange",
          "purple"
        ],
        "type": "enum"
      },
      "end_location": {
        "type": "string"
      },
      "locator_type": {
        "enum_values": [
          "offset",
          "page",
          "time",
          "cfi",
          "order",
          "none"
        ],
        "type": "enum"
      },
      "note": {
        "type": "string"
      },
      "start_location": {
        "type": "string"
      },
      "text": {
        "required": true,
        "type": "string"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "note": "keep_both_copies"
      }
    },
    "version": 0
  },
  "core.media": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "version": 0
  },
  "core.media.album": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "num_tracks": {
        "type": "integer"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "release_type": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "roles": [
      "container"
    ],
    "version": 0
  },
  "core.media.article": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "required": true,
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "section": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      },
      "word_count": {
        "type": "integer"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "version": 0
  },
  "core.media.book": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "edition": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "isbn": {
        "type": "string"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "page_count": {
        "type": "integer"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "version": 0
  },
  "core.media.episode": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "duration": {
        "type": "number"
      },
      "episode_number": {
        "type": "integer"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "media_url": {
        "type": "url"
      },
      "medium": {
        "enum_values": [
          "tv",
          "podcast",
          "radio",
          "video",
          "mixed"
        ],
        "type": "enum"
      },
      "mime_type": {
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "season_number": {
        "type": "integer"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "version": 0
  },
  "core.media.film": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "content_rating": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "director": {
        "type": "string"
      },
      "duration": {
        "type": "number"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "media_url": {
        "type": "url"
      },
      "mime_type": {
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "version": 0
  },
  "core.media.series": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "image_url": {
        "type": "url"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "medium": {
        "enum_values": [
          "tv",
          "podcast",
          "radio",
          "video",
          "mixed"
        ],
        "type": "enum"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "status": {
        "enum_values": [
          "ongoing",
          "ended",
          "canceled"
        ],
        "type": "enum"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "roles": [
      "container"
    ],
    "version": 0
  },
  "core.media.song": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "album": {
        "type": "string"
      },
      "author": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "duration": {
        "type": "number"
      },
      "image_url": {
        "type": "url"
      },
      "isrc": {
        "type": "string"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "media_url": {
        "type": "url"
      },
      "mime_type": {
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "track_number": {
        "type": "integer"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "parent": "core.media",
    "version": 0
  },
  "core.message": {
    "display_hints": {
      "body_field": "body"
    },
    "fields": {
      "body": {
        "required": true,
        "type": "string"
      },
      "from": {
        "required": true,
        "type": "string"
      },
      "to": {
        "items_type": "string",
        "type": "array"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies"
      }
    },
    "version": 0
  },
  "core.note": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "body": {
        "required": true,
        "type": "string"
      },
      "language": {
        "format": "bcp47",
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "title": {
        "type": "string"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "version": 0
  },
  "core.task": {
    "display_hints": {
      "body_field": "body",
      "title_field": "title"
    },
    "fields": {
      "body": {
        "type": "string"
      },
      "completed_at": {
        "type": "datetime"
      },
      "description": {
        "type": "string"
      },
      "due_at": {
        "type": "datetime"
      },
      "notes": {
        "type": "string"
      },
      "place": {
        "type": "string"
      },
      "precision": {
        "enum_values": [
          "year",
          "month",
          "day",
          "time"
        ],
        "type": "enum"
      },
      "priority": {
        "enum_values": [
          "low",
          "medium",
          "high",
          "urgent"
        ],
        "type": "enum"
      },
      "starts_at": {
        "type": "datetime"
      },
      "status": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "type": "url"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins",
      "fields": {
        "body": "keep_both_copies",
        "notes": "keep_both_copies"
      }
    },
    "version": 0
  },
  "system.connection": {
    "fields": {
      "client_id": {
        "type": "string"
      },
      "granted_at": {
        "required": true,
        "type": "datetime"
      },
      "kind": {
        "enum_values": [
          "app"
        ],
        "required": true,
        "type": "enum"
      },
      "last_used_at": {
        "type": "datetime"
      },
      "revoked_at": {
        "type": "datetime"
      },
      "scopes": {
        "items_type": "string",
        "type": "array"
      },
      "status": {
        "enum_values": [
          "active",
          "revoked"
        ],
        "required": true,
        "type": "enum"
      }
    },
    "version": 0
  },
  "system.folder": {
    "fields": {
      "defaults": {
        "type": "object"
      },
      "first_placement": {
        "type": "object"
      },
      "ignore": {
        "items_type": "string",
        "type": "array"
      },
      "include": {
        "items_type": "string",
        "type": "array"
      },
      "removal_threshold": {
        "type": "object"
      },
      "revoked_at": {
        "type": "datetime"
      },
      "search": {
        "type": "object"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 0
  }
} as const;

