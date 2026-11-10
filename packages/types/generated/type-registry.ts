// Auto-generated from core/*.json and core/system/*.json — do not edit manually.
// Run `pnpm --filter @withmarfa/types generate` to regenerate.

import type { ShippedTypeSchema, TypeSchema } from "../src/schema-types.js";

const coreBookmark: TypeSchema = {
  id: "core.bookmark",
  label: "Bookmark",
  description: "Something you saved from elsewhere, such as a link, a highlighted excerpt or a clipped paragraph.",
  version: 0,
  fields: {
    url: { type: "url", label: "URL", description: "The address of the page you saved." },
    body: { type: "string", description: "The text you captured, such as a highlight, excerpt or clipping." },
    title: { type: "string", description: "The title of the saved content." },
    description: { type: "string", description: "A short summary of the saved content." },
    source_url: { type: "url", label: "Source URL", description: "Where the content was sourced from" },
    source_title: { type: "string", description: "Title of the source" },
    author: { type: "string", description: "Who created the original content" },
    published_at: { type: "datetime", label: "Published", description: "When the original content was published" },
    image_url: { type: "url", label: "Image URL", description: "Preview image" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the saved content." },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:bookmark" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreCollection: TypeSchema = {
  id: "core.collection",
  label: "Collection",
  description: "A named group of items of any type, such as a reading list or the plans for a trip.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the collection.", required: true },
    description: { type: "string", description: "What the collection is for." },
  },
  display_hints: { title_field: "title", body_field: "description", icon: "lucide:layers" },
  merge_policy: { default: "last_writer_wins" },
  roles: ["container"],
};

const coreConversation: ShippedTypeSchema = {
  id: "core.conversation",
  label: "Conversation",
  description: "A conversation, such as a chat with a person or an assistant. Its messages are the rows of its messages table.",
  version: 0,
  fields: {
    title: { type: "string", description: "The conversation's name." },
  },
  tables: {"messages":{"description":"The messages of the conversation, kept in the order they were sent.","order":"sent_at","columns":{"author":{"type":"string","description":"Who wrote the message, such as a name, a handle or `assistant`.","required":true},"text":{"type":"string","description":"What the message says. A message may have no text and only an attachment.","searchable":true},"sent_at":{"type":"datetime","description":"When the message was sent.","required":true},"attachment":{"type":"item","description":"A picture or other file the message carries.","type_constraints":["core.file"]}}}},
  display_hints: { title_field: "title", icon: "lucide:messages-square" },
  merge_policy: { default: "last_writer_wins" },
};

const coreEntity: TypeSchema = {
  id: "core.entity",
  label: "Entity",
  description: "Someone or something with a name, such as a person, company, band, team, charity, brand, school or place.",
  version: 0,
  fields: {
    name: { type: "string", description: "The name to show for the entity.", required: true },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short description of the entity." },
    emails: { type: "array", description: "Email addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"email","label":"Email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    phones: { type: "array", label: "Phone Numbers", description: "Phone numbers. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"string","label":"Number","description":"The phone number, in E.164 form where known","required":true,"format":"phone"},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    addresses: { type: "array", description: "Postal addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}} },
    image_url: { type: "url", label: "Image URL", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Your own comments, kept apart from the entity's details." },
  },
  display_hints: { title_field: "name", icon: "lucide:shapes" },
  merge_policy: { default: "last_writer_wins" },
};

const coreEvent: TypeSchema = {
  id: "core.event",
  label: "Event",
  description: "Something that happens at a time, such as a meeting, a flight or a birthday.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the event.", required: true },
    description: { type: "string", description: "A short description of the event." },
    starts_at: { type: "datetime", label: "Starts", description: "When the event starts, as an ISO 8601 instant. `timezone` says which local time it means." },
    ends_at: { type: "datetime", label: "Ends", description: "When the event ends, as an ISO 8601 instant." },
    duration: { type: "number", description: "How long the event lasts, in seconds. For a repeating event with no `ends_at`, it is the length of each occurrence." },
    place: { type: "string", description: "Where the event happens, as a name or an address." },
    latitude: { type: "number", description: "Venue latitude" },
    longitude: { type: "number", description: "Venue longitude" },
    url: { type: "url", label: "URL", description: "A web page about the event." },
    precision: { type: "enum", description: "How much of the start is known, such as only the year, for an event dated from memory.", enum_values: ["year", "month", "day", "time"] },
    status: { type: "enum", description: "Whether the event will happen.", enum_values: ["tentative", "confirmed", "canceled"] },
    notes: { type: "string", description: "Your own comments, kept apart from the event's details." },
    recurrence: { type: "array", description: "RFC 5545 recurrence lines (RRULE, RDATE, EXDATE) that make the event repeat. Marfa works out the occurrences when they are read instead of storing them.", items_type: "string" },
    all_day: { type: "boolean", description: "True when the event lasts whole days rather than a span of time. Read the date from `starts_at` in the event's `timezone`." },
    timezone: { type: "string", label: "Time Zone", description: "The IANA time zone the event keeps its local hour in, such as Europe/Berlin. A repeating event keeps that hour across daylight saving changes." },
    end_timezone: { type: "string", label: "End Time Zone", description: "The IANA time zone the event ends in, when it differs from `timezone`, such as a flight that lands in another zone." },
    attendees: { type: "array", description: "The people invited, one entry each. An entry has a name, an email or both, and the person's reply.", items_type: "object", items_fields: {"name":{"type":"string","description":"The attendee's name as the source gives it"},"email":{"type":"email","description":"The attendee's email address"},"response":{"type":"enum","description":"The attendee's reply to the invitation","enum_values":["needs_action","accepted","declined","tentative"]}} },
    original_starts_at: { type: "datetime", label: "Original Start", description: "For an event that replaces one occurrence of a repeating event, the start of the occurrence it replaces." },
  },
  display_hints: { title_field: "title", body_field: "description", icon: "lucide:calendar" },
  merge_policy: { fields: { notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreFile: TypeSchema = {
  id: "core.file",
  label: "File",
  description: "A file you keep, such as a PDF or a spreadsheet.",
  version: 0,
  fields: {
    blob_ref: { type: "string", label: "Blob Reference", description: "A reference to the file's contents, written as sha256: followed by the hex digest.", required: true },
    mime_type: { type: "string", label: "MIME Type", description: "The file's MIME type, such as application/pdf.", required: true },
    title: { type: "string", description: "The file's name or title." },
    description: { type: "string", description: "What the file contains." },
    url: { type: "url", label: "URL", description: "Web address" },
    source_url: { type: "url", label: "Source URL", description: "Where the file came from." },
    author: { type: "string", description: "Who made the file." },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the file's details." },
    extracted_text: { type: "string", description: "Text the server reads out of the file, such as document text or the words in an image." },
    executable: { type: "boolean", description: "Whether the file may be run as a program. Absent means it may not." },
    size_bytes: { type: "integer", label: "Size", description: "The size of the file in bytes, set by the server once the instance holds the file's bytes." },
  },
  display_hints: { title_field: "title", icon: "lucide:file" },
  merge_policy: { default: "last_writer_wins" },
};

const coreHighlight: TypeSchema = {
  id: "core.highlight",
  label: "Highlight",
  description: "A passage you highlighted, with any note you added.",
  version: 0,
  fields: {
    text: { type: "string", description: "The highlighted passage, as Markdown.", required: true },
    note: { type: "string", description: "Your note on the passage." },
    color: { type: "enum", description: "The color of the highlight.", enum_values: ["yellow", "blue", "green", "pink", "orange", "purple"] },
    locator_type: { type: "enum", description: "How to read `start_location` and `end_location`.", enum_values: ["offset", "page", "time", "cfi", "order", "none"] },
    start_location: { type: "string", description: "Where the highlight starts, read as `locator_type` says." },
    end_location: { type: "string", description: "Where the highlight ends, read as `locator_type` says." },
  },
  display_hints: { body_field: "text", name_from_body: false, icon: "lucide:highlighter" },
  merge_policy: { fields: { note: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMedia: TypeSchema = {
  id: "core.media",
  label: "Media",
  plural: "Media",
  description: "Something someone made that you read, watch, listen to or play, such as a film, podcast, book, article, song, show or game.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:library-big" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMessage: TypeSchema = {
  id: "core.message",
  label: "Message",
  description: "A message you sent or received, such as a text or a chat message.",
  version: 0,
  fields: {
    body: { type: "string", description: "The text of the message." },
    from: { type: "string", description: "Who sent the message, such as a phone number, an email address or a handle.", required: true },
    to: { type: "array", description: "Who received the message, written the same way as `from`.", items_type: "string" },
  },
  display_hints: { body_field: "body", icon: "lucide:message-square" },
  merge_policy: { fields: { body: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreNote: TypeSchema = {
  id: "core.note",
  label: "Note",
  description: "Text you wrote, such as a thought, a meeting note or a list.",
  version: 0,
  fields: {
    body: { type: "string", description: "The text of the note." },
    title: { type: "string", description: "The note's heading." },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the note's text." },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:sticky-note" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreTask: TypeSchema = {
  id: "core.task",
  label: "Task",
  description: "Something you need to do, such as booking flights or sending an invoice.",
  version: 0,
  fields: {
    title: { type: "string", description: "What needs doing.", required: true },
    description: { type: "string", description: "A line or two of context." },
    body: { type: "string", description: "The full details, as long as you need." },
    due_at: { type: "datetime", label: "Due", description: "When the task is due." },
    starts_at: { type: "datetime", label: "Starts", description: "When you plan to start the task." },
    completed_at: { type: "datetime", label: "Completed", description: "When you finished the task." },
    status: { type: "status", description: "Where the task stands", status_values: [{ value: "not_started", group: "not_started" }, { value: "in_progress", group: "in_progress" }, { value: "completed", group: "completed" }, { value: "canceled", group: "canceled" }] },
    priority: { type: "enum", description: "How important the task is.", enum_values: ["low", "medium", "high", "urgent"] },
    place: { type: "string", description: "Where the task is done." },
    precision: { type: "enum", description: "How much of the task's date is known, such as only the year or the month.", enum_values: ["year", "month", "day", "time"] },
    url: { type: "url", label: "URL", description: "A web page related to the task." },
    assignees: { type: "array", description: "The people the task is assigned to, one entry each. An entry has a name, an email or both.", items_type: "object", items_fields: {"name":{"type":"string","description":"The assignee's name as the source gives it, such as a login"},"email":{"type":"email","description":"The assignee's email address"}} },
    notes: { type: "string", description: "Your own comments, kept apart from the task's details." },
    recurrence: { type: "array", description: "RFC 5545 recurrence lines (RRULE, RDATE, EXDATE) that make the task repeat, counted from `due_at` or, without one, from `starts_at`.", items_type: "string" },
  },
  display_hints: { title_field: "title", body_field: "body", icon: "lucide:square-check-big" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreEntityPerson: TypeSchema = {
  id: "core.entity.person",
  parent: "core.entity",
  label: "Person",
  plural: "People",
  description: "A person, with their name, contact details and job.",
  version: 0,
  fields: {
    name: { type: "string", description: "The name to show for the entity.", required: true },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short description of the entity." },
    emails: { type: "array", description: "Email addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"email","label":"Email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    phones: { type: "array", label: "Phone Numbers", description: "Phone numbers. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"string","label":"Number","description":"The phone number, in E.164 form where known","required":true,"format":"phone"},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    addresses: { type: "array", description: "Postal addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}} },
    image_url: { type: "url", label: "Image URL", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Your own comments, kept apart from the entity's details." },
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
  description: "A place, such as a cafe, an office or a city, with its address and coordinates.",
  version: 0,
  fields: {
    name: { type: "string", description: "The name to show for the entity.", required: true },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short description of the entity." },
    emails: { type: "array", description: "Email addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"email","label":"Email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    phones: { type: "array", label: "Phone Numbers", description: "Phone numbers. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"value":{"type":"string","label":"Number","description":"The phone number, in E.164 form where known","required":true,"format":"phone"},"label":{"type":"string","description":"What the entry is for, such as work or home"}} },
    addresses: { type: "array", description: "Postal addresses. The first entry is the main one, and an entry's label is free text, such as work or home.", items_type: "object", items_fields: {"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}} },
    image_url: { type: "url", label: "Image URL", description: "Logo or brand image" },
    legal_name: { type: "string", description: "Official registered name" },
    founded: { type: "date", description: "Founding date (ISO 8601)" },
    notes: { type: "string", description: "Your own comments, kept apart from the entity's details." },
    street_address: { type: "string", description: "Street line" },
    locality: { type: "string", description: "City or town" },
    region: { type: "string", description: "State, province, or county" },
    postal_code: { type: "string", description: "Postcode or ZIP code" },
    country: { type: "string", description: "ISO 3166-1 alpha-2 country code", format: "iso3166" },
    timezone: { type: "string", label: "Time Zone", description: "IANA timezone" },
    latitude: { type: "number", description: "Latitude of the place." },
    longitude: { type: "number", description: "Longitude of the place." },
    altitude: { type: "number", description: "Altitude in meters above sea level" },
  },
  display_hints: { icon: "lucide:map-pin" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileAudio: TypeSchema = {
  id: "core.file.audio",
  parent: "core.file",
  label: "Audio",
  plural: "Audio",
  description: "A recording, a music file or a voice memo.",
  version: 0,
  fields: {
    blob_ref: { type: "string", label: "Blob Reference", description: "A reference to the file's contents, written as sha256: followed by the hex digest.", required: true },
    mime_type: { type: "string", label: "MIME Type", description: "The file's MIME type, such as application/pdf.", required: true },
    title: { type: "string", description: "The file's name or title." },
    description: { type: "string", description: "What the file contains." },
    url: { type: "url", label: "URL", description: "Web address" },
    source_url: { type: "url", label: "Source URL", description: "Where the file came from." },
    author: { type: "string", description: "Who made the file." },
    language: { type: "string", description: "BCP 47 language code of the speech.", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the file's details." },
    extracted_text: { type: "string", description: "Text the server reads out of the file, such as document text or the words in an image." },
    executable: { type: "boolean", description: "Whether the file may be run as a program. Absent means it may not." },
    size_bytes: { type: "integer", label: "Size", description: "The size of the file in bytes, set by the server once the instance holds the file's bytes." },
    duration: { type: "number", description: "Length in seconds. The server fills it in from the file if you leave it out." },
  },
  display_hints: { icon: "lucide:file-music" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileImage: TypeSchema = {
  id: "core.file.image",
  parent: "core.file",
  label: "Image",
  description: "A photo, a screenshot or a diagram.",
  version: 0,
  fields: {
    blob_ref: { type: "string", label: "Blob Reference", description: "A reference to the file's contents, written as sha256: followed by the hex digest.", required: true },
    mime_type: { type: "string", label: "MIME Type", description: "The file's MIME type, such as application/pdf.", required: true },
    title: { type: "string", description: "The file's name or title." },
    description: { type: "string", description: "What the file contains." },
    url: { type: "url", label: "URL", description: "Web address" },
    source_url: { type: "url", label: "Source URL", description: "Where the file came from." },
    author: { type: "string", description: "Who made the file." },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the file's details." },
    extracted_text: { type: "string", description: "Text the server reads out of the file, such as document text or the words in an image." },
    executable: { type: "boolean", description: "Whether the file may be run as a program. Absent means it may not." },
    size_bytes: { type: "integer", label: "Size", description: "The size of the file in bytes, set by the server once the instance holds the file's bytes." },
    width: { type: "integer", description: "Width in pixels. The server fills it in from the file if you leave it out." },
    height: { type: "integer", description: "Height in pixels. The server fills it in from the file if you leave it out." },
    latitude: { type: "number", description: "Latitude of what the image shows." },
    longitude: { type: "number", description: "Longitude of what the image shows." },
    altitude: { type: "number", description: "The altitude of what the image shows, in meters." },
    thumbnail: { type: "thumbnail", description: "A small preview of the image, supplied by whoever saved it." },
  },
  display_hints: { icon: "lucide:file-image" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileVideo: TypeSchema = {
  id: "core.file.video",
  parent: "core.file",
  label: "Video",
  description: "A video file, such as a clip or a screen recording.",
  version: 0,
  fields: {
    blob_ref: { type: "string", label: "Blob Reference", description: "A reference to the file's contents, written as sha256: followed by the hex digest.", required: true },
    mime_type: { type: "string", label: "MIME Type", description: "The file's MIME type, such as application/pdf.", required: true },
    title: { type: "string", description: "The file's name or title." },
    description: { type: "string", description: "What the file contains." },
    url: { type: "url", label: "URL", description: "Web address" },
    source_url: { type: "url", label: "Source URL", description: "Where the file came from." },
    author: { type: "string", description: "Who made the file." },
    language: { type: "string", description: "BCP 47 language code of the speech.", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the file's details." },
    extracted_text: { type: "string", description: "Text the server reads out of the file, such as document text or the words in an image." },
    executable: { type: "boolean", description: "Whether the file may be run as a program. Absent means it may not." },
    size_bytes: { type: "integer", label: "Size", description: "The size of the file in bytes, set by the server once the instance holds the file's bytes." },
    width: { type: "integer", description: "Width in pixels. The server fills it in from the file if you leave it out." },
    height: { type: "integer", description: "Height in pixels. The server fills it in from the file if you leave it out." },
    duration: { type: "number", description: "Length in seconds. The server fills it in from the file if you leave it out." },
    latitude: { type: "number", description: "Latitude of what the video shows." },
    longitude: { type: "number", description: "Longitude of what the video shows." },
    altitude: { type: "number", description: "The altitude of what the video shows, in meters." },
  },
  display_hints: { icon: "lucide:file-video-camera" },
  merge_policy: { default: "last_writer_wins" },
};

const coreFileWebpage: TypeSchema = {
  id: "core.file.webpage",
  parent: "core.file",
  label: "Web Page",
  description: "A web page saved as an HTML file, such as a report an agent wrote.",
  version: 0,
  fields: {
    blob_ref: { type: "string", label: "Blob Reference", description: "A reference to the file's contents, written as sha256: followed by the hex digest.", required: true },
    mime_type: { type: "string", label: "MIME Type", description: "The file's MIME type, such as application/pdf.", required: true },
    title: { type: "string", description: "The file's name or title." },
    description: { type: "string", description: "What the file contains." },
    url: { type: "url", label: "URL", description: "Web address" },
    source_url: { type: "url", label: "Source URL", description: "Where the file came from." },
    author: { type: "string", description: "Who made the file." },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    notes: { type: "string", description: "Your own comments, kept apart from the file's details." },
    extracted_text: { type: "string", description: "Text the server reads out of the file, such as document text or the words in an image." },
    executable: { type: "boolean", description: "Whether the file may be run as a program. Absent means it may not." },
    size_bytes: { type: "integer", label: "Size", description: "The size of the file in bytes, set by the server once the instance holds the file's bytes." },
  },
  display_hints: { title_field: "title", icon: "lucide:globe" },
  merge_policy: { default: "last_writer_wins" },
};

const coreMediaAlbum: TypeSchema = {
  id: "core.media.album",
  parent: "core.media",
  label: "Album",
  description: "A music album, EP or single.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    release_type: { type: "string", description: "The kind of release, such as album, ep or single." },
    num_tracks: { type: "integer", label: "Tracks", description: "Total track count" },
  },
  display_hints: { icon: "lucide:disc-3" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
  roles: ["container"],
};

const coreMediaArticle: TypeSchema = {
  id: "core.media.article",
  parent: "core.media",
  label: "Article",
  description: "An article, such as a blog post or a news story.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The article text" },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    doi: { type: "string", label: "DOI", description: "Digital Object Identifier (ISO 26324)" },
    section: { type: "string", description: "Section of the publication" },
    word_count: { type: "integer", label: "Words", description: "Word count" },
  },
  display_hints: { icon: "lucide:newspaper" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaBook: TypeSchema = {
  id: "core.media.book",
  parent: "core.media",
  label: "Book",
  description: "A book, with details such as its ISBN and page count.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    isbn: { type: "string", label: "ISBN", description: "International Standard Book Number (ISO 2108)" },
    page_count: { type: "integer", label: "Pages", description: "Number of pages" },
    edition: { type: "string", description: "Edition designation" },
  },
  display_hints: { icon: "lucide:book-open" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaEpisode: TypeSchema = {
  id: "core.media.episode",
  parent: "core.media",
  label: "Episode",
  description: "One episode of a TV show, a podcast or another series.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    medium: { type: "enum", description: "What kind of episode it is.", enum_values: ["tv", "podcast", "radio", "video", "mixed"] },
    season_number: { type: "integer", description: "Which season, where the series has them" },
    episode_number: { type: "integer", description: "Position within the season, or within the series when unseasoned" },
    duration: { type: "number", description: "Runtime in seconds" },
    media_url: { type: "url", label: "Media URL", description: "The address of the media file itself, such as an audio file or a video stream. Unlike `url`, it is not the web page about the work." },
    mime_type: { type: "string", label: "MIME Type", description: "The MIME type of the file at `media_url`, such as audio/mpeg or video/mp4." },
  },
  display_hints: { icon: "lucide:circle-play" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaFilm: TypeSchema = {
  id: "core.media.film",
  parent: "core.media",
  label: "Film",
  description: "A film.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    duration: { type: "number", description: "Runtime in seconds" },
    director: { type: "string", description: "Primary director" },
    content_rating: { type: "string", description: "Age or content classification" },
    media_url: { type: "url", label: "Media URL", description: "The address of the media file itself, such as an audio file or a video stream. Unlike `url`, it is not the web page about the work." },
    mime_type: { type: "string", label: "MIME Type", description: "The MIME type of the file at `media_url`, such as audio/mpeg or video/mp4." },
  },
  display_hints: { icon: "lucide:film" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaGame: TypeSchema = {
  id: "core.media.game",
  parent: "core.media",
  label: "Game",
  description: "A video game, board game or card game.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    platforms: { type: "array", description: "What the game is played on, such as Nintendo Switch, PC or Tabletop", items_type: "string" },
    min_players: { type: "integer", label: "Minimum Players", description: "Fewest players the game supports", minimum: 1 },
    max_players: { type: "integer", label: "Maximum Players", description: "Most players the game supports", minimum: 1 },
  },
  display_hints: { icon: "lucide:gamepad-2" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

const coreMediaSeries: TypeSchema = {
  id: "core.media.series",
  parent: "core.media",
  label: "Series",
  plural: "Series",
  description: "A TV show, podcast, radio serial or video series that is made of episodes.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    medium: { type: "enum", description: "What kind of series it is.", enum_values: ["tv", "podcast", "radio", "video", "mixed"] },
    status: { type: "enum", description: "Whether the series is still producing new episodes.", enum_values: ["ongoing", "ended", "canceled"] },
  },
  display_hints: { icon: "lucide:tv" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
  roles: ["container"],
};

const coreMediaSong: TypeSchema = {
  id: "core.media.song",
  parent: "core.media",
  label: "Song",
  description: "A song.",
  version: 0,
  fields: {
    title: { type: "string", description: "The name of the work.", required: true },
    body: { type: "string", description: "The text of the work, or a longer write-up of it." },
    author: { type: "string", description: "Who made the work." },
    url: { type: "url", label: "URL", description: "Web address" },
    description: { type: "string", description: "A short summary or blurb." },
    publisher: { type: "string", description: "Who published the work." },
    published_at: { type: "datetime", label: "Published", description: "When originally published or released" },
    image_url: { type: "url", label: "Image URL", description: "Cover art, poster, or thumbnail" },
    language: { type: "string", description: "BCP 47 language code", format: "bcp47" },
    progress: { type: "status", description: "Where you are with the work, such as whether you have started or finished it.", status_values: [{ value: "planned", group: "not_started" }, { value: "started", group: "in_progress" }, { value: "finished", group: "completed" }, { value: "abandoned", group: "canceled" }] },
    rating: { type: "integer", description: "Your overall view of the work, from 1 (lowest) to 5 (highest).", minimum: 1, maximum: 5 },
    notes: { type: "string", description: "Your own comments, kept apart from the work's details." },
    thumbnail: { type: "thumbnail", description: "A small preview of the work, supplied by whoever saved it." },
    duration: { type: "number", description: "Track length in seconds" },
    isrc: { type: "string", label: "ISRC", description: "International Standard Recording Code (ISO 3901)" },
    album: { type: "string", description: "Containing album name" },
    track_number: { type: "integer", description: "Position within the album" },
    media_url: { type: "url", label: "Media URL", description: "The address of the media file itself, such as an audio file or a video stream. Unlike `url`, it is not the web page about the work." },
    mime_type: { type: "string", label: "MIME Type", description: "The MIME type of the file at `media_url`, such as audio/mpeg or video/mp4." },
  },
  display_hints: { icon: "lucide:audio-lines" },
  merge_policy: { fields: { body: "keep_both_copies", notes: "keep_both_copies" }, default: "last_writer_wins" },
};

export const ALL_TYPES: TypeSchema[] = [
  coreBookmark,
  coreCollection,
  coreConversation,
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
  description: "An app you signed in to Marfa, with the access you gave it and when it last used it.",
  version: 0,
  fields: {
    kind: { type: "enum", description: "The kind of connection.", required: true, enum_values: ["app"] },
    client_id: { type: "string", description: "The app's OAuth client ID." },
    name: { type: "string", description: "Your own name for this app's sign-in. Without one, the app's registered name is used." },
    scopes: { type: "array", description: "The scopes you granted the app.", items_type: "string" },
    status: { type: "enum", description: "Whether the sign-in is active or revoked.", required: true, enum_values: ["active", "revoked"] },
    granted_at: { type: "datetime", description: "When you approved the app.", required: true },
    last_used_at: { type: "datetime", description: "When the app last used the sign-in successfully." },
    revoked_at: { type: "datetime", description: "When you revoked the sign-in, if you did." },
  },
};

const systemFolder: TypeSchema = {
  id: "system.folder",
  label: "Folder",
  description: "A folder kept in sync with Marfa, with which items it holds and how new files are filed, shared by every machine that uses it.",
  version: 0,
  fields: {
    title: { type: "string", description: "The folder's name.", required: true },
    query: { type: "object", description: "Which items the folder holds, chosen by type, tier, state, a filter or a position under an item." },
    defaults: { type: "object", description: "What a new file gets where its frontmatter leaves a blank: type, tier, properties, tags and edges. It is never applied to an edited file." },
    include: { type: "array", description: "Paths the folder takes, as gitignore patterns relative to its root. Empty takes every path.", items_type: "string" },
    ignore: { type: "array", description: "Paths the folder leaves alone, as gitignore patterns relative to its root. It wins over `include`.", items_type: "string" },
    first_placement: { type: "object", description: "Where a new item of a type made elsewhere first appears: a map from type to a directory under the folder's root." },
    removal_threshold: { type: "object", description: "When removing files pauses for confirmation: more than `files` files and more than `fraction` of the folder at once. Defaults to 10 and 0.25." },
    full_pass_interval_seconds: { type: "integer", description: "Seconds between the watch's passes that read every file in the folder, from 60 to 86400. Defaults to 600." },
    addition_threshold: { type: "object", description: "When new files pause for confirmation: a scan that would add more than `files` files and more than `fraction` of the folder's files. Defaults to 50 and 0.25." },
    outside_query: { type: "enum", description: "What the folder does with a new file its query would not hold: send it and keep it flagged unmatched, or hold it on disk, not sent. Defaults to send.", enum_values: ["send", "hold"] },
    revoked_at: { type: "datetime", description: "When the folder was revoked." },
  },
};

const systemView: TypeSchema = {
  id: "system.view",
  label: "View",
  description: "A saved list of items, with the order and grouping you chose, shared by every app.",
  version: 0,
  fields: {
    title: { type: "string", description: "The view's name.", required: true },
    query: { type: "object", description: "Which items the view lists, chosen by type, tier, state, a filter or a position under an item." },
    sort: { type: "array", description: "The keys the view sorts by, first key first. Each has a `by` field and a `direction`, `asc` or `desc`.", items_type: "object" },
    group: { type: "object", description: "How the view groups its items: by a field or an edge, optionally in day, week, month or year buckets, with the group order and any hidden groups." },
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
  "core.conversation",
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
  "core.conversation": {
    "display_hints": {
      "icon": "lucide:messages-square",
      "title_field": "title"
    },
    "fields": {
      "title": {
        "type": "string"
      }
    },
    "merge_policy": {
      "default": "last_writer_wins"
    },
    "tables": {
      "messages": {
        "columns": {
          "attachment": {
            "type": "item",
            "type_constraints": [
              "core.file"
            ]
          },
          "author": {
            "required": true,
            "type": "string"
          },
          "sent_at": {
            "required": true,
            "type": "datetime"
          },
          "text": {
            "searchable": true,
            "type": "string"
          }
        },
        "order": "sent_at"
      }
    },
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
            "format": "phone",
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
            "format": "phone",
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
            "format": "phone",
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
      "body_field": "text",
      "icon": "lucide:highlighter",
      "name_from_body": false
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
      "addition_threshold": {
        "type": "object"
      },
      "defaults": {
        "type": "object"
      },
      "first_placement": {
        "type": "object"
      },
      "full_pass_interval_seconds": {
        "type": "integer"
      },
      "ignore": {
        "items_type": "string",
        "type": "array"
      },
      "include": {
        "items_type": "string",
        "type": "array"
      },
      "outside_query": {
        "enum_values": [
          "send",
          "hold"
        ],
        "type": "enum"
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

