// Auto-generated from core/*.json, connectors/*.json and core/system/*.json — do not edit manually.
// Run `pnpm --filter @withmarfa/types generate` to regenerate.

import type { TypeSchema } from "../src/schema-types.js";

const coreBookmark: TypeSchema = {
  id: "core.bookmark",
  label: "Bookmark",
  description: "Content you captured from elsewhere — a saved URL, a highlight, an excerpt, a clipped paragraph.",
  version: 1,
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
  merge_policy: { default: "last_writer_wins" },
};

const coreEvent: TypeSchema = {
  id: "core.event",
  label: "Event",
  description: "Something that happens at a time.",
  version: 2,
  fields: {
    title: { type: "string", description: "Event name", required: true },
    description: { type: "string", description: "Event details" },
    starts_at: { type: "datetime", description: "The instant the event starts, ISO 8601. An instant carries no zone of its own however it is written; the timezone field is what anchors the event's wall-clock hour." },
    ends_at: { type: "datetime", description: "The instant the event ends, ISO 8601." },
    duration: { type: "number", description: "Duration in seconds" },
    place: { type: "string", description: "Location" },
    latitude: { type: "number", description: "Venue latitude" },
    longitude: { type: "number", description: "Venue longitude" },
    url: { type: "url", description: "Event link" },
    precision: { type: "enum", description: "How much of the start instant is actually known, for an event dated from memory or from a source that gave only a year. Narrows an instant that exists; it does not say the event has no instant, which is what all_day says.", enum_values: ["year", "month", "day", "time"] },
    status: { type: "string", description: "Recommended values: tentative, confirmed, canceled, rescheduled" },
    notes: { type: "string", description: "Personal annotations" },
    recurrence: { type: "array", description: "RFC 5545 recurrence property lines (RRULE, RDATE, EXDATE). Present on the series itself; occurrences are computed from it at read time rather than stored.", items_type: "string" },
    all_day: { type: "boolean", description: "True when the event occupies whole days rather than a span of time. A whole day has no instant, so a reader must take the calendar date from starts_at read in timezone and never re-derive it in the reader's own zone, which is how an all-day event ends up on the wrong day for anyone further west. Absent or false means the event has real start and end instants." },
    timezone: { type: "string", description: "IANA time zone the event's schedule keeps its wall-clock hour in, e.g. Europe/Berlin. Stored times stay instants; a recurring series expands in this zone so occurrences keep their local hour across a daylight-saving transition. Absent means the rule advances in UTC. This is the start zone: an event that ends somewhere else states that in end_timezone." },
    end_timezone: { type: "string", description: "IANA time zone the event ends in, when that differs from timezone — a flight lands in a zone it did not depart from, and both ends are wall-clock facts a person reads off a ticket. Absent means the event ends in the zone it started in. Recurrence expands in timezone only; this field never anchors a rule." },
    original_starts_at: { type: "datetime", description: "For an event that replaces one occurrence of a series, the start instant of the occurrence it replaces. Its series is named by a parent-of edge." },
  },
  display_hints: { title_field: "title", body_field: "description" },
  merge_policy: { fields: { notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreFile: TypeSchema = {
  id: "core.file",
  label: "File",
  description: "A file or binary reference — the generic fallback for non-media files.",
  version: 1,
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
  },
  display_hints: { title_field: "title" },
  merge_policy: { default: "last_writer_wins" },
};

const coreHighlight: TypeSchema = {
  id: "core.highlight",
  label: "Highlight",
  description: "A user's engagement with content — the highlighted passage plus optional annotation. The canonical relationship (what was highlighted) is carried by a references edge; the moment of highlighting is the item's own `occurred_at`.",
  version: 1,
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
  version: 1,
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
  version: 1,
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
  version: 1,
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
  version: 1,
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
  version: 2,
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
  version: 2,
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
  version: 2,
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
  version: 2,
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
  version: 1,
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
  version: 1,
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
  version: 2,
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
  version: 2,
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
  version: 4,
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
  version: 2,
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

const marfaCapturedEmail: TypeSchema = {
  id: "marfa.captured_email",
  label: "Captured Email",
  description: "An email captured by the marfa/inbox connector via Cloudflare Email Routing → Email Worker → webhook. Parsed MIME landed as a structured item. Not yet `compatible_with: core.note`, though it is shaped for it: a note requires `body`, and captures written before the handler always populated that field do not carry it. Claiming compatibility would require `body` here, and re-validating a merged property set is how `PATCH /items/:id` works — so the claim would make every one of those older captures permanently un-editable. It can be restored once those rows are backfilled. Attachment blob upload is not yet supported; v1 captures attachment metadata (filename, mime_type, size_bytes) only.",
  version: 1,
  fields: {
    from_address: { type: "string", description: "RFC 5321 envelope sender address, lower-cased (the `From:` header's address part).", required: true },
    from_name: { type: "string", description: "Display name from the `From:` header, if present." },
    to_address: { type: "string", description: "Address the email was delivered to (the connection's capture address — e.g. `capture@inbox.marfa.so`).", required: true },
    subject: { type: "string", description: "RFC 5322 `Subject:` header. Empty string when absent." },
    text_body: { type: "string", description: "Plain-text body. Either the `text/plain` MIME part directly, or downgraded from `text/html` when only HTML is present." },
    body: { type: "string", description: "Mirror of `text_body`, present so a generic note reader finds a body where it expects one. Always written (empty string when the email had no text part), which is what will eventually let this type claim `core.note` compatibility." },
    html_body: { type: "string", description: "HTML body (`text/html` MIME part). Captured verbatim; not sanitized on storage." },
    sent_at: { type: "datetime", description: "RFC 5322 `Date:` header, parsed to ISO 8601. The upstream-fidelity timestamp; distinct from Marfa's `created_at` which stamps the inbound-receipt time." },
    message_id: { type: "string", description: "RFC 5322 `Message-ID:` header (with the angle brackets). Used as the inbound-webhook `external_delivery_id` so a re-delivered email resolves to the same item. Mirrored to `source_id` at write time." },
    in_reply_to: { type: "string", description: "RFC 5322 `In-Reply-To:` header. Sets up thread inference for follow-up replies on the same conversation." },
    references: { type: "array", description: "RFC 5322 `References:` header, split on whitespace. Each entry a Message-ID of an ancestor in the conversation thread.", items_type: "string" },
    headers: { type: "object", description: "Selected subset of normalized lower-case header keys → values. Pruned at parse time to a documented allowlist (List-Id, List-Unsubscribe, X-Mailer, Reply-To, Return-Path); the raw header set is not retained to keep the item shape bounded." },
    attachments: { type: "array", description: "Per-attachment metadata `{ filename, mime_type, size_bytes }`. Blob upload is not yet supported — v1 captures metadata only. `blob_ref` is wired in a follow-on.", items_type: "object" },
  },
  display_hints: { title_field: "subject", body_field: "text_body" },
};

const raindropCollection: TypeSchema = {
  id: "raindrop.collection",
  label: "Raindrop Collection",
  description: "A Raindrop collection — a folder that groups raindrops (bookmarks). Collections nest via `parent_id` chains. Source-of-truth for collection metadata; raindrops link back via `collection_id` and a `parent-of` edge.",
  version: 1,
  fields: {
    title: { type: "string", description: "Collection name (maps to Raindrop `title`).", required: true },
    slug: { type: "string", description: "URL-safe slug (maps to Raindrop `slug`)." },
    parent_id: { type: "string", description: "External Raindrop id of the parent collection (when this collection is nested). Empty / unset at top level." },
    count: { type: "integer", description: "Number of raindrops in this collection at last sync." },
    cover: { type: "string", description: "Cover image URL (Raindrop ships one when set)." },
    expanded: { type: "boolean", description: "Whether the collection is expanded in Raindrop's UI." },
    view: { type: "enum", description: "Display mode in Raindrop's UI.", enum_values: ["list", "simple", "grid", "masonry"] },
    color: { type: "string", description: "Operator-assigned color (Raindrop ships free-form CSS strings)." },
    public: { type: "boolean", description: "Whether the collection has a public URL." },
    created: { type: "datetime", description: "Creation timestamp upstream." },
    last_update: { type: "datetime", description: "Last-update timestamp upstream." },
  },
  display_hints: { title_field: "title" },
};

const raindropRaindrop: TypeSchema = {
  id: "raindrop.raindrop",
  label: "Raindrop Bookmark",
  description: "A Raindrop bookmark — a saved link with title, excerpt, optional note, tags, and a parent collection. Maps onto the cross-app `core.bookmark` shape via `compatible_with`.",
  version: 1,
  fields: {
    title: { type: "string", description: "Bookmark title (maps to Raindrop `title`).", required: true },
    body: { type: "string", description: "Bookmark body — carries Raindrop's `note` so the type satisfies `core.bookmark.body` for cross-app consumers." },
    url: { type: "url", description: "Target URL (maps to Raindrop `link`).", required: true },
    excerpt: { type: "string", description: "Auto-generated excerpt from the linked page (maps to Raindrop `excerpt`)." },
    note: { type: "string", description: "User's personal note (mirrors `body`; kept for upstream fidelity)." },
    domain: { type: "string", description: "Host of the link (Raindrop pre-extracts this)." },
    cover: { type: "url", description: "Cover image URL (Raindrop auto-extracts one when available)." },
    raindrop_type: { type: "enum", description: "Raindrop's `type` field — what kind of content the link points at. Field-renamed to avoid shadowing Item's first-class `type` column.", enum_values: ["link", "article", "image", "video", "document", "audio"] },
    tags: { type: "array", description: "Free-form tags (maps to Raindrop `tags`).", items_type: "string" },
    created: { type: "datetime", description: "When the raindrop was saved upstream." },
    last_update: { type: "datetime", description: "Last-update timestamp upstream." },
    important: { type: "boolean", description: "Raindrop's `important` flag (operator-set; a starred / pinned marker)." },
    collection_id: { type: "string", description: "External Raindrop id of the parent collection. Stamped alongside the typed `parent-of` edge so consumers can look up the collection without traversing edges." },
    media: { type: "array", description: "Array of attached media objects `{ link, type }` (Raindrop carries one per attachment).", items_type: "object" },
  },
  display_hints: { title_field: "title", body_field: "excerpt" },
  compatible_with: ["core.bookmark"],
};

const readwiseBook: TypeSchema = {
  id: "readwise.book",
  label: "Readwise Book",
  description: "A source book / article / tweet / podcast in Readwise — the parent that highlights belong to. One row per Readwise `user_book_id`; matches Readwise's `/export/` book payload fields verbatim for upstream fidelity.",
  version: 1,
  fields: {
    title: { type: "string", description: "Book / article / tweet title (maps to Readwise `title`).", required: true },
    author: { type: "string", description: "Author name (maps to Readwise `author`)." },
    category: { type: "enum", description: "Source category — books | articles | tweets | podcasts (maps to Readwise `category`).", enum_values: ["books", "articles", "tweets", "podcasts"] },
    readwise_source: { type: "string", description: "How the highlight was imported — e.g. `kindle`, `instapaper`, `manual` (maps to Readwise `source`). Field-renamed to avoid shadowing the first-class `source` column on the items table." },
    source_url: { type: "url", description: "Stable URL of the original source." },
    cover_image_url: { type: "url", description: "Book / article cover image (maps to Readwise `cover_image_url`)." },
    num_highlights: { type: "integer", description: "Number of highlights Readwise had captured for this source at sync time." },
    updated: { type: "datetime", description: "Readwise `updated` timestamp — when the book metadata last changed upstream." },
  },
  display_hints: { title_field: "title" },
};

const readwiseDocument: TypeSchema = {
  id: "readwise.document",
  label: "Readwise Reader Document",
  description: "A document in Readwise Reader — an article, email, feed item, PDF, video or podcast saved to the read-later library. One row per Reader document id; mirrors Reader's `/api/v3/list/` payload for upstream fidelity. Distinct from `readwise.book`, which is the Highlights product's v2 source object.",
  version: 1,
  fields: {
    title: { type: "string", description: "Document title (maps to Reader `title`).", required: true },
    author: { type: "string", description: "Author or byline (maps to Reader `author`)." },
    summary: { type: "string", description: "Short description of the document, usually the source's own excerpt (maps to Reader `summary`)." },
    category: { type: "enum", description: "What kind of document this is (maps to Reader `category`). Reader assigns one from the source URL when a save does not name it.", enum_values: ["article", "email", "epub", "highlight", "note", "pdf", "podcast", "rss", "tweet", "video"] },
    location: { type: "enum", description: "Which Reader triage bucket the document sits in (maps to Reader `location`). Only `new`, `later`, `archive` and `feed` can be written; `shortlist` is readable but a write naming it is silently stored as `new`.", enum_values: ["new", "later", "shortlist", "archive", "feed"] },
    reader_url: { type: "url", description: "Deep link to the document in Reader (maps to Reader `url`). Assigned by Reader, not by the saver, so it is absent until the document exists upstream." },
    source_url: { type: "url", description: "URL of the original content (maps to Reader `source_url`). Reader deduplicates saves on this value, which makes it the natural key for a create." },
    site_name: { type: "string", description: "Publication or site the document came from (maps to Reader `site_name`)." },
    readwise_source: { type: "string", description: "How the document entered Reader — e.g. `Reader RSS`, `reader-mobile-app`, `api` (maps to Reader `source`). Field-renamed to avoid shadowing the first-class `source` column on the items table." },
    word_count: { type: "integer", description: "Word count of the extracted text, where Reader computed one." },
    reading_time: { type: "string", description: "Human-readable estimated reading time, e.g. `4 mins` (maps to Reader `reading_time`). A string upstream, not a number." },
    listening_time: { type: "string", description: "Human-readable estimated listening time for audio documents (maps to Reader `listening_time`)." },
    reading_progress: { type: "number", description: "How far through the document the reader has got, from 0 to 1 (maps to Reader `reading_progress`)." },
    published_date: { type: "datetime", description: "When the original content was published (maps to Reader `published_date`). Reader returns a bare calendar date and accepts a full instant on write, so both shapes are allowed." },
    image_url: { type: "url", description: "Cover or hero image for the document (maps to Reader `image_url`)." },
    notes: { type: "string", description: "The reader's own note on the document as a whole (maps to Reader `notes`). Distinct from notes attached to individual highlights, which the v3 API cannot write." },
    tags: { type: "array", description: "Tag names applied to the document. Reader reads tags back as an object keyed by name and takes a plain list on write; this holds the normalized list of names.", items_type: "string", maxItems: 200 },
    saved_at: { type: "datetime", description: "When the document was saved to Reader (maps to Reader `saved_at`)." },
    updated: { type: "datetime", description: "When the document last changed upstream (maps to Reader `updated_at`). Field-renamed to avoid shadowing the first-class `updated_at` column on the items table." },
    last_moved_at: { type: "datetime", description: "When the document last changed triage bucket (maps to Reader `last_moved_at`)." },
    first_opened_at: { type: "datetime", description: "When the document was first opened in Reader (maps to Reader `first_opened_at`)." },
    last_opened_at: { type: "datetime", description: "When the document was last opened in Reader (maps to Reader `last_opened_at`)." },
  },
  display_hints: { title_field: "title" },
};

const readwiseHighlight: TypeSchema = {
  id: "readwise.highlight",
  label: "Readwise Highlight",
  description: "A highlight / annotation captured in Readwise. The quoted text lands in `text` and the user's personal annotation in `note`. Deliberately not `compatible_with: core.note` — a note requires `body`, and renaming this type's `text` field would orphan the property on every highlight already captured. Readers wanting the cross-app shape should project through the display hints.",
  version: 1,
  fields: {
    text: { type: "string", description: "Highlight body (the actual quoted text). Required; no separate title.", required: true },
    note: { type: "string", description: "User's personal annotation on the highlight (maps to Readwise `note`)." },
    location: { type: "integer", description: "Numerical location within the source (maps to Readwise `location` — meaning depends on `location_type`)." },
    location_type: { type: "enum", description: "What `location` means — page | location (Kindle) | offset | order | time_offset (podcast) | none.", enum_values: ["page", "location", "offset", "order", "time_offset", "none"] },
    color: { type: "string", description: "Highlight color as reported by Readwise (e.g. `yellow`, `blue`)." },
    tags: { type: "array", description: "Free-form tags attached to the highlight (maps to Readwise `tags`).", items_type: "string" },
    highlighted_at: { type: "datetime", description: "When the user highlighted the source." },
    updated: { type: "datetime", description: "Readwise `updated` timestamp — when the highlight last changed upstream." },
    url: { type: "url", description: "Deep link to the highlight on readwise.io" },
    book_id: { type: "string", description: "External Readwise `user_book_id` of the parent book. Read-only; persisted alongside the typed `parent-of` edge so consumers can look up the parent book without traversing edges." },
  },
  display_hints: { title_field: "text", body_field: "note" },
};

const todoistTask: TypeSchema = {
  id: "todoist.task",
  label: "Todoist Task",
  description: "A task on a Todoist project, captured with upstream fidelity. Mirrors Todoist's Sync API item resource closely so a round-trip preserves what Todoist considers authoritative (content, description, project_id, section_id, parent_id, labels, priority, due, child_order, completed, url, comment_count). Deliberately not `compatible_with: core.task` — the two disagree on `priority`, which is Todoist's integer 1-4 here and a `low | medium | high | urgent` enum there, so a `core.task` reader would be handed `4` where it expects `\"urgent\"`. Retyping the field would both discard the upstream fidelity this type exists for and orphan the property on every task already captured. The Todoist connector can be configured to write `core.task` instead when cross-app interop matters more than fidelity.",
  version: 1,
  fields: {
    title: { type: "string", description: "Task title (maps to Todoist `content`).", required: true },
    description: { type: "string", description: "Free-text description attached to the task (maps to Todoist `description`)." },
    project_id: { type: "string", description: "Todoist project id the task lives on. Inbox project is the default when this field is unset." },
    section_id: { type: "string", description: "Todoist section id within the project, when the task is grouped under a section." },
    parent_id: { type: "string", description: "Parent task id when this task is a subtask (Todoist allows arbitrary nesting depth)." },
    labels: { type: "array", description: "Label names attached to the task (maps to Todoist `labels`). Free-form strings.", items_type: "string" },
    priority: { type: "integer", description: "Task priority (1 = no priority through 4 = urgent, matching Todoist's wire convention)." },
    due: { type: "object", description: "Due date/time object. Carries any of `{ date, datetime, string, lang, is_recurring, timezone }`; `null` when the task has no due date." },
    child_order: { type: "integer", description: "Stable sort order within the parent (maps to Todoist `child_order`)." },
    completed: { type: "boolean", description: "Mirrors Todoist's `checked` flag. Closing a task in Marfa (state transition to trashed) maps to Todoist's `/close` endpoint, which sets this to true upstream." },
    url: { type: "url", description: "Stable HTTPS link to the task on the Todoist web UI." },
    comment_count: { type: "integer", description: "Number of comments on the task at last sync (maps to Todoist `comment_count`)." },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

const googleCalendarEvent: TypeSchema = {
  id: "google.calendar.event",
  label: "Google Calendar Event",
  description: "An event on a Google Calendar, captured with upstream fidelity. Mirrors the Calendar API event resource closely so a round-trip preserves the fields Google considers authoritative. For cross-app interop with non-Google consumers, the Google Calendar connector can also be configured to write to `core.event` instead, but the default and the fidelity choice is this type.",
  version: 2,
  fields: {
    title: { type: "string", description: "Event summary (maps to Calendar `summary`)", required: true },
    description: { type: "string", description: "Event description" },
    starts_at: { type: "datetime", description: "Start time. ISO datetime for timed events; ISO date (YYYY-MM-DD) for all-day events." },
    ends_at: { type: "datetime", description: "End time. ISO datetime for timed events; ISO date for all-day events." },
    timezone: { type: "string", description: "IANA timezone identifier (e.g. \"Europe/London\") from Calendar `start.timeZone`. Set on timed events; omitted on all-day events. This is the start zone; `end_timezone` carries `end.timeZone` when Calendar reports a different one." },
    end_timezone: { type: "string", description: "IANA timezone from Calendar `end.timeZone`, carried when it differs from `timezone`. Calendar exposes the two separately and offers the choice in its own interface, so collapsing them loses a fact the user entered." },
    all_day: { type: "boolean", description: "True when the event is an all-day event (Calendar `start.date` instead of `start.dateTime`). The declared answer, not an inference from whether `starts_at` happens to carry a time." },
    place: { type: "string", description: "Free-text location (maps to Calendar `location`)" },
    html_link: { type: "url", description: "Stable HTTPS link to the event on the Google Calendar web UI." },
    etag: { type: "string", description: "Calendar's change-detection token. Used for conditional updates and as the content-hash key for echo suppression." },
    source_calendar_id: { type: "string", description: "ID of the Google Calendar this event lives on (the user's primary calendar, a shared work calendar, etc.). Set on inbound items so multi-calendar mappings round-trip; outbound writes derive the target calendar from this field or fall back to the connection's configured default." },
    status: { type: "enum", description: "Calendar event status.", enum_values: ["confirmed", "tentative", "cancelled"] },
    transparency: { type: "enum", description: "Whether the event blocks time on the user's calendar (Calendar `transparency`).", enum_values: ["opaque", "transparent"] },
    visibility: { type: "enum", description: "Event visibility setting (Calendar `visibility`).", enum_values: ["default", "public", "private", "confidential"] },
    organizer_email: { type: "string", description: "Email address of the event organizer (Calendar `organizer.email`)." },
    creator_email: { type: "string", description: "Email address of the event creator (Calendar `creator.email`)." },
    recurrence: { type: "array", description: "RRULE / RDATE / EXDATE strings (Calendar `recurrence`). Carried verbatim so the series round-trips, and read by the occurrence expansion. EXRULE is deprecated in RFC 5545 and the expander refuses it outright rather than accepting a line it would silently not apply.", items_type: "string" },
    recurring_event_id: { type: "string", description: "When set, this event is an instance of a recurring series; value is the Calendar event id of the series parent." },
    color_id: { type: "string", description: "Calendar event color id (numeric string, 1–11; see Calendar's `colors.get`)." },
    original_starts_at: { type: "datetime", description: "For an event that replaces one occurrence of a series, the start time of the occurrence it replaces (Calendar `originalStartTime`). Its series is named by a parent-of edge." },
  },
  display_hints: { title_field: "title", body_field: "description" },
  compatible_with: ["core.event"],
};

const googleContactsContact: TypeSchema = {
  id: "google.contacts.contact",
  label: "Google Contact",
  description: "A contact (person) from Google Contacts, captured with upstream fidelity. Mirrors the People API person resource — names, email addresses, phone numbers, postal addresses, organizations, biographies, etag — so a round-trip preserves what Google considers authoritative. Deliberately not `compatible_with: core.entity.person`, which requires `name`; this type carries the display name in `title` and renaming it would orphan the property on every contact already captured. The Google Contacts connector can be configured to write `core.entity.person` instead when cross-app interop matters more than upstream fidelity.",
  version: 1,
  fields: {
    title: { type: "string", description: "Display name (maps to People API `names[0].displayName`). Falls back to a join of given+family names.", required: true },
    given_name: { type: "string", description: "Given (first) name (maps to `names[0].givenName`)." },
    family_name: { type: "string", description: "Family (last) name (maps to `names[0].familyName`)." },
    middle_name: { type: "string", description: "Middle name (maps to `names[0].middleName`)." },
    prefix: { type: "string", description: "Honorific prefix — Dr / Mr / Prof (maps to `names[0].honorificPrefix`)." },
    suffix: { type: "string", description: "Honorific suffix — PhD / Jr / OBE (maps to `names[0].honorificSuffix`)." },
    nickname: { type: "string", description: "Familiar name or alias (maps to `nicknames[0].value`)." },
    emails: { type: "array", description: "Email addresses. Each entry is a JSON-encoded object: `{ value, type, formattedType }`. Round-trips the full People API `emailAddresses` array.", items_type: "string" },
    phones: { type: "array", description: "Phone numbers. Each entry is a JSON-encoded object: `{ value, type, formattedType }`. Round-trips the full People API `phoneNumbers` array.", items_type: "string" },
    addresses: { type: "array", description: "Postal addresses. Each entry is a JSON-encoded object with the full People API `addresses` shape — `{ formattedValue, type, streetAddress, city, region, postalCode, country, countryCode }`.", items_type: "string" },
    organization: { type: "string", description: "Primary employer / organization name (maps to `organizations[0].name`)." },
    job_title: { type: "string", description: "Job title within the primary organization (maps to `organizations[0].title`)." },
    department: { type: "string", description: "Department within the primary organization (maps to `organizations[0].department`)." },
    biography: { type: "string", description: "Free-text biography / notes about the contact (maps to `biographies[0].value`)." },
    birthday: { type: "date", description: "Date of birth — ISO 8601 (YYYY-MM-DD or YYYY when year is unknown). Reconstructed from People API `birthdays[0].date.{year,month,day}`." },
    photo_url: { type: "url", description: "Reference URL to the contact's photo (maps to `photos[0].url`). Stored as a URL only — no blob ingest in v1." },
    etag: { type: "string", description: "People API change-detection token. Used as the content-hash key for echo suppression AND threaded into outbound updates as the `etag` field for optimistic-concurrency (stale etag → 409, handler refetches and reapplies)." },
    resource_name: { type: "string", description: "Stable People API resource id — typically `people/c<digits>`. Used as the external_id on the cursor mapping." },
  },
  display_hints: { title_field: "title", body_field: "biography" },
};

const googleDriveFile: TypeSchema = {
  id: "google.drive.file",
  label: "Google Drive File",
  description: "A file on Google Drive, captured with upstream fidelity. Mirrors the Drive v3 file resource closely so a round-trip preserves what Drive considers authoritative (id, name, mimeType, size, ownership, parents, links, checksums). Direction is inbound-only in v1 — the connector reads files into Marfa but does not write back. Metadata-only captures do not claim `core.file` compatibility because they have no required blob reference.",
  version: 1,
  fields: {
    title: { type: "string", description: "File name (maps to Drive `name`).", required: true },
    mime_type: { type: "string", description: "MIME type (maps to Drive `mimeType`). Google-native types are `application/vnd.google-apps.*` and require export rather than alt=media download.", required: true },
    drive_file_id: { type: "string", description: "Stable Drive file id. Used as the external_id on the cursor mapping.", required: true },
    size_bytes: { type: "integer", description: "File size in bytes (maps to Drive `size`). Null for native Google formats (Docs / Sheets / Slides)." },
    created_at_drive: { type: "datetime", description: "Drive-side created timestamp (maps to Drive `createdTime`)." },
    modified_at_drive: { type: "datetime", description: "Drive-side modified timestamp (maps to Drive `modifiedTime`). Used for incremental ordering when changes.list cursor is absent." },
    owners: { type: "array", description: "Owner email addresses (each entry is the `emailAddress` of an owner from Drive's `owners` array).", items_type: "string" },
    parents: { type: "array", description: "Parent folder ids (maps to Drive `parents`).", items_type: "string" },
    trashed: { type: "boolean", description: "Drive `trashed` flag. Handler maps `trashed: true` to a Marfa tombstone (state-trashed) rather than persisting the flag literally." },
    web_view_link: { type: "url", description: "Stable HTTPS URL to view the file in the Drive web UI (maps to Drive `webViewLink`)." },
    icon_link: { type: "url", description: "URL to a small icon for the file's type (maps to Drive `iconLink`)." },
    thumbnail_link: { type: "url", description: "URL to a short-lived thumbnail (maps to Drive `thumbnailLink`). Stored as a URL only; not downloaded." },
    md5_checksum: { type: "string", description: "MD5 checksum of the file content (maps to Drive `md5Checksum`). Available for binary file types; absent for native Google formats." },
    sha256_checksum: { type: "string", description: "SHA-256 checksum where Drive provides it (`sha256Checksum`; recent addition to the v3 API)." },
    blob_ref: { type: "string", description: "Reference to the downloaded binary content as a Marfa blob (`sha256:<hex>`). Present iff the bytes were successfully ingested into the Marfa blob store — i.e. `connection.properties.configuration.download_mode` is `all-files` (or a matching glob), the file is downloadable (not a Google-native `application/vnd.google-apps.*` type), and the download stayed within the per-file size ceiling. Absent in metadata mode and whenever an all-files attempt was skipped or failed (the activity log carries the reason). Programmatic gate: `typeof blob_ref === \"string\"` means the bytes are retrievable via `GET /blobs/{blob_ref}`." },
    etag: { type: "string", description: "Drive's change-detection token (Drive returns ETag-style hashes on most responses). Used as the content-hash key for echo suppression." },
  },
  display_hints: { title_field: "title" },
};

const googleTasksTask: TypeSchema = {
  id: "google.tasks.task",
  label: "Google Task",
  description: "A task on a Google Tasks list, captured with upstream fidelity. Mirrors the Tasks API task resource closely so a round-trip preserves what Google considers authoritative (notes, due, status, completed, position, parent, links). For cross-app interop with non-Google consumers, the Google Tasks connector can also be configured to write to `core.task` instead, but the default and the fidelity choice is this type.",
  version: 1,
  fields: {
    title: { type: "string", description: "Task title (maps to Tasks `title`)", required: true },
    notes: { type: "string", description: "Free-text notes attached to the task (maps to Tasks `notes`)." },
    due_at: { type: "datetime", description: "Due date. Tasks API stores due as an RFC 3339 timestamp but only the date portion is honored — time-of-day is ignored upstream." },
    completed_at: { type: "datetime", description: "Completion timestamp (maps to Tasks `completed`). Present only when `status` is `completed`." },
    status: { type: "enum", description: "Task status.", enum_values: ["needsAction", "completed"] },
    position: { type: "string", description: "Stable sort key within the parent task list / subtask group (maps to Tasks `position`). Opaque, lexicographically sortable." },
    parent: { type: "string", description: "Parent task id when this task is a subtask (maps to Tasks `parent`). Task lists allow one level of nesting only." },
    html_link: { type: "url", description: "Stable HTTPS link to the task on the Google Tasks web UI (maps to Tasks `selfLink`/`webViewLink`)." },
    etag: { type: "string", description: "Tasks API change-detection token. Used as the content-hash key for echo suppression." },
    source_task_list_id: { type: "string", description: "ID of the Google Tasks list this task lives on. Set on inbound items so per-list mappings round-trip; outbound writes derive the target list from this field or fall back to the connection's configured default." },
    hidden: { type: "boolean", description: "Tasks API `hidden` flag. Set true by Google when a completed task is hidden from the default view; round-tripped for fidelity." },
    deleted: { type: "boolean", description: "Tasks API `deleted` flag (surfaces when `showDeleted=true` is passed on the list). Handler maps a true value to a Marfa tombstone (state-trashed) rather than persisting the flag literally." },
  },
  display_hints: { title_field: "title", body_field: "notes" },
  compatible_with: ["core.task"],
};

const googleYoutubeChannel: TypeSchema = {
  id: "google.youtube.channel",
  label: "YouTube Channel",
  description: "A YouTube channel — surfaced when the connected user has subscribed to it or when it owns a liked video or user playlist. Captures channel metadata from the YouTube Data API v3 `channels` resource. `subscribed_at` carries the time the connected user subscribed (when known); absent when the channel was surfaced solely as the owner of a liked video or playlist.",
  version: 1,
  fields: {
    channel_id: { type: "string", description: "YouTube channel id — the stable handle used in canonical channel URLs (`https://www.youtube.com/channel/<channel_id>`). The external id on the cursor mapping.", required: true },
    title: { type: "string", description: "Channel display name (maps to `snippet.title`).", required: true },
    description: { type: "string", description: "Channel description / about text (maps to `snippet.description`)." },
    custom_url: { type: "string", description: "Vanity URL slug when set (maps to `snippet.customUrl`)." },
    published_at: { type: "datetime", description: "Channel creation timestamp (maps to `snippet.publishedAt`) — RFC 3339." },
    thumbnail_url: { type: "url", description: "Best-available channel avatar URL — picks the highest-resolution variant present (`maxres > standard > high > medium > default`)." },
    subscriber_count: { type: "number", description: "Subscriber count at the time of last fetch (maps to `statistics.subscriberCount`, parsed to a number). May be hidden by the channel owner." },
    video_count: { type: "number", description: "Public video count at the time of last fetch (maps to `statistics.videoCount`, parsed to a number)." },
    view_count: { type: "number", description: "Channel-lifetime view count (maps to `statistics.viewCount`, parsed to a number)." },
    subscribed_at: { type: "datetime", description: "Timestamp the connected user subscribed to this channel (maps to `subscriberSnippet.subscribedAt`). Absent when the channel was surfaced solely as the owner of a liked video / playlist rather than via a subscription." },
    html_link: { type: "url", description: "Canonical channel URL on YouTube — `https://www.youtube.com/channel/<channel_id>`." },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

const googleYoutubePlaylist: TypeSchema = {
  id: "google.youtube.playlist",
  label: "YouTube Playlist",
  description: "A YouTube playlist created by the connected user. Captures playlist metadata from the YouTube Data API v3 `playlists` resource. The owning channel is wired via a `parent-of` edge (channel = source, playlist = target). When the connection's `materialise_playlists` configuration flag is true, the per-playlist video walk wires additional `parent-of` edges from this playlist to each member video.",
  version: 1,
  fields: {
    playlist_id: { type: "string", description: "YouTube playlist id — used in canonical URLs (`https://www.youtube.com/playlist?list=<playlist_id>`). The external id on the cursor mapping.", required: true },
    title: { type: "string", description: "Playlist title (maps to `snippet.title`).", required: true },
    description: { type: "string", description: "Free-text playlist description (maps to `snippet.description`)." },
    channel_id: { type: "string", description: "YouTube id of the owning channel (maps to `snippet.channelId`). The corresponding `google.youtube.channel` item is wired via a `parent-of` edge (channel = source, playlist = target)." },
    item_count: { type: "number", description: "Number of videos in the playlist at the time of last fetch (maps to `contentDetails.itemCount`)." },
    privacy_status: { type: "enum", description: "Playlist visibility (maps to `status.privacyStatus`).", enum_values: ["public", "unlisted", "private"] },
    published_at: { type: "datetime", description: "Playlist creation timestamp (maps to `snippet.publishedAt`) — RFC 3339." },
    thumbnail_url: { type: "url", description: "Best-available thumbnail URL — picks the highest-resolution variant present (`maxres > standard > high > medium > default`)." },
    etag: { type: "string", description: "YouTube Data API change-detection token. Cached on the cursor's `playlist_etags` map; an unchanged etag skips the per-playlist video walk on the next sweep." },
    html_link: { type: "url", description: "Canonical playlist URL on YouTube — `https://www.youtube.com/playlist?list=<playlist_id>`." },
  },
  display_hints: { title_field: "title", body_field: "description" },
};

const googleYoutubeVideo: TypeSchema = {
  id: "google.youtube.video",
  label: "YouTube Video",
  description: "A YouTube video — liked by the connected user or surfaced via a walked user-created playlist. Mirrors the YouTube Data API v3 `videos` resource. `liked_at` is a property on the video (sourced from the liked-playlist item's `snippet.publishedAt`), not modeled as an edge.",
  version: 1,
  fields: {
    video_id: { type: "string", description: "YouTube video id — the 11-character handle used in canonical watch URLs (`https://www.youtube.com/watch?v=<video_id>`). Used as the external id on the cursor mapping.", required: true },
    title: { type: "string", description: "Video title (maps to `snippet.title`).", required: true },
    description: { type: "string", description: "Free-text video description (maps to `snippet.description`)." },
    channel_id: { type: "string", description: "YouTube id of the channel that owns this video (maps to `snippet.channelId`). The corresponding `google.youtube.channel` item is wired via a `parent-of` edge (channel = source, video = target)." },
    channel_title: { type: "string", description: "Display name of the owning channel at the time of fetch (maps to `snippet.channelTitle`). Cached for display; not authoritative — the canonical name lives on the linked channel item." },
    published_at: { type: "datetime", description: "Original publish timestamp from `snippet.publishedAt` — RFC 3339." },
    liked_at: { type: "datetime", description: "Timestamp the connected user liked this video. Sourced from the liked-playlist item's `snippet.publishedAt`, which YouTube uses to record like-time on that magic playlist." },
    duration_iso8601: { type: "string", description: "Video duration in ISO 8601 duration format (e.g. `PT4M13S`). Maps to `contentDetails.duration`." },
    view_count: { type: "number", description: "View count at the time of last fetch (maps to `statistics.viewCount`, parsed to a number)." },
    like_count: { type: "number", description: "Like count at the time of last fetch (maps to `statistics.likeCount`, parsed to a number). May be absent when the upstream has hidden it." },
    thumbnail_url: { type: "url", description: "Best-available thumbnail URL — picks the highest-resolution variant present (`maxres > standard > high > medium > default`)." },
    tags: { type: "array", description: "Free-form tags assigned by the uploader (maps to `snippet.tags`).", items_type: "string" },
    category_id: { type: "string", description: "YouTube category id (maps to `snippet.categoryId`). Numeric string per the v3 API." },
    default_audio_language: { type: "string", description: "BCP-47 language code for the video's default audio track (maps to `snippet.defaultAudioLanguage`)." },
    html_link: { type: "url", description: "Canonical watch URL on YouTube — `https://www.youtube.com/watch?v=<video_id>`." },
  },
  display_hints: { title_field: "title", body_field: "description" },
  compatible_with: ["core.media"],
};

const marfaPodcastEpisode: TypeSchema = {
  id: "marfa.podcast.episode",
  label: "Podcast Episode",
  description: "One episode of a podcast, as its feed item describes it. Joins its show through the in-collection edge, with the episode as the source. Mirrors an RSS 2.0 item together with the iTunes and Podcasting 2.0 namespaces, for upstream fidelity; a connection that would rather trade fidelity for interoperability writes `core.media.episode` instead. Both a raw and a normalized duration are kept, because feeds express it in several formats and the original is the only evidence of which one was meant.",
  version: 1,
  fields: {
    title: { type: "string", description: "Episode title (maps to the item `title`, falling back to `itunes:title`).", required: true },
    guid: { type: "string", description: "The item's own identifier (maps to `guid`). Optional in RSS and required by Apple, so it is usually present but cannot be relied on; an item without one is identified by its enclosure address instead." },
    guid_is_permalink: { type: "boolean", description: "The `isPermaLink` attribute as the feed gave it, defaulting to true when absent per RSS 2.0. Recorded rather than acted on: it says whether the guid can be dereferenced, which has no bearing on whether it is stable." },
    enclosure_url: { type: "url", description: "Address of the episode's media file (maps to the item `enclosure` `url`). Where an item carries several enclosures — and modern feeds attach artwork, transcripts and captions alongside the audio — this is the audio or video one." },
    enclosure_type: { type: "string", description: "MIME type the feed claims for the enclosure (maps to `enclosure` `type`), such as audio/mpeg or video/mp4. This is what distinguishes a video episode from an audio one; `itunes:type` does not." },
    enclosure_length: { type: "integer", description: "Size in bytes the feed claims for the enclosure (maps to `enclosure` `length`). Required by the specification and frequently wrong — whole feeds report zero — so it is mirrored as claimed and should not be trusted for accounting." },
    link: { type: "url", description: "The episode's own web page (maps to the item `link`). Distinct from `enclosure_url`, which is the media itself." },
    description: { type: "string", description: "Short episode description, preferring `itunes:summary` and falling back to the item `description`." },
    content_encoded: { type: "string", description: "Full show notes as published, usually HTML (maps to `content:encoded`). Kept as given rather than downgraded to text, since the markup carries the chapter links and credits." },
    pub_date: { type: "datetime", description: "When the episode was published (maps to the item `pubDate`). Feeds give this in RFC 822 form, sometimes with an alphabetic timezone rather than a numeric offset." },
    duration_raw: { type: "string", description: "The duration exactly as the feed wrote it (maps to `itunes:duration`), before normalization. Feeds use plain seconds, MM:SS and HH:MM:SS interchangeably, sometimes wrapped in CDATA with surrounding whitespace, so the original is kept as the evidence for how it was read." },
    duration_seconds: { type: "number", description: "Duration in seconds, normalized from `duration_raw`. Absent where the feed's value could not be read as a duration." },
    season_number: { type: "integer", description: "Season the episode belongs to (maps to `itunes:season`)." },
    episode_number: { type: "integer", description: "Position within the season, or within the show where it has no seasons (maps to `itunes:episode`)." },
    episode_type: { type: "enum", description: "Whether this is a full episode or something alongside the run (maps to `itunes:episodeType`, which defaults to full when absent).", enum_values: ["full", "trailer", "bonus"] },
    explicit: { type: "enum", description: "Explicitness as declared by the item's `itunes:explicit`, normalized the same way as on the show.", enum_values: ["true", "false", "clean"] },
    author: { type: "string", description: "Who made this episode (maps to the item `itunes:author`, falling back to `dc:creator` and then to the show's author, since most items omit it and the host is the answer)." },
    image_url: { type: "url", description: "Episode artwork, from the `href` attribute of the item's `itunes:image`, falling back to the show's." },
    feed_url: { type: "url", description: "Address of the feed this episode was read from, kept so an episode can be traced to its source without reading the show." },
    podcast_guid: { type: "string", description: "Identifier of the show this episode belongs to, matching `podcast_guid` on `marfa.podcast.show`. The in-collection edge is the authoritative join; this is the same fact denormalized, so a reader holding an episode knows its show without a second call." },
  },
  display_hints: { title_field: "title", body_field: "content_encoded" },
};

const marfaPodcastShow: TypeSchema = {
  id: "marfa.podcast.show",
  label: "Podcast Show",
  description: "A podcast, as its RSS feed describes it. One row per show, keyed on the show's stable identifier rather than its feed address, so a move between hosts does not create a second show. Episodes join it through the in-collection edge. Mirrors the channel element of an RSS 2.0 feed together with the iTunes and Podcasting 2.0 namespaces, for upstream fidelity; a connection that would rather trade fidelity for interoperability writes `core.media.series` instead.",
  version: 2,
  fields: {
    title: { type: "string", description: "Show name (maps to the channel `title`). A feed that omits it falls back to its host, since a show with no name cannot be told apart in a list.", required: true },
    feed_url: { type: "url", description: "Address the feed was fetched from. Not the identity: a show that changes host keeps its guid and changes this.", required: true },
    podcast_guid: { type: "string", description: "Stable identifier for the show, from the channel's `podcast:guid` where the feed declares one. Where it does not — which is most feeds — this is the same value computed the way the Podcasting 2.0 specification defines it, as a UUIDv5 over the feed address with the scheme and any trailing slash removed. A feed that later adds a conformant guid therefore lands on the value already stored." },
    link: { type: "url", description: "The show's own web page (maps to the channel `link`). Distinct from `feed_url`, which is the machine-readable feed." },
    description: { type: "string", description: "Show description, preferring `itunes:summary` and falling back to the channel `description`." },
    author: { type: "string", description: "Who makes the show (maps to `itunes:author`, falling back to `managingEditor`, which is an address rather than a name and so is only a fallback)." },
    owner_name: { type: "string", description: "Name on the feed's ownership record (maps to `itunes:owner` / `itunes:name`). The owner's email address is deliberately not mirrored." },
    image_url: { type: "url", description: "Show artwork, from the `href` attribute of `itunes:image`, falling back to the channel `image` block. The iTunes element carries its value in an attribute and has no text content." },
    language: { type: "string", description: "Language tag exactly as the feed gave it (maps to the channel `language`). Not corrected to canonical case, because a feed saying `en-us` is data about the feed." },
    categories: { type: "array", description: "Category names from `itunes:category`, including nested subcategories, flattened to a list of the `text` attributes.", items_type: "string", maxItems: 50 },
    itunes_type: { type: "enum", description: "Whether episodes are meant to be read newest-first or from the beginning (maps to `itunes:type`). Says nothing about audio versus video — that is carried per episode by the enclosure's MIME type.", enum_values: ["episodic", "serial"] },
    complete: { type: "boolean", description: "Whether the feed declares that no further episodes will ever appear (maps to `itunes:complete`, which is present and set to yes, or absent)." },
    explicit: { type: "enum", description: "Explicitness as declared by `itunes:explicit`. Normalized case-insensitively: yes and true become `true`, no and false become `false`, and `clean` is preserved because it asserts the absence of explicit content rather than merely not claiming it.", enum_values: ["true", "false", "clean"] },
    copyright: { type: "string", description: "Copyright line (maps to the channel `copyright`)." },
    new_feed_url: { type: "url", description: "Address the feed asks clients to move to (maps to `itunes:new-feed-url`). Recorded and surfaced for a person to act on, never followed automatically: a feed naming its own replacement is an instruction from an untrusted document." },
    last_build_date: { type: "datetime", description: "When the feed says its contents last changed (maps to the channel `lastBuildDate`). Advisory only — some hosts omit it and others regenerate it on every render, so it is not used to decide whether to re-read a feed." },
    episode_count: { type: "integer", description: "How many items the feed carried when it was last read. Not the show's episode count: some hosts publish only a recent window, and nothing in a feed says it has been truncated." },
  },
  display_hints: { title_field: "title", body_field: "description" },
  roles: ["container"],
};

export const ALL_CONNECTOR_TYPES: TypeSchema[] = [
  marfaCapturedEmail,
  raindropCollection,
  raindropRaindrop,
  readwiseBook,
  readwiseDocument,
  readwiseHighlight,
  todoistTask,
  googleCalendarEvent,
  googleContactsContact,
  googleDriveFile,
  googleTasksTask,
  googleYoutubeChannel,
  googleYoutubePlaylist,
  googleYoutubeVideo,
  marfaPodcastEpisode,
  marfaPodcastShow,
];

const systemAccountHolder: TypeSchema = {
  id: "system.account_holder",
  label: "Account holder",
  description: "The graph handle for the person who owns this instance. Exactly one row, created at provisioning, so edges such as authored-by can name the account holder instead of a free-floating stand-in. It carries no profile fields: the profile endpoints remain the source of truth for username, name, bio and avatar, and mirroring them here would give the same facts two writers. Lifecycle is bounded to active/revoked. Has no tier — the curated/feed dimension does not apply.",
  version: 1,
  fields: {
  },
};

const systemActivity: TypeSchema = {
  id: "system.activity",
  label: "Activity",
  description: "User-meaningful telemetry emitted by an external-service connector at semantic boundaries — sync runs, errors, things that need user attention. Severity drives surfacing: `info` is routine, `warning` is operational, `error` is recoverable failure, `action_required` is surfaced as a Repairs-style inbox (the user has to do something — re-authorize, resolve a tombstone conflict, etc.). No server path stamps a tier on an activity item, so an activity item is no more feed-surfaced than any other `system.*` row. Lifecycle bounded to active | revoked. Has no tier by default.",
  version: 2,
  fields: {
    connection_id: { type: "string", description: "Id of the emitting system.connection item", required: true },
    severity: { type: "enum", description: "Surfacing level. `info` for routine completion, `warning` for non-blocking concerns, `error` for recoverable failure, `action_required` for items the user has to resolve (surfaced via /items?type=system.activity&filter=properties.severity eq \"action_required\")", required: true, enum_values: ["info", "warning", "error", "action_required"] },
    summary: { type: "string", description: "Short one-liner shown in feed surfaces", required: true },
    detail: { type: "object", description: "Optional JSON context for richer rendering or programmatic resolution" },
  },
};

const systemApp: TypeSchema = {
  id: "system.app",
  label: "App",
  description: "A registered app identity. Carries the human-readable identity (display name, homepage) for an app whose types live under `app.<name>.<type>`. The wire layer does not require a `system.app` record to exist when a type under `app.<name>.*` registers — these records are advisory metadata for surfacing in connected-apps UIs, not registration prerequisites. Has no tier and no lifecycle status; the row's existence is the activation signal.",
  version: 1,
  fields: {
    name: { type: "string", description: "Stable identifier slug used in app.<name>.<type> registrations", required: true },
    display_name: { type: "string", description: "Human-readable display name" },
    homepage_url: { type: "url", description: "App marketing/landing page" },
    publisher_handle: { type: "string", description: "Optional reference to the publishing entity's handle" },
  },
};

const systemConnection: TypeSchema = {
  id: "system.connection",
  label: "Connection",
  description: "An approved relationship between this instance and something outside it. `kind` discriminates between variants: `app` (an OAuth client this user has authorized) and `connector` (anything installed from a manifest, whatever its upstream — a vendor service, a protocol, Marfa's own infrastructure, or nothing at all). Lifecycle bounded to active | revoked. Has no tier.",
  version: 5,
  fields: {
    kind: { type: "enum", description: "Discriminator for connection variant", required: true, enum_values: ["app", "connector"] },
    client_id: { type: "string", description: "OAuth client identifier (for kind: app)" },
    scopes: { type: "array", description: "Granted scope strings", items_type: "string" },
    status: { type: "enum", description: "Lifecycle status (universal across all kinds)", required: true, enum_values: ["active", "revoked"] },
    granted_at: { type: "datetime", description: "When the grant was approved", required: true },
    last_used_at: { type: "datetime", description: "Most recent successful use of any token issued under this grant" },
    revoked_at: { type: "datetime", description: "When the grant was revoked, if any" },
    connector_id: { type: "string", description: "For kind: connector — id of the Connector manifest this connection implements" },
    credential_id: { type: "string", description: "For kind: connector — id of a system.credential item holding the credential the connector authenticates its upstream with" },
    configuration: { type: "object", description: "For kind: connector — per-Connector JSON config payload (shape determined by the Connector manifest)" },
    direction: { type: "enum", description: "For kind: connector — does this connector read from its upstream, write to it, or both", enum_values: ["read", "write", "both"] },
    mapping: { type: "object", description: "Per-connection user mapping: conditions on the incoming record choose the target type and fields are assigned onto its schema. Validated as a whole document rather than field by field; shape and semantics live with the shared mapping module, not this schema." },
  },
};

const systemConnector: TypeSchema = {
  id: "system.connector",
  label: "Connector",
  description: "A registered Connector release — the persisted form of a Connector manifest. One item per (`manifest_name`, `manifest_version`) pair: subsequent releases of the same Connector land as sibling items, not in-place updates, so a Connection installed against v1.0 keeps pointing at the manifest it was installed with even after v1.1 lands. The `manifest` field carries the full validated ConnectorManifest blob; `manifest_name`, `manifest_version`, `publisher`, and `direction` are denormalized onto the item for cheap query/list. A `system.connection` of kind `connector` names the item it implements in `connector_id`.",
  version: 2,
  fields: {
    manifest_name: { type: "string", description: "The Connector's identifier, `<namespace>/<name>`, e.g. `acme/calendar-sync`. The namespace is the data the Connector owns rather than whoever wrote it, and a Connector may declare types under that namespace and nowhere else. Together with `manifest_version` identifies a unique installable release.", required: true },
    manifest_version: { type: "string", description: "Semver of this Connector release (e.g. `1.0.3`). Distinct from `manifest_schema_version` (which is the contract version of the manifest format itself).", required: true },
    publisher: { type: "string", description: "Handle of whoever wrote the Connector and is accountable for it, e.g. `acme`. A different question from the namespace in `manifest_name`, and often a different answer. Carried over from manifest.publisher for list-view display.", required: true },
    summary: { type: "string", description: "Short Connector description from the manifest, surfaced on the install consent screen." },
    direction: { type: "enum", description: "Read/write direction declared by the manifest. Drives consent-screen wording.", enum_values: ["read", "write", "both"] },
    manifest: { type: "object", description: "Full validated ConnectorManifest blob. Immutable for the lifetime of this item — new releases register as siblings.", required: true },
    registered_at: { type: "datetime", description: "When the manifest was registered with the server.", required: true },
  },
};

const systemCredential: TypeSchema = {
  id: "system.credential",
  label: "Credential",
  description: "An API key or OAuth approval. Surfaces a Credentials list; carries permissions and last-used time; revocable. Lifecycle is bounded to active/revoked. Has no tier. For kind: oauth_token, the connector's OAuth provider config (upstream URLs, client id) is stored under `oauth_provider_config` and the client secret under `secret_encrypted` (AES-256-GCM via the connectionOauthToken HKDF domain). For kind: api_token, the upstream API base URL is stored under `api_token_config.upstream_base_url` and the user-supplied bearer token under `secret_encrypted` (same HKDF domain — no separate key minting). The companion connection items reference credentials via `credential_id`.",
  version: 1,
  fields: {
    label: { type: "string", description: "Human-readable label", required: true },
    kind: { type: "enum", description: "Credential kind", required: true, enum_values: ["api_key", "oauth_token", "api_token"] },
    scopes: { type: "array", description: "Granted scope strings", items_type: "string" },
    last_used_at: { type: "datetime", description: "Most recent use timestamp" },
    oauth_provider_config: { type: "object", description: "For kind: oauth_token — non-secret OAuth provider config: { upstream_base_url, oauth_token_url, oauth_client_id }. The secret companion lives under `secret_encrypted`." },
    api_token_config: { type: "object", description: "For kind: api_token — non-secret upstream API config: { upstream_base_url, auth_scheme? }. `auth_scheme` is the HTTP Authorization scheme used to present the token; one of `Bearer` | `Token` | `Basic`, default `Bearer`. Readwise's REST API requires `Token <key>`; most others accept `Bearer`. The user-supplied secret lives under `secret_encrypted`." },
    secret_encrypted: { type: "string", description: "For kind: oauth_token — AES-256-GCM-encrypted client secret. For kind: api_token — AES-256-GCM-encrypted bearer token. Both encoded as base64-iv|base64-ciphertext|base64-tag, keyed via HKDF on the `connectionOauthToken` domain. Decrypted server-side only." },
  },
};

const systemDevice: TypeSchema = {
  id: "system.device",
  label: "Device",
  description: "A connected device — phone, laptop, watch, sync agent. Surfaces a Devices list in the console; carries a name, kind, and last-active timestamp; revocable. Lifecycle is bounded to active/revoked. Has no tier — the curated/feed dimension does not apply.",
  version: 1,
  fields: {
    name: { type: "string", description: "Display name (e.g. \"Work laptop\")", required: true },
    kind: { type: "enum", description: "Device class", required: true, enum_values: ["phone", "tablet", "laptop", "desktop", "watch", "sync-agent", "other"] },
    last_active_at: { type: "datetime", description: "Most recent activity timestamp" },
  },
};

const systemWebhook: TypeSchema = {
  id: "system.webhook",
  label: "Webhook",
  description: "A registered webhook subscription. Surfaces a Webhooks list; carries URL, event filter, delivery history; editable. Lifecycle is bounded to active/revoked. Has no tier.",
  version: 1,
  fields: {
    url: { type: "url", description: "Delivery URL", required: true },
    events: { type: "array", description: "Subscribed event family names", required: true, items_type: "string" },
    type_filter: { type: "string", description: "Optional type-id filter narrowing deliveries" },
    active: { type: "boolean", description: "Subscription enabled" },
  },
};

export const ALL_SYSTEM_TYPES: TypeSchema[] = [
  systemAccountHolder,
  systemActivity,
  systemApp,
  systemConnection,
  systemConnector,
  systemCredential,
  systemDevice,
  systemWebhook,
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
  "google.calendar.event",
  "google.contacts.contact",
  "google.drive.file",
  "google.tasks.task",
  "google.youtube.channel",
  "google.youtube.playlist",
  "google.youtube.video",
  "marfa.captured_email",
  "marfa.podcast.episode",
  "marfa.podcast.show",
  "raindrop.collection",
  "raindrop.raindrop",
  "readwise.book",
  "readwise.document",
  "readwise.highlight",
  "system.account_holder",
  "system.activity",
  "system.app",
  "system.connection",
  "system.connector",
  "system.credential",
  "system.device",
  "system.webhook",
  "todoist.task",
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
    "version": 1
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
    "version": 1
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
    "version": 1
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
    "version": 1
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
    "version": 2
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
    "version": 1
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
    "version": 2
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
    "version": 2
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
    "version": 2
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
    "version": 1
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
    "version": 1
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
    "version": 2
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
    "version": 1
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
    "version": 1
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
    "version": 2
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
    "version": 2
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
    "version": 4
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
    "version": 2
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
    "version": 1
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
    "version": 1
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
    "version": 1
  },
  "google.calendar.event": {
    "compatible_with": [
      "core.event"
    ],
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "all_day": {
        "type": "boolean"
      },
      "color_id": {
        "type": "string"
      },
      "creator_email": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "end_timezone": {
        "type": "string"
      },
      "ends_at": {
        "type": "datetime"
      },
      "etag": {
        "type": "string"
      },
      "html_link": {
        "type": "url"
      },
      "organizer_email": {
        "type": "string"
      },
      "original_starts_at": {
        "type": "datetime"
      },
      "place": {
        "type": "string"
      },
      "recurrence": {
        "items_type": "string",
        "type": "array"
      },
      "recurring_event_id": {
        "type": "string"
      },
      "source_calendar_id": {
        "type": "string"
      },
      "starts_at": {
        "type": "datetime"
      },
      "status": {
        "enum_values": [
          "confirmed",
          "tentative",
          "cancelled"
        ],
        "type": "enum"
      },
      "timezone": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "transparency": {
        "enum_values": [
          "opaque",
          "transparent"
        ],
        "type": "enum"
      },
      "visibility": {
        "enum_values": [
          "default",
          "public",
          "private",
          "confidential"
        ],
        "type": "enum"
      }
    },
    "version": 2
  },
  "google.contacts.contact": {
    "display_hints": {
      "body_field": "biography",
      "title_field": "title"
    },
    "fields": {
      "addresses": {
        "items_type": "string",
        "type": "array"
      },
      "biography": {
        "type": "string"
      },
      "birthday": {
        "type": "date"
      },
      "department": {
        "type": "string"
      },
      "emails": {
        "items_type": "string",
        "type": "array"
      },
      "etag": {
        "type": "string"
      },
      "family_name": {
        "type": "string"
      },
      "given_name": {
        "type": "string"
      },
      "job_title": {
        "type": "string"
      },
      "middle_name": {
        "type": "string"
      },
      "nickname": {
        "type": "string"
      },
      "organization": {
        "type": "string"
      },
      "phones": {
        "items_type": "string",
        "type": "array"
      },
      "photo_url": {
        "type": "url"
      },
      "prefix": {
        "type": "string"
      },
      "resource_name": {
        "type": "string"
      },
      "suffix": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 1
  },
  "google.drive.file": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "blob_ref": {
        "type": "string"
      },
      "created_at_drive": {
        "type": "datetime"
      },
      "drive_file_id": {
        "required": true,
        "type": "string"
      },
      "etag": {
        "type": "string"
      },
      "icon_link": {
        "type": "url"
      },
      "md5_checksum": {
        "type": "string"
      },
      "mime_type": {
        "required": true,
        "type": "string"
      },
      "modified_at_drive": {
        "type": "datetime"
      },
      "owners": {
        "items_type": "string",
        "type": "array"
      },
      "parents": {
        "items_type": "string",
        "type": "array"
      },
      "sha256_checksum": {
        "type": "string"
      },
      "size_bytes": {
        "type": "integer"
      },
      "thumbnail_link": {
        "type": "url"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "trashed": {
        "type": "boolean"
      },
      "web_view_link": {
        "type": "url"
      }
    },
    "version": 1
  },
  "google.tasks.task": {
    "compatible_with": [
      "core.task"
    ],
    "display_hints": {
      "body_field": "notes",
      "title_field": "title"
    },
    "fields": {
      "completed_at": {
        "type": "datetime"
      },
      "deleted": {
        "type": "boolean"
      },
      "due_at": {
        "type": "datetime"
      },
      "etag": {
        "type": "string"
      },
      "hidden": {
        "type": "boolean"
      },
      "html_link": {
        "type": "url"
      },
      "notes": {
        "type": "string"
      },
      "parent": {
        "type": "string"
      },
      "position": {
        "type": "string"
      },
      "source_task_list_id": {
        "type": "string"
      },
      "status": {
        "enum_values": [
          "needsAction",
          "completed"
        ],
        "type": "enum"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 1
  },
  "google.youtube.channel": {
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "channel_id": {
        "required": true,
        "type": "string"
      },
      "custom_url": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "html_link": {
        "type": "url"
      },
      "published_at": {
        "type": "datetime"
      },
      "subscribed_at": {
        "type": "datetime"
      },
      "subscriber_count": {
        "type": "number"
      },
      "thumbnail_url": {
        "type": "url"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "video_count": {
        "type": "number"
      },
      "view_count": {
        "type": "number"
      }
    },
    "version": 1
  },
  "google.youtube.playlist": {
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "channel_id": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "etag": {
        "type": "string"
      },
      "html_link": {
        "type": "url"
      },
      "item_count": {
        "type": "number"
      },
      "playlist_id": {
        "required": true,
        "type": "string"
      },
      "privacy_status": {
        "enum_values": [
          "public",
          "unlisted",
          "private"
        ],
        "type": "enum"
      },
      "published_at": {
        "type": "datetime"
      },
      "thumbnail_url": {
        "type": "url"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 1
  },
  "google.youtube.video": {
    "compatible_with": [
      "core.media"
    ],
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "category_id": {
        "type": "string"
      },
      "channel_id": {
        "type": "string"
      },
      "channel_title": {
        "type": "string"
      },
      "default_audio_language": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "duration_iso8601": {
        "type": "string"
      },
      "html_link": {
        "type": "url"
      },
      "like_count": {
        "type": "number"
      },
      "liked_at": {
        "type": "datetime"
      },
      "published_at": {
        "type": "datetime"
      },
      "tags": {
        "items_type": "string",
        "type": "array"
      },
      "thumbnail_url": {
        "type": "url"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "video_id": {
        "required": true,
        "type": "string"
      },
      "view_count": {
        "type": "number"
      }
    },
    "version": 1
  },
  "marfa.captured_email": {
    "display_hints": {
      "body_field": "text_body",
      "title_field": "subject"
    },
    "fields": {
      "attachments": {
        "items_type": "object",
        "type": "array"
      },
      "body": {
        "type": "string"
      },
      "from_address": {
        "required": true,
        "type": "string"
      },
      "from_name": {
        "type": "string"
      },
      "headers": {
        "type": "object"
      },
      "html_body": {
        "type": "string"
      },
      "in_reply_to": {
        "type": "string"
      },
      "message_id": {
        "type": "string"
      },
      "references": {
        "items_type": "string",
        "type": "array"
      },
      "sent_at": {
        "type": "datetime"
      },
      "subject": {
        "type": "string"
      },
      "text_body": {
        "type": "string"
      },
      "to_address": {
        "required": true,
        "type": "string"
      }
    },
    "version": 1
  },
  "marfa.podcast.episode": {
    "display_hints": {
      "body_field": "content_encoded",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "content_encoded": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "duration_raw": {
        "type": "string"
      },
      "duration_seconds": {
        "type": "number"
      },
      "enclosure_length": {
        "type": "integer"
      },
      "enclosure_type": {
        "type": "string"
      },
      "enclosure_url": {
        "type": "url"
      },
      "episode_number": {
        "type": "integer"
      },
      "episode_type": {
        "enum_values": [
          "full",
          "trailer",
          "bonus"
        ],
        "type": "enum"
      },
      "explicit": {
        "enum_values": [
          "true",
          "false",
          "clean"
        ],
        "type": "enum"
      },
      "feed_url": {
        "type": "url"
      },
      "guid": {
        "type": "string"
      },
      "guid_is_permalink": {
        "type": "boolean"
      },
      "image_url": {
        "type": "url"
      },
      "link": {
        "type": "url"
      },
      "podcast_guid": {
        "type": "string"
      },
      "pub_date": {
        "type": "datetime"
      },
      "season_number": {
        "type": "integer"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 1
  },
  "marfa.podcast.show": {
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "categories": {
        "items_type": "string",
        "maxItems": 50,
        "type": "array"
      },
      "complete": {
        "type": "boolean"
      },
      "copyright": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "episode_count": {
        "type": "integer"
      },
      "explicit": {
        "enum_values": [
          "true",
          "false",
          "clean"
        ],
        "type": "enum"
      },
      "feed_url": {
        "required": true,
        "type": "url"
      },
      "image_url": {
        "type": "url"
      },
      "itunes_type": {
        "enum_values": [
          "episodic",
          "serial"
        ],
        "type": "enum"
      },
      "language": {
        "type": "string"
      },
      "last_build_date": {
        "type": "datetime"
      },
      "link": {
        "type": "url"
      },
      "new_feed_url": {
        "type": "url"
      },
      "owner_name": {
        "type": "string"
      },
      "podcast_guid": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "roles": [
      "container"
    ],
    "version": 2
  },
  "raindrop.collection": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "color": {
        "type": "string"
      },
      "count": {
        "type": "integer"
      },
      "cover": {
        "type": "string"
      },
      "created": {
        "type": "datetime"
      },
      "expanded": {
        "type": "boolean"
      },
      "last_update": {
        "type": "datetime"
      },
      "parent_id": {
        "type": "string"
      },
      "public": {
        "type": "boolean"
      },
      "slug": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "view": {
        "enum_values": [
          "list",
          "simple",
          "grid",
          "masonry"
        ],
        "type": "enum"
      }
    },
    "version": 1
  },
  "raindrop.raindrop": {
    "compatible_with": [
      "core.bookmark"
    ],
    "display_hints": {
      "body_field": "excerpt",
      "title_field": "title"
    },
    "fields": {
      "body": {
        "type": "string"
      },
      "collection_id": {
        "type": "string"
      },
      "cover": {
        "type": "url"
      },
      "created": {
        "type": "datetime"
      },
      "domain": {
        "type": "string"
      },
      "excerpt": {
        "type": "string"
      },
      "important": {
        "type": "boolean"
      },
      "last_update": {
        "type": "datetime"
      },
      "media": {
        "items_type": "object",
        "type": "array"
      },
      "note": {
        "type": "string"
      },
      "raindrop_type": {
        "enum_values": [
          "link",
          "article",
          "image",
          "video",
          "document",
          "audio"
        ],
        "type": "enum"
      },
      "tags": {
        "items_type": "string",
        "type": "array"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "url": {
        "required": true,
        "type": "url"
      }
    },
    "version": 1
  },
  "readwise.book": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "category": {
        "enum_values": [
          "books",
          "articles",
          "tweets",
          "podcasts"
        ],
        "type": "enum"
      },
      "cover_image_url": {
        "type": "url"
      },
      "num_highlights": {
        "type": "integer"
      },
      "readwise_source": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "updated": {
        "type": "datetime"
      }
    },
    "version": 1
  },
  "readwise.document": {
    "display_hints": {
      "title_field": "title"
    },
    "fields": {
      "author": {
        "type": "string"
      },
      "category": {
        "enum_values": [
          "article",
          "email",
          "epub",
          "highlight",
          "note",
          "pdf",
          "podcast",
          "rss",
          "tweet",
          "video"
        ],
        "type": "enum"
      },
      "first_opened_at": {
        "type": "datetime"
      },
      "image_url": {
        "type": "url"
      },
      "last_moved_at": {
        "type": "datetime"
      },
      "last_opened_at": {
        "type": "datetime"
      },
      "listening_time": {
        "type": "string"
      },
      "location": {
        "enum_values": [
          "new",
          "later",
          "shortlist",
          "archive",
          "feed"
        ],
        "type": "enum"
      },
      "notes": {
        "type": "string"
      },
      "published_date": {
        "type": "datetime"
      },
      "reader_url": {
        "type": "url"
      },
      "reading_progress": {
        "type": "number"
      },
      "reading_time": {
        "type": "string"
      },
      "readwise_source": {
        "type": "string"
      },
      "saved_at": {
        "type": "datetime"
      },
      "site_name": {
        "type": "string"
      },
      "source_url": {
        "type": "url"
      },
      "summary": {
        "type": "string"
      },
      "tags": {
        "items_type": "string",
        "maxItems": 200,
        "type": "array"
      },
      "title": {
        "required": true,
        "type": "string"
      },
      "updated": {
        "type": "datetime"
      },
      "word_count": {
        "type": "integer"
      }
    },
    "version": 1
  },
  "readwise.highlight": {
    "display_hints": {
      "body_field": "note",
      "title_field": "text"
    },
    "fields": {
      "book_id": {
        "type": "string"
      },
      "color": {
        "type": "string"
      },
      "highlighted_at": {
        "type": "datetime"
      },
      "location": {
        "type": "integer"
      },
      "location_type": {
        "enum_values": [
          "page",
          "location",
          "offset",
          "order",
          "time_offset",
          "none"
        ],
        "type": "enum"
      },
      "note": {
        "type": "string"
      },
      "tags": {
        "items_type": "string",
        "type": "array"
      },
      "text": {
        "required": true,
        "type": "string"
      },
      "updated": {
        "type": "datetime"
      },
      "url": {
        "type": "url"
      }
    },
    "version": 1
  },
  "system.account_holder": {
    "fields": {},
    "version": 1
  },
  "system.activity": {
    "fields": {
      "connection_id": {
        "required": true,
        "type": "string"
      },
      "detail": {
        "type": "object"
      },
      "severity": {
        "enum_values": [
          "info",
          "warning",
          "error",
          "action_required"
        ],
        "required": true,
        "type": "enum"
      },
      "summary": {
        "required": true,
        "type": "string"
      }
    },
    "version": 2
  },
  "system.app": {
    "fields": {
      "display_name": {
        "type": "string"
      },
      "homepage_url": {
        "type": "url"
      },
      "name": {
        "required": true,
        "type": "string"
      },
      "publisher_handle": {
        "type": "string"
      }
    },
    "version": 1
  },
  "system.connection": {
    "fields": {
      "client_id": {
        "type": "string"
      },
      "configuration": {
        "type": "object"
      },
      "connector_id": {
        "type": "string"
      },
      "credential_id": {
        "type": "string"
      },
      "direction": {
        "enum_values": [
          "read",
          "write",
          "both"
        ],
        "type": "enum"
      },
      "granted_at": {
        "required": true,
        "type": "datetime"
      },
      "kind": {
        "enum_values": [
          "app",
          "connector"
        ],
        "required": true,
        "type": "enum"
      },
      "last_used_at": {
        "type": "datetime"
      },
      "mapping": {
        "type": "object"
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
    "version": 5
  },
  "system.connector": {
    "fields": {
      "direction": {
        "enum_values": [
          "read",
          "write",
          "both"
        ],
        "type": "enum"
      },
      "manifest": {
        "required": true,
        "type": "object"
      },
      "manifest_name": {
        "required": true,
        "type": "string"
      },
      "manifest_version": {
        "required": true,
        "type": "string"
      },
      "publisher": {
        "required": true,
        "type": "string"
      },
      "registered_at": {
        "required": true,
        "type": "datetime"
      },
      "summary": {
        "type": "string"
      }
    },
    "version": 2
  },
  "system.credential": {
    "fields": {
      "api_token_config": {
        "type": "object"
      },
      "kind": {
        "enum_values": [
          "api_key",
          "oauth_token",
          "api_token"
        ],
        "required": true,
        "type": "enum"
      },
      "label": {
        "required": true,
        "type": "string"
      },
      "last_used_at": {
        "type": "datetime"
      },
      "oauth_provider_config": {
        "type": "object"
      },
      "scopes": {
        "items_type": "string",
        "type": "array"
      },
      "secret_encrypted": {
        "type": "string"
      }
    },
    "version": 1
  },
  "system.device": {
    "fields": {
      "kind": {
        "enum_values": [
          "phone",
          "tablet",
          "laptop",
          "desktop",
          "watch",
          "sync-agent",
          "other"
        ],
        "required": true,
        "type": "enum"
      },
      "last_active_at": {
        "type": "datetime"
      },
      "name": {
        "required": true,
        "type": "string"
      }
    },
    "version": 1
  },
  "system.webhook": {
    "fields": {
      "active": {
        "type": "boolean"
      },
      "events": {
        "items_type": "string",
        "required": true,
        "type": "array"
      },
      "type_filter": {
        "type": "string"
      },
      "url": {
        "required": true,
        "type": "url"
      }
    },
    "version": 1
  },
  "todoist.task": {
    "display_hints": {
      "body_field": "description",
      "title_field": "title"
    },
    "fields": {
      "child_order": {
        "type": "integer"
      },
      "comment_count": {
        "type": "integer"
      },
      "completed": {
        "type": "boolean"
      },
      "description": {
        "type": "string"
      },
      "due": {
        "type": "object"
      },
      "labels": {
        "items_type": "string",
        "type": "array"
      },
      "parent_id": {
        "type": "string"
      },
      "priority": {
        "type": "integer"
      },
      "project_id": {
        "type": "string"
      },
      "section_id": {
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
    "version": 1
  }
} as const;

