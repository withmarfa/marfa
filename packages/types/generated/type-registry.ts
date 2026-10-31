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
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:bookmark" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreCollection: TypeSchema = {
  id: "core.collection",
  label: "Collection",
  description: "Items of any type that you gather together. Members join it through the in-collection edge, and it can hold any item but another container.",
  version: 0,
  fields: {
    title: { type: "string", description: "Name of the collection", required: true },
    description: { type: "string", description: "What the collection gathers" },
  },
  display_hints: { title_field: "title", body_field: "description", icon: "lucide:layers" },
  merge_policy: { default: "last_writer_wins" },
  roles: ["container"],
};

const coreEntity: TypeSchema = {
  id: "core.entity",
  label: "Entity",
  description: "Any named entity: a person, a company, a band, a team, a charity, a brand, a school or a place. `core.entity.person` and `core.entity.place` narrow it.",
  version: 0,
  fields: {
    name: { type: "string", description: "Display name", required: true },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "What the entity is" },
    emails: { type: "array", description: "Email addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    phones: { type: "array", description: "Phone numbers. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"string","description":"The phone number, in E.164 form where known","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    addresses: { type: "array", description: "Postal addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}} },
    image_url: { type: "url", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "name", icon: "lucide:shapes" },
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
    duration: { type: "number", description: "Duration in seconds; the length of each occurrence of a series that states no ends_at. A write is refused unless it is from 0 to a century." },
    place: { type: "string", description: "Location" },
    latitude: { type: "number", description: "Venue latitude" },
    longitude: { type: "number", description: "Venue longitude" },
    url: { type: "url", description: "Event link" },
    precision: { type: "enum", description: "How much of the start instant is actually known, for an event dated from memory or from a source that gave only a year. Narrows an instant that exists; it does not say the event has no instant, which is what all_day says.", enum_values: ["year", "month", "day", "time"] },
    status: { type: "enum", description: "Whether the event will happen. A tentative event might not, a confirmed one will and a canceled one will not. Moving an event changes its time, not its status.", enum_values: ["tentative", "confirmed", "canceled"] },
    notes: { type: "string", description: "Personal annotations" },
    recurrence: { type: "array", description: "RFC 5545 recurrence property lines (RRULE, RDATE, EXDATE). Present on the series itself; occurrences are computed from it at read time rather than stored, starting with starts_at itself. A write is refused when a line cannot be read or is not applied (EXRULE, an RDATE period), when it carries more than one RRULE, more than 40,000 characters in all or more than 1,000 added and removed dates, when the rule names no date that exists after the start, or when it produces no occurrence within the bound a read unfolds a rule to.", items_type: "string" },
    all_day: { type: "boolean", description: "True when the event occupies whole days rather than a span of time. A whole day has no instant, so a reader must take the calendar date from starts_at read in timezone and never re-derive it in the reader's own zone, which is how an all-day event ends up on the wrong day for anyone further west. Absent or false means the event has real start and end instants." },
    timezone: { type: "string", description: "IANA time zone the event's schedule keeps its wall-clock hour in, e.g. Europe/Berlin. Stored times stay instants; a recurring series expands in this zone so occurrences keep their local hour across a daylight-saving transition. Absent means the rule advances in UTC. This is the start zone: an event that ends somewhere else states that in end_timezone. A write is refused unless the zone database resolves it as a named zone." },
    end_timezone: { type: "string", description: "IANA time zone the event ends in, when that differs from timezone — a flight lands in a zone it did not depart from, and both ends are wall-clock facts a person reads off a ticket. Absent means the event ends in the zone it started in. Recurrence expands in timezone only; this field never anchors a rule. A write is refused unless the zone database resolves it as a named zone." },
    attendees: { type: "array", description: "The people invited, one entry each, in the order written. An entry names a person by name, email or both, and holds no item ID: an app finds the person behind an entry by matching its email to the email addresses a person holds. response is the reply, from the participation status of RFC 5545; needs_action means no reply yet.", items_type: "object", items_fields: {"name":{"type":"string","description":"The attendee's name as the source gives it"},"email":{"type":"email","description":"The attendee's email address"},"response":{"type":"enum","description":"The attendee's reply to the invitation","enum_values":["needs_action","accepted","declined","tentative"]}} },
    original_starts_at: { type: "datetime", description: "For an event that replaces one occurrence of a series, the start instant of the occurrence it replaces. Its series is named by a parent-of edge." },
  },
  display_hints: { title_field: "title", body_field: "description", icon: "lucide:calendar" },
  merge_policy: { fields: { notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreFile: TypeSchema = {
  id: "core.file",
  label: "File",
  description: "A file or binary reference — the generic fallback for any file that has no more specific type.",
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
    size_bytes: { type: "integer", description: "Size in bytes of the referenced blob (set by the server from the bytes the instance holds; absent where whoever named blob_ref never proved it holds them)" },
  },
  display_hints: { title_field: "title", icon: "lucide:file" },
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
  display_hints: { title_field: "text", body_field: "note", icon: "lucide:highlighter" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:library-big" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMessage: TypeSchema = {
  id: "core.message",
  label: "Message",
  description: "A light, cross-platform message. Threading is edge-based via in-thread; reply trees via parent-of. Tool-specific richness lives in app namespaces.",
  version: 0,
  fields: {
    body: { type: "string", description: "The message text" },
    from: { type: "string", description: "Sender identifier — format-agnostic (phone number, email, handle, etc.)", required: true },
    to: { type: "array", description: "Recipient identifiers — same format-agnostic shape as from", items_type: "string" },
  },
  display_hints: { body_field: "body", icon: "lucide:message-square" },
  merge_policy: { fields: { body: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreNote: TypeSchema = {
  id: "core.note",
  label: "Note",
  description: "Text content you created.",
  version: 0,
  fields: {
    body: { type: "string", description: "The note text" },
    title: { type: "string", description: "Heading or title" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Personal annotations" },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:sticky-note" },
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
    status: { type: "status", description: "Where the task stands", status_values: [{ value: "not_started", group: "not_started" }, { value: "in_progress", group: "in_progress" }, { value: "completed", group: "completed" }, { value: "canceled", group: "canceled" }] },
    priority: { type: "enum", description: "Task priority", enum_values: ["low", "medium", "high", "urgent"] },
    place: { type: "string", description: "Location" },
    precision: { type: "enum", description: "Temporal precision", enum_values: ["year", "month", "day", "time"] },
    url: { type: "url", description: "Related link" },
    assignees: { type: "array", description: "The people the task is assigned to, one entry each, in the order written. An entry names a person by name, email or both, and holds no item ID: an app finds the person behind an entry by matching its email to the email addresses a person holds. It has the members of an attendee of an event, without a response.", items_type: "object", items_fields: {"name":{"type":"string","description":"The assignee's name as the source gives it, such as a login"},"email":{"type":"email","description":"The assignee's email address"}} },
    notes: { type: "string", description: "Personal annotations" },
    recurrence: { type: "array", description: "RFC 5545 recurrence property lines (RRULE, RDATE, EXDATE) for a task that repeats. The series starts at due_at, or at starts_at when the task has no due_at, and advances in UTC because a task has no timezone. The server keeps and checks the rule but does not unfold it: GET /occurrences answers events only. A write is refused when a line cannot be read or is not applied (EXRULE, an RDATE period), when it carries more than one RRULE, more than 40,000 characters in all or more than 1,000 added and removed dates, when the rule names no date that exists after the start, when it produces no occurrence within the bound a read unfolds a rule to, or when the task has neither due_at nor starts_at.", items_type: "string" },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:square-check-big" },
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
    emails: { type: "array", description: "Email addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    phones: { type: "array", description: "Phone numbers. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"string","description":"The phone number, in E.164 form where known","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    addresses: { type: "array", description: "Postal addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}} },
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
  display_hints: { icon: "lucide:user" },
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
    emails: { type: "array", description: "Email addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    phones: { type: "array", description: "Phone numbers. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"string","description":"The phone number, in E.164 form where known","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    addresses: { type: "array", description: "Postal addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}} },
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
  display_hints: { icon: "lucide:map-pin" },
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
    size_bytes: { type: "integer", description: "Size in bytes of the referenced blob (set by the server from the bytes the instance holds; absent where whoever named blob_ref never proved it holds them)" },
    duration: { type: "number", description: "Length in seconds (server enrichment: derived from the file when the client does not supply it)" },
  },
  display_hints: { icon: "lucide:file-music" },
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
    size_bytes: { type: "integer", description: "Size in bytes of the referenced blob (set by the server from the bytes the instance holds; absent where whoever named blob_ref never proved it holds them)" },
    width: { type: "integer", description: "Width in pixels (server enrichment: derived from the file when the client does not supply it)" },
    height: { type: "integer", description: "Height in pixels (server enrichment: derived from the file when the client does not supply it)" },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters" },
    thumbnail: { type: "thumbnail", description: "A small preview of the image, supplied by the writer" },
  },
  display_hints: { icon: "lucide:file-image" },
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
    size_bytes: { type: "integer", description: "Size in bytes of the referenced blob (set by the server from the bytes the instance holds; absent where whoever named blob_ref never proved it holds them)" },
    width: { type: "integer", description: "Width in pixels (server enrichment: derived from the file when the client does not supply it)" },
    height: { type: "integer", description: "Height in pixels (server enrichment: derived from the file when the client does not supply it)" },
    duration: { type: "number", description: "Length in seconds (server enrichment: derived from the file when the client does not supply it)" },
    latitude: { type: "number", description: "Subject latitude" },
    longitude: { type: "number", description: "Subject longitude" },
    altitude: { type: "number", description: "Altitude in meters" },
  },
  display_hints: { icon: "lucide:file-video-camera" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileWebpage: TypeSchema = {
  id: "core.file.webpage",
  parent: "core.file",
  label: "Web Page",
  description: "An HTML page held as a file, such as a report an agent wrote. Inherits all core.file fields.",
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
    size_bytes: { type: "integer", description: "Size in bytes of the referenced blob (set by the server from the bytes the instance holds; absent where whoever named blob_ref never proved it holds them)" },
  },
  display_hints: { title_field: "title", icon: "lucide:globe" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    release_type: { type: "string", description: "Recommended values: album, ep, single" },
    num_tracks: { type: "integer", description: "Total track count" },
  },
  display_hints: { icon: "lucide:disc-3" },
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
    body: { type: "string", description: "The article text" },
    author: { type: "string", description: "Who created the work" },
    url: { type: "url", description: "Web address" },
    description: { type: "string", description: "Summary or blurb" },
    publisher: { type: "string", description: "Who published the work" },
    published_at: { type: "datetime", description: "When originally published or released" },
    image_url: { type: "url", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    doi: { type: "string", description: "Digital Object Identifier (ISO 26324)" },
    section: { type: "string", description: "Section of the publication" },
    word_count: { type: "integer", description: "Word count" },
  },
  display_hints: { icon: "lucide:newspaper" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    isbn: { type: "string", description: "International Standard Book Number (ISO 2108)" },
    page_count: { type: "integer", description: "Number of pages" },
    edition: { type: "string", description: "Edition designation" },
  },
  display_hints: { icon: "lucide:book-open" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    medium: { type: "enum", description: "What the episode is made of.", enum_values: ["tv", "podcast", "radio", "video", "mixed"] },
    season_number: { type: "integer", description: "Which season, where the series has them" },
    episode_number: { type: "integer", description: "Position within the season, or within the series when unseasoned" },
    duration: { type: "number", description: "Runtime in seconds" },
    media_url: { type: "url", description: "Direct address of the media file itself: an episode's audio or video enclosure, a track's audio file, a film's stream. Distinct from url, which is the web page about the work." },
    mime_type: { type: "string", description: "MIME type of the resource at media_url, such as audio/mpeg or video/mp4. Describes what media_url points at, not what this item is." },
  },
  display_hints: { icon: "lucide:circle-play" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    duration: { type: "number", description: "Runtime in seconds" },
    director: { type: "string", description: "Primary director" },
    content_rating: { type: "string", description: "Age or content classification" },
    media_url: { type: "url", description: "Direct address of the media file itself: an episode's audio or video enclosure, a track's audio file, a film's stream. Distinct from url, which is the web page about the work." },
    mime_type: { type: "string", description: "MIME type of the resource at media_url, such as audio/mpeg or video/mp4. Describes what media_url points at, not what this item is." },
  },
  display_hints: { icon: "lucide:film" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaGame: TypeSchema = {
  id: "core.media.game",
  parent: "core.media",
  label: "Game",
  description: "A video, board or card game. Inherits all core.media fields.",
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    platforms: { type: "array", description: "What the game is played on, such as Nintendo Switch, PC or Tabletop", items_type: "string" },
    min_players: { type: "integer", description: "Fewest players the game supports", minimum: 1 },
    max_players: { type: "integer", description: "Most players the game supports", minimum: 1 },
  },
  display_hints: { icon: "lucide:gamepad-2" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    medium: { type: "enum", description: "What the series is made of.", enum_values: ["tv", "podcast", "radio", "video", "mixed"] },
    status: { type: "enum", description: "Whether the series is still producing new members.", enum_values: ["ongoing", "ended", "canceled"] },
  },
  display_hints: { icon: "lucide:tv" },
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
    progress: { type: "status", description: "Where the owner is with the work: want to read, watch, listen to or play it, started, finished, or gave up", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "The owner's overall view of the work, from 1 (lowest) to 5 (highest)", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Personal annotations" },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by the writer" },
    duration: { type: "number", description: "Track length in seconds" },
    isrc: { type: "string", description: "International Standard Recording Code (ISO 3901)" },
    album: { type: "string", description: "Containing album name" },
    track_number: { type: "integer", description: "Position within the album" },
    media_url: { type: "url", description: "Direct address of the media file itself: an episode's audio or video enclosure, a track's audio file, a film's stream. Distinct from url, which is the web page about the work." },
    mime_type: { type: "string", description: "MIME type of the resource at media_url, such as audio/mpeg or video/mp4. Describes what media_url points at, not what this item is." },
  },
  display_hints: { icon: "lucide:audio-lines" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

export const ALL_TYPES: TypeSchema[] = [
  coreBookmark,
  coreCollection,
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
  coreFileWebpage,
  coreMediaAlbum,
  coreMediaArticle,
  coreMediaBook,
  coreMediaEpisode,
  coreMediaFilm,
  coreMediaGame,
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
    name: { type: "string", description: "The owner's own name for this app's sign-in, set at `PATCH /owner/sign-ins/{id}`. Unset, the app's registered client name names it. Any credential that can read `system.connection` items, such as an app holding the default read bundle, can read this name and the item's ID, which is the sign-in's ID" },
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
    query: { type: "object", description: "Which items the folder holds. `types`: type identifiers, each with its subtypes; empty or absent holds every type the folder's key reads. `tier`: `library`, `feed`, or `all` for both tiers; absent is `library`. `state`: `active`, `archived` or both; absent is both. `filter`: an expression in the listing grammar's `filter`, with no `backref` condition. `beneath`: an item id; the item and everything under it by `parent-of`." },
    defaults: { type: "object", description: "What a new file takes where its frontmatter leaves a blank, never applied to an edit: `type`, `tier`, `properties`, `tags`, and `edges` as a map from edge type to item ids, each edge running from the new file to the item named except `parent-of`, which runs from the item named so the new file is its child; a folder whose query follows an edge gives every new file that edge." },
    include: { type: "array", description: "Paths the folder takes, as gitignore patterns relative to its root; empty or absent takes every path. A dot-led path is taken only where a line names a dot-led name on its way, and no line reaches what the built-in lists name", items_type: "string" },
    ignore: { type: "array", description: "Paths the folder leaves alone, as gitignore patterns relative to its root, winning over `include`; the built-in lists, of files a machine or an editor writes for itself and of secrets, apply whatever either list says", items_type: "string" },
    first_placement: { type: "object", description: "Where a new item of a type made elsewhere first appears: a map from type identifier to a directory relative to the folder's root, with no `..` name. Placement only; it never decides membership." },
    removal_threshold: { type: "object", description: "When a removal pauses for confirmation: more than `files` files and more than `fraction` of the folder at once. Absent members are 10 and 0.25." },
    revoked_at: { type: "datetime", description: "When the folder was revoked" },
  },
};

const systemView: TypeSchema = {
  id: "system.view",
  label: "View",
  description: "A saved list of items, held here and shared by every app: which items, in what order and how they group. How an app shows them is the app's own. Written only through `/views`: created, changed at a version, and deleted, which removes it at once with no trash. Lifecycle bounded to active | revoked. Has no tier.",
  version: 0,
  fields: {
    title: { type: "string", description: "The view's name", required: true },
    query: { type: "object", description: "Which items the view lists. `types`: type identifiers, each with its subtypes; empty or absent lists every type the reading key reads. `tier`: `library`, `feed` or `all`; absent is `all`. `state`: `active`, `archived` or both; absent is both. `filter`: an expression in the listing grammar's `filter`. `beneath`: an item id; the item and everything under it by `parent-of`." },
    sort: { type: "array", description: "The keys the view sorts by, first key first. Each is a `by` field and a `direction`, `asc` or `desc`.", items_type: "object" },
    group: { type: "object", description: "How the view groups the items it lists: `by` (a field, or `edge[<type>]` or `backref[<type>]`), and optionally `bucket` (`day`, `week`, `month` or `year`, for a date field), `order` (the values whose groups come first) and `hidden` (the values whose groups are left out)." },
  },
};

export const ALL_SYSTEM_TYPES: TypeSchema[] = [
  systemConnection,
  systemFolder,
  systemView,
];

export const ALL_TYPE_IDS = [
  "core.bookmark",
  "core.collection",
  "core.entity",
  "core.entity.person",
  "core.entity.place",
  "core.event",
  "core.file",
  "core.file.audio",
  "core.file.image",
  "core.file.video",
  "core.file.webpage",
  "core.highlight",
  "core.media",
  "core.media.album",
  "core.media.article",
  "core.media.book",
  "core.media.episode",
  "core.media.film",
  "core.media.game",
  "core.media.series",
  "core.media.song",
  "core.message",
  "core.note",
  "core.task",
  "system.connection",
  "system.folder",
  "system.view",
] as const;

export type PlatformTypeId = (typeof ALL_TYPE_IDS)[number];

export const SHIPPED_TYPE_SHAPES = {
  "core.bookmark": {
    "display_hints": {
      "body_field": "body",
      "icon": "lucide:bookmark",
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
  "core.collection": {
    "display_hints": {
      "body_field": "description",
      "icon": "lucide:layers",
      "title_field": "title"
    },
    "fields": {
      "description": {
        "type": "string"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "roles": [
      "container"
    ],
    "version": 0
  },
  "core.entity": {
    "display_hints": {
      "icon": "lucide:shapes",
      "title_field": "name"
    },
    "fields": {
      "addresses": {
        "items_fields": {
          "country": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "locality": {
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
          }
        },
        "items_type": "object",
        "type": "array"
      },
      "description": {
        "type": "string"
      },
      "emails": {
        "items_fields": {
          "label": {
            "type": "string"
          },
          "value": {
            "required": true,
            "type": "email"
          }
        },
        "items_type": "object",
        "type": "array"
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
      "phones": {
        "items_fields": {
          "label": {
            "type": "string"
          },
          "value": {
            "required": true,
            "type": "string"
          }
        },
        "items_type": "object",
        "type": "array"
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
      "icon": "lucide:user"
    },
    "fields": {
      "addresses": {
        "items_fields": {
          "country": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "locality": {
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
          }
        },
        "items_type": "object",
        "type": "array"
      },
      "birthday": {
        "type": "date"
      },
      "department": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "emails": {
        "items_fields": {
          "label": {
            "type": "string"
          },
          "value": {
            "required": true,
            "type": "email"
          }
        },
        "items_type": "object",
        "type": "array"
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
      "phones": {
        "items_fields": {
          "label": {
            "type": "string"
          },
          "value": {
            "required": true,
            "type": "string"
          }
        },
        "items_type": "object",
        "type": "array"
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
      "icon": "lucide:map-pin"
    },
    "fields": {
      "addresses": {
        "items_fields": {
          "country": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "locality": {
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
          }
        },
        "items_type": "object",
        "type": "array"
      },
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
      "emails": {
        "items_fields": {
          "label": {
            "type": "string"
          },
          "value": {
            "required": true,
            "type": "email"
          }
        },
        "items_type": "object",
        "type": "array"
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
      "phones": {
        "items_fields": {
          "label": {
            "type": "string"
          },
          "value": {
            "required": true,
            "type": "string"
          }
        },
        "items_type": "object",
        "type": "array"
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
      "icon": "lucide:calendar",
      "title_field": "title"
    },
    "fields": {
      "all_day": {
        "type": "boolean"
      },
      "attendees": {
        "items_fields": {
          "email": {
            "type": "email"
          },
          "name": {
            "type": "string"
          },
          "response": {
            "enum_values": [
              "needs_action",
              "accepted",
              "declined",
              "tentative"
            ],
            "type": "enum"
          }
        },
        "items_type": "object",
        "type": "array"
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
        "enum_values": [
          "tentative",
          "confirmed",
          "canceled"
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
      "icon": "lucide:file",
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
      "size_bytes": {
        "type": "integer"
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
      "icon": "lucide:file-music"
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
      "size_bytes": {
        "type": "integer"
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
      "icon": "lucide:file-image"
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
      "size_bytes": {
        "type": "integer"
      },
      "source_url": {
        "type": "url"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:file-video-camera"
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
      "size_bytes": {
        "type": "integer"
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
  "core.file.webpage": {
    "display_hints": {
      "icon": "lucide:globe",
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
      "size_bytes": {
        "type": "integer"
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
  "core.highlight": {
    "display_hints": {
      "body_field": "note",
      "icon": "lucide:highlighter",
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
      "icon": "lucide:library-big",
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:disc-3"
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "release_type": {
        "type": "string"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:newspaper"
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
      "doi": {
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "section": {
        "type": "string"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:book-open"
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:circle-play"
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "season_number": {
        "type": "integer"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:film"
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "thumbnail": {
        "type": "thumbnail"
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
  "core.media.game": {
    "display_hints": {
      "icon": "lucide:gamepad-2"
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
      "max_players": {
        "minimum": 1,
        "type": "integer"
      },
      "min_players": {
        "minimum": 1,
        "type": "integer"
      },
      "notes": {
        "type": "string"
      },
      "platforms": {
        "items_type": "string",
        "type": "array"
      },
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:tv"
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "status": {
        "enum_values": [
          "ongoing",
          "ended",
          "canceled"
        ],
        "type": "enum"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "icon": "lucide:audio-lines"
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
      "progress": {
        "status_values": [
          {
            "group": "not_started",
            "value": "planned"
          },
          {
            "group": "in_progress",
            "value": "started"
          },
          {
            "group": "completed",
            "value": "finished"
          },
          {
            "group": "canceled",
            "value": "abandoned"
          }
        ],
        "type": "status"
      },
      "published_at": {
        "type": "datetime"
      },
      "publisher": {
        "type": "string"
      },
      "rating": {
        "maximum": 5,
        "minimum": 1,
        "type": "integer"
      },
      "thumbnail": {
        "type": "thumbnail"
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
      "body_field": "body",
      "icon": "lucide:message-square"
    },
    "fields": {
      "body": {
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
      "icon": "lucide:sticky-note",
      "title_field": "title"
    },
    "fields": {
      "body": {
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
      "icon": "lucide:square-check-big",
      "title_field": "title"
    },
    "fields": {
      "assignees": {
        "items_fields": {
          "email": {
            "type": "email"
          },
          "name": {
            "type": "string"
          }
        },
        "items_type": "object",
        "type": "array"
      },
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
      "recurrence": {
        "items_type": "string",
        "type": "array"
      },
      "starts_at": {
        "type": "datetime"
      },
      "status": {
        "status_values": [
          {
            "group": "not_started",
            "value": "not_started"
          },
          {
            "group": "in_progress",
            "value": "in_progress"
          },
          {
            "group": "completed",
            "value": "completed"
          },
          {
            "group": "canceled",
            "value": "canceled"
          }
        ],
        "type": "status"
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
      "name": {
        "type": "string"
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
      "query": {
        "type": "object"
      },
      "removal_threshold": {
        "type": "object"
      },
      "revoked_at": {
        "type": "datetime"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 0
  },
  "system.view": {
    "fields": {
      "group": {
        "type": "object"
      },
      "query": {
        "type": "object"
      },
      "sort": {
        "items_type": "object",
        "type": "array"
      },
      "title": {
        "required": true,
        "type": "string"
      }
    },
    "version": 0
  }
} as const;

