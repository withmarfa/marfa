-- A database Marfa v0.0.90 wrote, at schema version 3, as a text dump. It is frozen: never
-- regenerate it, and never edit it. A build that upgrades it runs migrations 4 to 12.
--
-- Made by: the published release marfa-0.0.90-darwin-arm64.tar.gz (checksum checked against
-- marfa-0.0.90-checksums.txt), its marfa-server started with no test hooks on an empty data
-- folder (MARFA_NO_KEYCHAIN=1, MARFA_DATABASE_PATH, MARFA_BLOB_PATH, MARFA_PORT,
-- MARFA_LISTEN_HOST, MARFA_CONTROL_SOCKET, MARFA_AUTH_SECRET), then over its private socket
-- POST /_control/setup/claim for the owner conformance-owner and POST /keys for the working
-- key below, then over HTTP POST /types, POST /items and POST /edges for the witness data
-- below. Stopped with SIGTERM, then `sqlite3 marfa.db .dump` (SQLite 3.54.0), with
-- PRAGMA user_version = 3 added at the end because .dump does not write it.
--
-- Test-only key salt the release generated beside the database (marfa.secrets, key_salt), which a
-- key is valid only against; a server started on this file is given it as MARFA_KEY_SALT:
--   7cfda7f179b0d70e6efd313c6557d3373939fa041fcfd865246abbc0b87c02c7
--
-- Two changes were made to the dump: PRAGMA user_version = 3 at the end, as above, and the disk store's
-- path in the stores table, which named the folder it was made in, is now /data/blobs.
--
-- Loading it needs a connection with defensive mode off, because the dump writes the schema
-- of its two full-text tables and their shadow tables.
--
-- Test-only working key (api_keys holds only its hash; it holds every content permission):
--   marfa_k1_e44eeff0eb91f8df57ecbe088e4a903dde5a66a38f2e3231feeae41ebe0a477a
--
-- Witness data, all with source upgrade-fixture:
--   type user.upgrade_witness, parent core.note, fields priority (string) and stars (number)
--   item 01f00000-0000-7000-8000-000000000001, a user.upgrade_witness: body "first witness",
--     priority "high", stars 3, tags "witness" and "one"
--   item 01f00000-0000-7000-8000-000000000002, a user.upgrade_witness: body "second witness",
--     priority "low", stars 1
--   item 01f00000-0000-7000-8000-000000000003, a core.note: body "a core note"
--   edge 01f00000-0000-7000-8000-0000000000e1, "about", from item 3 to item 1
/* WARNING: Script requires that SQLITE_DBCONFIG_DEFENSIVE be disabled */
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE instance (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO instance VALUES('catalog_generation','2');
INSERT INTO instance VALUES('claimed_at','2026-11-22T22:12:24.732Z');
INSERT INTO instance VALUES('cursor_secret','5ff10b189804e03479e59ca075cc2defc883f326b2700ddb8cd2ef439f0553b4');
INSERT INTO instance VALUES('health_probe','2026-11-22T22:12:18.029Z');
INSERT INTO instance VALUES('id','01a20551-266b-7488-972f-2199b7af2ecb');
INSERT INTO instance VALUES('owner_id','01a20551-501c-7195-83a1-94de5e30d8fc');
INSERT INTO instance VALUES('reach_counter','1');
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL CHECK (length(label) > 0),
    source TEXT NOT NULL CHECK (length(source) > 0),
    default_tier TEXT NOT NULL DEFAULT 'library' CHECK (default_tier IN ('library', 'feed')),
    oauth_client_id TEXT,
    permissions TEXT NOT NULL CHECK (json_valid(permissions)),
    type_permissions TEXT NOT NULL CHECK (json_valid(type_permissions)),
    edge_permissions TEXT NOT NULL CHECK (json_valid(edge_permissions)),
    extension_permissions TEXT NOT NULL CHECK (json_valid(extension_permissions)),
    metadata_permissions TEXT NOT NULL CHECK (json_valid(metadata_permissions)),
    profile_permissions TEXT NOT NULL CHECK (json_valid(profile_permissions)),
    enforcement_override TEXT CHECK (
        enforcement_override IS NULL OR json_valid(enforcement_override)
    ),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
) STRICT, WITHOUT ROWID;
INSERT INTO api_keys VALUES('01a20551-502b-763f-8813-6908e83cb77c','c8c00a175608df0b90c5354cc61518fb41bcd0153d1102f9ef6c6a0edd1a444f','upgrade-fixture','upgrade-fixture','library',NULL,'["schema.write","grants.manage","items.purge","keys.mint","config.manage","audit.read","webhooks.manage"]','{"*":"write"}','{"*":"write"}','{"*":"write"}','{"*":"write"}','{"*":"write"}',NULL,'2026-11-22T22:12:24.746Z',NULL,'2026-11-22T22:12:28.087Z',NULL);
CREATE TABLE api_key_sources (
    key_id TEXT NOT NULL REFERENCES api_keys (id),
    source TEXT NOT NULL CHECK (length(source) > 0),
    position INTEGER NOT NULL,
    PRIMARY KEY (key_id, source)
) STRICT, WITHOUT ROWID;
CREATE TABLE source_names (
    source TEXT PRIMARY KEY CHECK (length(source) > 0),
    name TEXT,
    mark TEXT,
    updated_at TEXT NOT NULL,
    CHECK (name IS NOT NULL OR mark IS NOT NULL)
) STRICT, WITHOUT ROWID;
CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    key_id TEXT,
    actor TEXT CHECK (actor IS NULL OR json_valid(actor)),
    action TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'data', 'settings', 'housekeeping')),
    resource_type TEXT,
    resource_id TEXT,
    client_ip TEXT,
    details TEXT CHECK (details IS NULL OR json_valid(details))
) STRICT, WITHOUT ROWID;
INSERT INTO audit_log VALUES('01a20551-26a3-7446-8049-878aeaeb4e8b','2026-11-22T22:12:14.114Z',NULL,'{"kind":"server","id":"server","name":"Marfa"}','instance.setup_code.issued','access','instance','01a20551-266b-7488-972f-2199b7af2ecb',NULL,'{}');
INSERT INTO audit_log VALUES('01a20551-501c-7195-83a1-94df13115c02','2026-11-22T22:12:24.732Z','local:process','{"kind":"local","id":"local","name":"Local command"}','owner.claimed','access','owner','01a20551-501c-7195-83a1-94de5e30d8fc',NULL,'{}');
INSERT INTO audit_log VALUES('01a20551-502b-763f-8813-69091f2cdb16','2026-11-22T22:12:24.746Z','local:process','{"kind":"local","id":"local","name":"Local command"}','key.create','access','key','01a20551-502b-763f-8813-6908e83cb77c',NULL,'{"actor":"local:process"}');
INSERT INTO audit_log VALUES('01a20551-8168-753d-a554-0b04920f3c12','2026-11-22T22:12:37.349Z','01a20551-502b-763f-8813-6908e83cb77c','{"kind":"key","id":"01a20551-502b-763f-8813-6908e83cb77c","name":"upgrade-fixture"}','type.register','data','type','user.upgrade_witness','127.0.0.1','{}');
INSERT INTO audit_log VALUES('01a20551-8184-70bc-b3f6-f19ea11f6618','2026-11-22T22:12:37.378Z','01a20551-502b-763f-8813-6908e83cb77c','{"kind":"key","id":"01a20551-502b-763f-8813-6908e83cb77c","name":"upgrade-fixture"}','item.create','data','item','01f00000-0000-7000-8000-000000000001','127.0.0.1','{"type":"user.upgrade_witness"}');
INSERT INTO audit_log VALUES('01a20551-8193-7502-87e6-e5518049af65','2026-11-22T22:12:37.394Z','01a20551-502b-763f-8813-6908e83cb77c','{"kind":"key","id":"01a20551-502b-763f-8813-6908e83cb77c","name":"upgrade-fixture"}','item.create','data','item','01f00000-0000-7000-8000-000000000002','127.0.0.1','{"type":"user.upgrade_witness"}');
INSERT INTO audit_log VALUES('01a20551-819f-7248-a18e-b227cd1a6da6','2026-11-22T22:12:37.407Z','01a20551-502b-763f-8813-6908e83cb77c','{"kind":"key","id":"01a20551-502b-763f-8813-6908e83cb77c","name":"upgrade-fixture"}','item.create','data','item','01f00000-0000-7000-8000-000000000003','127.0.0.1','{"type":"core.note"}');
INSERT INTO audit_log VALUES('01a20551-81ac-75a6-9117-874421d498a4','2026-11-22T22:12:37.419Z','01a20551-502b-763f-8813-6908e83cb77c','{"kind":"key","id":"01a20551-502b-763f-8813-6908e83cb77c","name":"upgrade-fixture"}','edge.create','data','edge','01f00000-0000-7000-8000-0000000000e1','127.0.0.1','{"edge_type":"about","from_id":"01f00000-0000-7000-8000-000000000003","to_id":"01f00000-0000-7000-8000-000000000001"}');
CREATE TABLE types (
    id TEXT PRIMARY KEY,
    parent TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('platform', 'user')),
    created_by TEXT CHECK (created_by IS NULL OR json_valid(created_by)),
    owner_icon TEXT,
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
INSERT INTO types VALUES('core.bookmark',NULL,'platform',NULL,NULL,'{"id":"core.bookmark","label":"Bookmark","description":"Something you saved from elsewhere, such as a link, a highlighted excerpt or a clipped paragraph.","version":0,"fields":{"url":{"type":"url","label":"URL","description":"The address of the page you saved."},"body":{"type":"string","description":"The text you captured, such as a highlight, excerpt or clipping."},"title":{"type":"string","description":"The title of the saved content."},"description":{"type":"string","description":"A short summary of the saved content."},"source_url":{"type":"url","label":"Source URL","description":"Where the content was sourced from"},"source_title":{"type":"string","description":"Title of the source"},"author":{"type":"string","description":"Who created the original content"},"published_at":{"type":"datetime","label":"Published","description":"When the original content was published"},"image_url":{"type":"url","label":"Image URL","description":"Preview image"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the saved content."}},"display_hints":{"title_field":"title","body_field":"body","icon":"lucide:bookmark"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Bookmarks"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.collection',NULL,'platform',NULL,NULL,'{"id":"core.collection","label":"Collection","description":"A named group of items of any type, such as a reading list or the plans for a trip.","version":0,"fields":{"title":{"type":"string","description":"The name of the collection.","required":true},"description":{"type":"string","description":"What the collection is for."}},"display_hints":{"title_field":"title","body_field":"description","icon":"lucide:layers"},"merge_policy":{"default":"last_writer_wins"},"roles":["container"],"plural":"Collections"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.conversation',NULL,'platform',NULL,NULL,'{"id":"core.conversation","label":"Conversation","description":"A conversation, such as a chat with a person or an assistant. Its messages are the rows of its messages table.","version":0,"fields":{"title":{"type":"string","description":"The conversation''s name."}},"tables":{"messages":{"description":"The messages of the conversation, kept in the order they were sent.","order":"sent_at","columns":{"author":{"type":"string","description":"Who wrote the message, such as a name, a handle or `assistant`.","required":true},"text":{"type":"string","description":"What the message says. A message may have no text and only an attachment.","searchable":true},"sent_at":{"type":"datetime","description":"When the message was sent.","required":true},"attachment":{"type":"item","description":"A picture or other file the message carries.","type_constraints":["core.file"]}}}},"display_hints":{"title_field":"title","icon":"lucide:messages-square"},"merge_policy":{"default":"last_writer_wins"},"plural":"Conversations"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.entity',NULL,'platform',NULL,NULL,'{"id":"core.entity","label":"Entity","description":"Someone or something with a name, such as a person, company, band, team, charity, brand, school or place.","version":0,"fields":{"name":{"type":"string","description":"The name to show for the entity.","required":true},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short description of the entity."},"emails":{"type":"array","description":"Email addresses. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"value":{"type":"email","label":"Email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}}},"phones":{"type":"array","label":"Phone Numbers","description":"Phone numbers. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"value":{"type":"string","label":"Number","description":"The phone number, in E.164 form where known","required":true,"format":"phone"},"label":{"type":"string","description":"What the entry is for, such as work or home"}}},"addresses":{"type":"array","description":"Postal addresses. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}}},"image_url":{"type":"url","label":"Image URL","description":"Logo or brand image"},"legal_name":{"type":"string","description":"Official registered name"},"founded":{"type":"date","description":"Founding date (ISO 8601)"},"notes":{"type":"string","description":"Your own comments, kept apart from the entity''s details."}},"display_hints":{"title_field":"name","icon":"lucide:shapes"},"merge_policy":{"default":"last_writer_wins"},"plural":"Entities"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.entity.person','core.entity','platform',NULL,NULL,'{"id":"core.entity.person","parent":"core.entity","label":"Person","plural":"People","description":"A person, with their name, contact details and job.","version":0,"fields":{"name":{"type":"string","description":"The name to show for the entity.","required":true},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short description of the entity."},"emails":{"type":"array","description":"Email addresses. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"value":{"type":"email","label":"Email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}}},"phones":{"type":"array","label":"Phone Numbers","description":"Phone numbers. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"value":{"type":"string","label":"Number","description":"The phone number, in E.164 form where known","required":true,"format":"phone"},"label":{"type":"string","description":"What the entry is for, such as work or home"}}},"addresses":{"type":"array","description":"Postal addresses. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}}},"image_url":{"type":"url","label":"Image URL","description":"Logo or brand image"},"legal_name":{"type":"string","description":"Official registered name"},"founded":{"type":"date","description":"Founding date (ISO 8601)"},"notes":{"type":"string","description":"Your own comments, kept apart from the entity''s details."},"given_name":{"type":"string","description":"Given (first) name"},"family_name":{"type":"string","description":"Family (last) name"},"middle_name":{"type":"string","description":"Middle or additional name"},"prefix":{"type":"string","description":"Honorific prefix (Dr, Mr, Prof)"},"suffix":{"type":"string","description":"Honorific suffix (PhD, Jr, OBE)"},"nickname":{"type":"string","description":"Familiar name or alias"},"organization":{"type":"string","description":"Associated organization"},"job_title":{"type":"string","description":"Position or job title"},"department":{"type":"string","description":"Department within the organization"},"birthday":{"type":"date","description":"Date of birth (ISO 8601)"},"pronouns":{"type":"string","description":"Pronouns"}},"display_hints":{"icon":"lucide:user"},"merge_policy":{"default":"last_writer_wins"}}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.entity.place','core.entity','platform',NULL,NULL,'{"id":"core.entity.place","parent":"core.entity","label":"Place","description":"A place, such as a cafe, an office or a city, with its address and coordinates.","version":0,"fields":{"name":{"type":"string","description":"The name to show for the entity.","required":true},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short description of the entity."},"emails":{"type":"array","description":"Email addresses. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"value":{"type":"email","label":"Email","description":"The email address","required":true},"label":{"type":"string","description":"What the entry is for, such as work or home"}}},"phones":{"type":"array","label":"Phone Numbers","description":"Phone numbers. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"value":{"type":"string","label":"Number","description":"The phone number, in E.164 form where known","required":true,"format":"phone"},"label":{"type":"string","description":"What the entry is for, such as work or home"}}},"addresses":{"type":"array","description":"Postal addresses. The first entry is the main one, and an entry''s label is free text, such as work or home.","items_type":"object","items_fields":{"label":{"type":"string","description":"What the entry is for, such as work or home"},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"Country name or code"}}},"image_url":{"type":"url","label":"Image URL","description":"Logo or brand image"},"legal_name":{"type":"string","description":"Official registered name"},"founded":{"type":"date","description":"Founding date (ISO 8601)"},"notes":{"type":"string","description":"Your own comments, kept apart from the entity''s details."},"street_address":{"type":"string","description":"Street line"},"locality":{"type":"string","description":"City or town"},"region":{"type":"string","description":"State, province, or county"},"postal_code":{"type":"string","description":"Postcode or ZIP code"},"country":{"type":"string","description":"ISO 3166-1 alpha-2 country code","format":"iso3166"},"timezone":{"type":"string","label":"Time Zone","description":"IANA timezone"},"latitude":{"type":"number","description":"Latitude of the place."},"longitude":{"type":"number","description":"Longitude of the place."},"altitude":{"type":"number","description":"Altitude in meters above sea level"}},"display_hints":{"icon":"lucide:map-pin"},"merge_policy":{"default":"last_writer_wins"},"plural":"Places"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.event',NULL,'platform',NULL,NULL,'{"id":"core.event","label":"Event","description":"Something that happens at a time, such as a meeting, a flight or a birthday.","version":0,"fields":{"title":{"type":"string","description":"The name of the event.","required":true},"description":{"type":"string","description":"A short description of the event."},"starts_at":{"type":"datetime","label":"Starts","description":"When the event starts, as an ISO 8601 instant. `timezone` says which local time it means."},"ends_at":{"type":"datetime","label":"Ends","description":"When the event ends, as an ISO 8601 instant."},"duration":{"type":"number","description":"How long the event lasts, in seconds. For a repeating event with no `ends_at`, it is the length of each occurrence."},"place":{"type":"string","description":"Where the event happens, as a name or an address."},"latitude":{"type":"number","description":"Venue latitude"},"longitude":{"type":"number","description":"Venue longitude"},"url":{"type":"url","label":"URL","description":"A web page about the event."},"precision":{"type":"enum","description":"How much of the start is known, such as only the year, for an event dated from memory.","enum_values":["year","month","day","time"]},"status":{"type":"enum","description":"Whether the event will happen.","enum_values":["tentative","confirmed","canceled"]},"notes":{"type":"string","description":"Your own comments, kept apart from the event''s details."},"recurrence":{"type":"array","description":"RFC 5545 recurrence lines (RRULE, RDATE, EXDATE) that make the event repeat. Marfa works out the occurrences when they are read instead of storing them.","items_type":"string"},"all_day":{"type":"boolean","description":"True when the event lasts whole days rather than a span of time. Read the date from `starts_at` in the event''s `timezone`."},"timezone":{"type":"string","label":"Time Zone","description":"The IANA time zone the event keeps its local hour in, such as Europe/Berlin. A repeating event keeps that hour across daylight saving changes."},"end_timezone":{"type":"string","label":"End Time Zone","description":"The IANA time zone the event ends in, when it differs from `timezone`, such as a flight that lands in another zone."},"attendees":{"type":"array","description":"The people invited, one entry each. An entry has a name, an email or both, and the person''s reply.","items_type":"object","items_fields":{"name":{"type":"string","description":"The attendee''s name as the source gives it"},"email":{"type":"email","description":"The attendee''s email address"},"response":{"type":"enum","description":"The attendee''s reply to the invitation","enum_values":["needs_action","accepted","declined","tentative"]}}},"original_starts_at":{"type":"datetime","label":"Original Start","description":"For an event that replaces one occurrence of a repeating event, the start of the occurrence it replaces."}},"display_hints":{"title_field":"title","body_field":"description","icon":"lucide:calendar"},"merge_policy":{"fields":{"notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Events"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.file',NULL,'platform',NULL,NULL,'{"id":"core.file","label":"File","description":"A file you keep, such as a PDF or a spreadsheet.","version":0,"fields":{"blob_ref":{"type":"string","label":"Blob Reference","description":"A reference to the file''s contents, written as sha256: followed by the hex digest.","required":true},"mime_type":{"type":"string","label":"MIME Type","description":"The file''s MIME type, such as application/pdf.","required":true},"title":{"type":"string","description":"The file''s name or title."},"description":{"type":"string","description":"What the file contains."},"url":{"type":"url","label":"URL","description":"Web address"},"source_url":{"type":"url","label":"Source URL","description":"Where the file came from."},"author":{"type":"string","description":"Who made the file."},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the file''s details."},"extracted_text":{"type":"string","description":"Text the server reads out of the file, such as document text or the words in an image."},"executable":{"type":"boolean","description":"Whether the file may be run as a program. Absent means it may not."},"size_bytes":{"type":"integer","label":"Size","description":"The size of the file in bytes, set by the server once the instance holds the file''s bytes."}},"display_hints":{"title_field":"title","icon":"lucide:file"},"merge_policy":{"default":"last_writer_wins"},"plural":"Files"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.file.audio','core.file','platform',NULL,NULL,'{"id":"core.file.audio","parent":"core.file","label":"Audio","plural":"Audio","description":"A recording, a music file or a voice memo.","version":0,"fields":{"blob_ref":{"type":"string","label":"Blob Reference","description":"A reference to the file''s contents, written as sha256: followed by the hex digest.","required":true},"mime_type":{"type":"string","label":"MIME Type","description":"The file''s MIME type, such as application/pdf.","required":true},"title":{"type":"string","description":"The file''s name or title."},"description":{"type":"string","description":"What the file contains."},"url":{"type":"url","label":"URL","description":"Web address"},"source_url":{"type":"url","label":"Source URL","description":"Where the file came from."},"author":{"type":"string","description":"Who made the file."},"language":{"type":"string","description":"BCP 47 language code of the speech.","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the file''s details."},"extracted_text":{"type":"string","description":"Text the server reads out of the file, such as document text or the words in an image."},"executable":{"type":"boolean","description":"Whether the file may be run as a program. Absent means it may not."},"size_bytes":{"type":"integer","label":"Size","description":"The size of the file in bytes, set by the server once the instance holds the file''s bytes."},"duration":{"type":"number","description":"Length in seconds. The server fills it in from the file if you leave it out."}},"display_hints":{"icon":"lucide:file-music"},"merge_policy":{"default":"last_writer_wins"}}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.file.image','core.file','platform',NULL,NULL,'{"id":"core.file.image","parent":"core.file","label":"Image","description":"A photo, a screenshot or a diagram.","version":0,"fields":{"blob_ref":{"type":"string","label":"Blob Reference","description":"A reference to the file''s contents, written as sha256: followed by the hex digest.","required":true},"mime_type":{"type":"string","label":"MIME Type","description":"The file''s MIME type, such as application/pdf.","required":true},"title":{"type":"string","description":"The file''s name or title."},"description":{"type":"string","description":"What the file contains."},"url":{"type":"url","label":"URL","description":"Web address"},"source_url":{"type":"url","label":"Source URL","description":"Where the file came from."},"author":{"type":"string","description":"Who made the file."},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the file''s details."},"extracted_text":{"type":"string","description":"Text the server reads out of the file, such as document text or the words in an image."},"executable":{"type":"boolean","description":"Whether the file may be run as a program. Absent means it may not."},"size_bytes":{"type":"integer","label":"Size","description":"The size of the file in bytes, set by the server once the instance holds the file''s bytes."},"width":{"type":"integer","description":"Width in pixels. The server fills it in from the file if you leave it out."},"height":{"type":"integer","description":"Height in pixels. The server fills it in from the file if you leave it out."},"latitude":{"type":"number","description":"Latitude of what the image shows."},"longitude":{"type":"number","description":"Longitude of what the image shows."},"altitude":{"type":"number","description":"The altitude of what the image shows, in meters."},"thumbnail":{"type":"thumbnail","description":"A small preview of the image, supplied by whoever saved it."}},"display_hints":{"icon":"lucide:file-image"},"merge_policy":{"default":"last_writer_wins"},"plural":"Images"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.file.video','core.file','platform',NULL,NULL,'{"id":"core.file.video","parent":"core.file","label":"Video","description":"A video file, such as a clip or a screen recording.","version":0,"fields":{"blob_ref":{"type":"string","label":"Blob Reference","description":"A reference to the file''s contents, written as sha256: followed by the hex digest.","required":true},"mime_type":{"type":"string","label":"MIME Type","description":"The file''s MIME type, such as application/pdf.","required":true},"title":{"type":"string","description":"The file''s name or title."},"description":{"type":"string","description":"What the file contains."},"url":{"type":"url","label":"URL","description":"Web address"},"source_url":{"type":"url","label":"Source URL","description":"Where the file came from."},"author":{"type":"string","description":"Who made the file."},"language":{"type":"string","description":"BCP 47 language code of the speech.","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the file''s details."},"extracted_text":{"type":"string","description":"Text the server reads out of the file, such as document text or the words in an image."},"executable":{"type":"boolean","description":"Whether the file may be run as a program. Absent means it may not."},"size_bytes":{"type":"integer","label":"Size","description":"The size of the file in bytes, set by the server once the instance holds the file''s bytes."},"width":{"type":"integer","description":"Width in pixels. The server fills it in from the file if you leave it out."},"height":{"type":"integer","description":"Height in pixels. The server fills it in from the file if you leave it out."},"duration":{"type":"number","description":"Length in seconds. The server fills it in from the file if you leave it out."},"latitude":{"type":"number","description":"Latitude of what the video shows."},"longitude":{"type":"number","description":"Longitude of what the video shows."},"altitude":{"type":"number","description":"The altitude of what the video shows, in meters."}},"display_hints":{"icon":"lucide:file-video-camera"},"merge_policy":{"default":"last_writer_wins"},"plural":"Videos"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.file.webpage','core.file','platform',NULL,NULL,'{"id":"core.file.webpage","parent":"core.file","label":"Web Page","description":"A web page saved as an HTML file, such as a report an agent wrote.","version":0,"fields":{"blob_ref":{"type":"string","label":"Blob Reference","description":"A reference to the file''s contents, written as sha256: followed by the hex digest.","required":true},"mime_type":{"type":"string","label":"MIME Type","description":"The file''s MIME type, such as application/pdf.","required":true},"title":{"type":"string","description":"The file''s name or title."},"description":{"type":"string","description":"What the file contains."},"url":{"type":"url","label":"URL","description":"Web address"},"source_url":{"type":"url","label":"Source URL","description":"Where the file came from."},"author":{"type":"string","description":"Who made the file."},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the file''s details."},"extracted_text":{"type":"string","description":"Text the server reads out of the file, such as document text or the words in an image."},"executable":{"type":"boolean","description":"Whether the file may be run as a program. Absent means it may not."},"size_bytes":{"type":"integer","label":"Size","description":"The size of the file in bytes, set by the server once the instance holds the file''s bytes."}},"display_hints":{"title_field":"title","icon":"lucide:globe"},"merge_policy":{"default":"last_writer_wins"},"plural":"Web Pages"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.highlight',NULL,'platform',NULL,NULL,'{"id":"core.highlight","label":"Highlight","description":"A passage you highlighted, with any note you added.","version":0,"fields":{"text":{"type":"string","description":"The highlighted passage, as Markdown.","required":true},"note":{"type":"string","description":"Your note on the passage."},"color":{"type":"enum","description":"The color of the highlight.","enum_values":["yellow","blue","green","pink","orange","purple"]},"locator_type":{"type":"enum","description":"How to read `start_location` and `end_location`.","enum_values":["offset","page","time","cfi","order","none"]},"start_location":{"type":"string","description":"Where the highlight starts, read as `locator_type` says."},"end_location":{"type":"string","description":"Where the highlight ends, read as `locator_type` says."}},"display_hints":{"body_field":"text","name_from_body":false,"icon":"lucide:highlighter"},"merge_policy":{"fields":{"note":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Highlights"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media',NULL,'platform',NULL,NULL,'{"id":"core.media","label":"Media","plural":"Media","description":"Something someone made that you read, watch, listen to or play, such as a film, podcast, book, article, song, show or game.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."}},"display_hints":{"title_field":"title","body_field":"body","icon":"lucide:library-big"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"}}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.album','core.media','platform',NULL,NULL,'{"id":"core.media.album","parent":"core.media","label":"Album","description":"A music album, EP or single.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"release_type":{"type":"string","description":"The kind of release, such as album, ep or single."},"num_tracks":{"type":"integer","label":"Tracks","description":"Total track count"}},"display_hints":{"icon":"lucide:disc-3"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"roles":["container"],"plural":"Albums"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.article','core.media','platform',NULL,NULL,'{"id":"core.media.article","parent":"core.media","label":"Article","description":"An article, such as a blog post or a news story.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The article text"},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"doi":{"type":"string","label":"DOI","description":"Digital Object Identifier (ISO 26324)"},"section":{"type":"string","description":"Section of the publication"},"word_count":{"type":"integer","label":"Words","description":"Word count"}},"display_hints":{"icon":"lucide:newspaper"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Articles"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.book','core.media','platform',NULL,NULL,'{"id":"core.media.book","parent":"core.media","label":"Book","description":"A book, with details such as its ISBN and page count.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"isbn":{"type":"string","label":"ISBN","description":"International Standard Book Number (ISO 2108)"},"page_count":{"type":"integer","label":"Pages","description":"Number of pages"},"edition":{"type":"string","description":"Edition designation"}},"display_hints":{"icon":"lucide:book-open"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Books"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.episode','core.media','platform',NULL,NULL,'{"id":"core.media.episode","parent":"core.media","label":"Episode","description":"One episode of a TV show, a podcast or another series.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"medium":{"type":"enum","description":"What kind of episode it is.","enum_values":["tv","podcast","radio","video","mixed"]},"season_number":{"type":"integer","description":"Which season, where the series has them"},"episode_number":{"type":"integer","description":"Position within the season, or within the series when unseasoned"},"duration":{"type":"number","description":"Runtime in seconds"},"media_url":{"type":"url","label":"Media URL","description":"The address of the media file itself, such as an audio file or a video stream. Unlike `url`, it is not the web page about the work."},"mime_type":{"type":"string","label":"MIME Type","description":"The MIME type of the file at `media_url`, such as audio/mpeg or video/mp4."}},"display_hints":{"icon":"lucide:circle-play"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Episodes"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.film','core.media','platform',NULL,NULL,'{"id":"core.media.film","parent":"core.media","label":"Film","description":"A film.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"duration":{"type":"number","description":"Runtime in seconds"},"director":{"type":"string","description":"Primary director"},"content_rating":{"type":"string","description":"Age or content classification"},"media_url":{"type":"url","label":"Media URL","description":"The address of the media file itself, such as an audio file or a video stream. Unlike `url`, it is not the web page about the work."},"mime_type":{"type":"string","label":"MIME Type","description":"The MIME type of the file at `media_url`, such as audio/mpeg or video/mp4."}},"display_hints":{"icon":"lucide:film"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Films"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.game','core.media','platform',NULL,NULL,'{"id":"core.media.game","parent":"core.media","label":"Game","description":"A video game, board game or card game.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"platforms":{"type":"array","description":"What the game is played on, such as Nintendo Switch, PC or Tabletop","items_type":"string"},"min_players":{"type":"integer","label":"Minimum Players","description":"Fewest players the game supports","minimum":1},"max_players":{"type":"integer","label":"Maximum Players","description":"Most players the game supports","minimum":1}},"display_hints":{"icon":"lucide:gamepad-2"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Games"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.series','core.media','platform',NULL,NULL,'{"id":"core.media.series","parent":"core.media","label":"Series","plural":"Series","description":"A TV show, podcast, radio serial or video series that is made of episodes.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"medium":{"type":"enum","description":"What kind of series it is.","enum_values":["tv","podcast","radio","video","mixed"]},"status":{"type":"enum","description":"Whether the series is still producing new episodes.","enum_values":["ongoing","ended","canceled"]}},"display_hints":{"icon":"lucide:tv"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"roles":["container"]}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.media.song','core.media','platform',NULL,NULL,'{"id":"core.media.song","parent":"core.media","label":"Song","description":"A song.","version":0,"fields":{"title":{"type":"string","description":"The name of the work.","required":true},"body":{"type":"string","description":"The text of the work, or a longer write-up of it."},"author":{"type":"string","description":"Who made the work."},"url":{"type":"url","label":"URL","description":"Web address"},"description":{"type":"string","description":"A short summary or blurb."},"publisher":{"type":"string","description":"Who published the work."},"published_at":{"type":"datetime","label":"Published","description":"When originally published or released"},"image_url":{"type":"url","label":"Image URL","description":"Cover art, poster, or thumbnail"},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"progress":{"type":"status","description":"Where you are with the work, such as whether you have started or finished it.","status_values":[{"value":"planned","group":"not_started"},{"value":"started","group":"in_progress"},{"value":"finished","group":"completed"},{"value":"abandoned","group":"canceled"}]},"rating":{"type":"integer","description":"Your overall view of the work, from 1 (lowest) to 5 (highest).","minimum":1,"maximum":5},"notes":{"type":"string","description":"Your own comments, kept apart from the work''s details."},"thumbnail":{"type":"thumbnail","description":"A small preview of the work, supplied by whoever saved it."},"duration":{"type":"number","description":"Track length in seconds"},"isrc":{"type":"string","label":"ISRC","description":"International Standard Recording Code (ISO 3901)"},"album":{"type":"string","description":"Containing album name"},"track_number":{"type":"integer","description":"Position within the album"},"media_url":{"type":"url","label":"Media URL","description":"The address of the media file itself, such as an audio file or a video stream. Unlike `url`, it is not the web page about the work."},"mime_type":{"type":"string","label":"MIME Type","description":"The MIME type of the file at `media_url`, such as audio/mpeg or video/mp4."}},"display_hints":{"icon":"lucide:audio-lines"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Songs"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.message',NULL,'platform',NULL,NULL,'{"id":"core.message","label":"Message","description":"A message you sent or received, such as a text or a chat message.","version":0,"fields":{"body":{"type":"string","description":"The text of the message."},"from":{"type":"string","description":"Who sent the message, such as a phone number, an email address or a handle.","required":true},"to":{"type":"array","description":"Who received the message, written the same way as `from`.","items_type":"string"}},"display_hints":{"body_field":"body","icon":"lucide:message-square"},"merge_policy":{"fields":{"body":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Messages"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.note',NULL,'platform',NULL,NULL,'{"id":"core.note","label":"Note","description":"Text you wrote, such as a thought, a meeting note or a list.","version":0,"fields":{"body":{"type":"string","description":"The text of the note."},"title":{"type":"string","description":"The note''s heading."},"language":{"type":"string","description":"BCP 47 language code","format":"bcp47"},"notes":{"type":"string","description":"Your own comments, kept apart from the note''s text."}},"display_hints":{"title_field":"title","body_field":"body","icon":"lucide:sticky-note"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Notes"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.table',NULL,'platform',NULL,NULL,'{"id":"core.table","label":"Table","description":"A table you keep by hand, such as a budget, a reading log or a list of contacts, with the columns you choose.","version":0,"fields":{"title":{"type":"string","description":"The name of the table.","required":true},"description":{"type":"string","description":"What the table is for."},"columns":{"type":"object","description":"The table''s columns, by name. A column has a `type` and may have a `label`, `description`, `required`, `enum_values`, `format`, `max_length`, `minimum`, `maximum`, `type_constraints`, `adds_up` and `searchable`, as a column a type declares does.","required":true}},"display_hints":{"title_field":"title","body_field":"description","icon":"lucide:table"},"merge_policy":{"default":"last_writer_wins"},"plural":"Tables"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('core.task',NULL,'platform',NULL,NULL,'{"id":"core.task","label":"Task","description":"Something you need to do, such as booking flights or sending an invoice.","version":0,"fields":{"title":{"type":"string","description":"What needs doing.","required":true},"description":{"type":"string","description":"A line or two of context."},"body":{"type":"string","description":"The full details, as long as you need."},"due_at":{"type":"datetime","label":"Due","description":"When the task is due."},"starts_at":{"type":"datetime","label":"Starts","description":"When you plan to start the task."},"completed_at":{"type":"datetime","label":"Completed","description":"When you finished the task."},"status":{"type":"status","description":"Where the task stands","status_values":[{"value":"not_started","group":"not_started"},{"value":"in_progress","group":"in_progress"},{"value":"completed","group":"completed"},{"value":"canceled","group":"canceled"}]},"priority":{"type":"enum","description":"How important the task is.","enum_values":["low","medium","high","urgent"]},"place":{"type":"string","description":"Where the task is done."},"precision":{"type":"enum","description":"How much of the task''s date is known, such as only the year or the month.","enum_values":["year","month","day","time"]},"url":{"type":"url","label":"URL","description":"A web page related to the task."},"assignees":{"type":"array","description":"The people the task is assigned to, one entry each. An entry has a name, an email or both.","items_type":"object","items_fields":{"name":{"type":"string","description":"The assignee''s name as the source gives it, such as a login"},"email":{"type":"email","description":"The assignee''s email address"}}},"notes":{"type":"string","description":"Your own comments, kept apart from the task''s details."},"recurrence":{"type":"array","description":"RFC 5545 recurrence lines (RRULE, RDATE, EXDATE) that make the task repeat, counted from `due_at` or, without one, from `starts_at`.","items_type":"string"}},"display_hints":{"title_field":"title","body_field":"body","icon":"lucide:square-check-big"},"merge_policy":{"fields":{"body":"keep_both_copies","notes":"keep_both_copies"},"default":"last_writer_wins"},"plural":"Tasks"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('system.connection',NULL,'platform',NULL,NULL,'{"id":"system.connection","label":"Connection","description":"An app you signed in to Marfa, with the access you gave it and when it last used it.","version":0,"fields":{"kind":{"type":"enum","description":"The kind of connection.","required":true,"enum_values":["app"]},"client_id":{"type":"string","description":"The app''s OAuth client ID."},"name":{"type":"string","description":"Your own name for this app''s sign-in. Without one, the app''s registered name is used."},"scopes":{"type":"array","description":"The scopes you granted the app.","items_type":"string"},"status":{"type":"enum","description":"Whether the sign-in is active or revoked.","required":true,"enum_values":["active","revoked"]},"granted_at":{"type":"datetime","description":"When you approved the app.","required":true},"last_used_at":{"type":"datetime","description":"When the app last used the sign-in successfully."},"revoked_at":{"type":"datetime","description":"When you revoked the sign-in, if you did."}},"plural":"Connections"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('system.folder',NULL,'platform',NULL,NULL,'{"id":"system.folder","label":"Folder","description":"A folder kept in sync with Marfa, with which items it holds and how new files are filed, shared by every machine that uses it.","version":0,"fields":{"title":{"type":"string","description":"The folder''s name.","required":true},"query":{"type":"object","description":"Which items the folder holds, chosen by type, tier, state, a filter or a position under an item."},"defaults":{"type":"object","description":"What a new file gets where its frontmatter leaves a blank: type, tier, properties, tags and edges. It is never applied to an edited file."},"include":{"type":"array","description":"Paths the folder takes, as gitignore patterns relative to its root. Empty takes every path.","items_type":"string"},"ignore":{"type":"array","description":"Paths the folder leaves alone, as gitignore patterns relative to its root. It wins over `include`.","items_type":"string"},"first_placement":{"type":"object","description":"Where a new item of a type made elsewhere first appears: a map from type to a directory under the folder''s root."},"removal_threshold":{"type":"object","description":"Removals pause above both `files` and `fraction` of bound files, or above `ceiling` alone. Defaults are 10, 0.25 and 100. Each pass is judged separately."},"full_pass_interval_seconds":{"type":"integer","description":"Seconds between the watch''s passes that read every file in the folder, from 60 to 86400. Defaults to 600."},"addition_threshold":{"type":"object","description":"When new files pause for confirmation: a scan that would add more than `files` files and more than `fraction` of the folder''s files. Defaults to 50 and 0.25."},"outside_query":{"type":"enum","description":"What the folder does with a new file its query would not hold: send it and keep it flagged unmatched, or hold it on disk, not sent. Defaults to send.","enum_values":["send","hold"]},"revoked_at":{"type":"datetime","description":"When the folder was revoked."}},"plural":"Folders"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('system.view',NULL,'platform',NULL,NULL,'{"id":"system.view","label":"View","description":"A saved list of items, with the order and grouping you chose, shared by every app.","version":0,"fields":{"title":{"type":"string","description":"The view''s name.","required":true},"query":{"type":"object","description":"Which items the view lists, chosen by type, tier, state, a filter or a position under an item."},"sort":{"type":"array","description":"The keys the view sorts by, first key first. Each has a `by` field and a `direction`, `asc` or `desc`.","items_type":"object"},"group":{"type":"object","description":"How the view groups its items: by a field or an edge, optionally in day, week, month or year buckets, with the group order and any hidden groups."}},"plural":"Views"}','2026-11-22T22:12:14.074Z','2026-11-22T22:12:14.074Z');
INSERT INTO types VALUES('user.upgrade_witness','core.note','user','{"kind":"key","id":"01a20551-502b-763f-8813-6908e83cb77c","name":"upgrade-fixture"}',NULL,'{"id":"user.upgrade_witness","version":0,"fields":{"priority":{"type":"string"},"stars":{"type":"number"}},"parent":"core.note","label":"Upgrade Witness"}','2026-11-22T22:12:37.349Z','2026-11-22T22:12:37.349Z');
CREATE TABLE edge_types (
    id TEXT PRIMARY KEY,
    reverse_name TEXT,
    created_by TEXT CHECK (created_by IS NULL OR json_valid(created_by)),
    definition TEXT NOT NULL CHECK (json_valid(definition)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'archived', 'trashed', 'revoked')),
    tier TEXT NOT NULL CHECK (tier IN ('library', 'feed')),
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_id TEXT,
    title_key TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    schema_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trashed_at TEXT,
    capture_latitude REAL,
    capture_longitude REAL,
    writer_kind TEXT,
    writer_id TEXT,
    writer_name TEXT,
    link TEXT CHECK (link IS NULL OR length(link) > 0),
    trashed_by_kind TEXT,
    trashed_by_id TEXT,
    trashed_by_name TEXT,
    trashed_with TEXT,
    trashed_with_type TEXT,
    went_with_hosts INTEGER NOT NULL DEFAULT 0 CHECK (went_with_hosts IN (0, 1)),
    -- Set once an item leaves the bin, however it left, and never cleared: the
    -- `feed-expiry` job leaves such an item alone for good.
    restored_at TEXT,
    -- The later of `updated_at` and the last change to the item's rows.
    last_activity_at TEXT NOT NULL,
    -- Last, so a read of any other column stops short of a wide value.
    properties BLOB NOT NULL
) STRICT;
INSERT INTO items VALUES(1,'01f00000-0000-7000-8000-000000000001','user.upgrade_witness','active','library','upgrade-fixture',NULL,NULL,1,0,'2026-11-22T22:12:37.378Z','2026-11-22T22:12:37.378Z','2026-11-22T22:12:37.378Z',NULL,NULL,NULL,'key','01a20551-502b-763f-8813-6908e83cb77c','upgrade-fixture',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'2026-11-22T22:12:37.378Z',x'cc2a47626f6479c70d6669727374207769746e657373877072696f7269747947686967685773746172731333');
INSERT INTO items VALUES(2,'01f00000-0000-7000-8000-000000000002','user.upgrade_witness','active','library','upgrade-fixture',NULL,NULL,1,0,'2026-11-22T22:12:37.394Z','2026-11-22T22:12:37.394Z','2026-11-22T22:12:37.394Z',NULL,NULL,NULL,'key','01a20551-502b-763f-8813-6908e83cb77c','upgrade-fixture',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'2026-11-22T22:12:37.394Z',x'cc2a47626f6479c70e7365636f6e64207769746e657373877072696f72697479376c6f775773746172731331');
INSERT INTO items VALUES(3,'01f00000-0000-7000-8000-000000000003','core.note','active','library','upgrade-fixture',NULL,NULL,1,0,'2026-11-22T22:12:37.407Z','2026-11-22T22:12:37.407Z','2026-11-22T22:12:37.407Z',NULL,NULL,NULL,'key','01a20551-502b-763f-8813-6908e83cb77c','upgrade-fixture',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'2026-11-22T22:12:37.407Z',x'cc1147626f6479b76120636f7265206e6f7465');
CREATE TABLE table_summaries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    item_seq INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    last_batch TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    -- The `<kind>:<column>` every row's `ord` is the key of; NULL while none or while it is rebuilt.
    ordered_by TEXT,
    -- The searchable columns `rows_fts` holds every row by, joined by commas; NULL while rebuilt.
    searched_by TEXT,
    -- The table's `rows_fts` entries and their length in tokens, kept by `row_search`'s triggers.
    indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed >= 0),
    indexed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (indexed_tokens >= 0),
    UNIQUE (item_seq, table_name)
) STRICT;
CREATE TABLE table_rows (
    table_seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ord ANY,
    -- Undo restores the prior mark so earlier batches remain undoable.
    batch INTEGER NOT NULL,
    refs BLOB,
    body BLOB NOT NULL,
    PRIMARY KEY (table_seq, id)
) STRICT, WITHOUT ROWID;
CREATE TABLE table_rows_reordering (
    table_seq INTEGER PRIMARY KEY,
    target TEXT,
    after_id TEXT
) STRICT;
PRAGMA writable_schema=ON;
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','rows_fts','rows_fts',0,'CREATE VIRTUAL TABLE rows_fts USING fts5(
    c0, c1, c2, c3, c4, c5, c6, c7,
    tokenize = ''porter unicode61''
)');
CREATE TABLE IF NOT EXISTS 'rows_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO rows_fts_data VALUES(1,x'');
INSERT INTO rows_fts_data VALUES(10,x'00000000000000');
CREATE TABLE IF NOT EXISTS 'rows_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'rows_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5, c6, c7);
CREATE TABLE IF NOT EXISTS 'rows_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'rows_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO rows_fts_config VALUES('version',4);
CREATE TABLE row_search (
    seq INTEGER PRIMARY KEY,
    table_seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    UNIQUE (table_seq, id)
) STRICT;
CREATE TABLE table_rows_reindexing (
    table_seq INTEGER PRIMARY KEY,
    target TEXT NOT NULL,
    after_id TEXT
) STRICT;
CREATE TABLE row_batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    table_seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    rows INTEGER NOT NULL CHECK (rows >= 0),
    undoes TEXT
) STRICT;
CREATE TABLE row_changes (
    batch INTEGER NOT NULL,
    id TEXT NOT NULL,
    before_batch INTEGER,
    after_batch INTEGER,
    refs BLOB,
    body BLOB,
    after_refs BLOB,
    PRIMARY KEY (batch, id)
) STRICT, WITHOUT ROWID;
CREATE TABLE table_rows_purging (
    table_seq INTEGER PRIMARY KEY
) STRICT;
CREATE TABLE edges (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    from_id TEXT NOT NULL REFERENCES items (id),
    to_id TEXT NOT NULL REFERENCES items (id),
    edge_type TEXT NOT NULL,
    properties BLOB NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (from_id, to_id, edge_type)
) STRICT;
INSERT INTO edges VALUES(1,'01f00000-0000-7000-8000-0000000000e1','01f00000-0000-7000-8000-000000000003','01f00000-0000-7000-8000-000000000001','about',x'0c',1,'2026-11-22T22:12:37.419Z','2026-11-22T22:12:37.419Z');
CREATE TABLE item_tags (
    item_seq INTEGER NOT NULL REFERENCES items (seq),
    tag TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (item_seq, tag)
) STRICT, WITHOUT ROWID;
INSERT INTO item_tags VALUES(1,'one',1);
INSERT INTO item_tags VALUES(1,'witness',0);
CREATE TABLE item_extensions (
    item_seq INTEGER NOT NULL REFERENCES items (seq),
    namespace TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (item_seq, namespace)
) STRICT;
CREATE TABLE item_versions (
    item_seq INTEGER NOT NULL REFERENCES items (seq),
    version INTEGER NOT NULL,
    id TEXT NOT NULL,
    properties BLOB NOT NULL,
    type TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('library', 'feed')),
    occurred_at TEXT NOT NULL,
    source_id TEXT,
    writer_kind TEXT,
    writer_id TEXT,
    writer_name TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (item_seq, version)
) STRICT;
CREATE TABLE link_tombstones (
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    purged_at TEXT NOT NULL,
    settled_at TEXT NOT NULL,
    PRIMARY KEY (type, value)
) STRICT, WITHOUT ROWID;
CREATE TABLE natural_key_tombstones (
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    purged_at TEXT NOT NULL,
    settled_at TEXT NOT NULL,
    PRIMARY KEY (type, source, source_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE idempotency_records (
    credential TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    contract INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in_flight', 'complete')),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
    response_body BLOB,
    requirements TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (credential, idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT NOT NULL,
    fanout INTEGER NOT NULL CHECK (fanout IN (0, 1))
) STRICT;
INSERT INTO event_log VALUES(1,'item.created','01f00000-0000-7000-8000-000000000001','user.upgrade_witness','upgrade-fixture','2026-11-22T22:12:37.378Z','{"item":{"id":"01f00000-0000-7000-8000-000000000001","type":"user.upgrade_witness","state":"active","tier":"library","created_at":"2026-11-22T22:12:37.378Z","updated_at":"2026-11-22T22:12:37.378Z","last_activity_at":"2026-11-22T22:12:37.378Z","occurred_at":"2026-11-22T22:12:37.378Z","source":"upgrade-fixture","version":1,"schema_version":0,"trashed_at":null,"properties":{"body":"first witness","priority":"high","stars":3}},"metadata":{"item_id":"01f00000-0000-7000-8000-000000000001","tags":["witness","one"],"extensions":{}}}',1);
INSERT INTO event_log VALUES(2,'item.created','01f00000-0000-7000-8000-000000000002','user.upgrade_witness','upgrade-fixture','2026-11-22T22:12:37.394Z','{"item":{"id":"01f00000-0000-7000-8000-000000000002","type":"user.upgrade_witness","state":"active","tier":"library","created_at":"2026-11-22T22:12:37.394Z","updated_at":"2026-11-22T22:12:37.394Z","last_activity_at":"2026-11-22T22:12:37.394Z","occurred_at":"2026-11-22T22:12:37.394Z","source":"upgrade-fixture","version":1,"schema_version":0,"trashed_at":null,"properties":{"body":"second witness","priority":"low","stars":1}},"metadata":{"item_id":"01f00000-0000-7000-8000-000000000002","tags":[],"extensions":{}}}',1);
INSERT INTO event_log VALUES(3,'item.created','01f00000-0000-7000-8000-000000000003','core.note','upgrade-fixture','2026-11-22T22:12:37.407Z','{"item":{"id":"01f00000-0000-7000-8000-000000000003","type":"core.note","state":"active","tier":"library","created_at":"2026-11-22T22:12:37.407Z","updated_at":"2026-11-22T22:12:37.407Z","last_activity_at":"2026-11-22T22:12:37.407Z","occurred_at":"2026-11-22T22:12:37.407Z","source":"upgrade-fixture","version":1,"schema_version":0,"trashed_at":null,"properties":{"body":"a core note"}},"metadata":{"item_id":"01f00000-0000-7000-8000-000000000003","tags":[],"extensions":{}}}',1);
INSERT INTO event_log VALUES(4,'edge.created','01f00000-0000-7000-8000-000000000003','core.note','upgrade-fixture','2026-11-22T22:12:37.419Z','{"edge":{"id":"01f00000-0000-7000-8000-0000000000e1","from_id":"01f00000-0000-7000-8000-000000000003","to_id":"01f00000-0000-7000-8000-000000000001","edge_type":"about","version":1,"created_at":"2026-11-22T22:12:37.419Z","updated_at":"2026-11-22T22:12:37.419Z","properties":{}},"from_type":"core.note"}',1);
CREATE TABLE attention_announced (
    kind TEXT NOT NULL,
    reference TEXT NOT NULL,
    announced_at TEXT NOT NULL,
    PRIMARY KEY (kind, reference)
) STRICT;
CREATE TABLE housekeeping_jobs (
    name TEXT PRIMARY KEY,
    next_run_at TEXT NOT NULL,
    wake_requested INTEGER NOT NULL DEFAULT 0 CHECK (wake_requested IN (0, 1)),
    wakes_on_files INTEGER NOT NULL DEFAULT 0 CHECK (wakes_on_files IN (0, 1)),
    running_since TEXT,
    last_started_at TEXT,
    last_finished_at TEXT,
    last_outcome TEXT CHECK (last_outcome IN ('succeeded', 'failed', 'held')),
    last_error TEXT,
    last_result TEXT
) STRICT, WITHOUT ROWID;
INSERT INTO housekeeping_jobs VALUES('attention-check','2026-11-22T22:13:14.104Z',0,0,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO housekeeping_jobs VALUES('audit-cleanup','2026-11-23T22:12:19.155Z',0,0,NULL,'2026-11-22T22:12:19.109Z','2026-11-22T22:12:19.155Z','succeeded',NULL,'{"deleted":0,"deliveries":0}');
INSERT INTO housekeeping_jobs VALUES('blob-integrity','2026-11-22T22:13:14.104Z',0,0,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO housekeeping_jobs VALUES('blob-orphans','2026-11-23T22:12:44.141Z',0,0,NULL,'2026-11-22T22:12:44.107Z','2026-11-22T22:12:44.141Z','succeeded',NULL,'{"reported":0,"purged":0}');
INSERT INTO housekeeping_jobs VALUES('blob-replicate','2026-11-22T22:13:19.119Z',0,0,NULL,'2026-11-22T22:12:19.109Z','2026-11-22T22:12:19.119Z','succeeded',NULL,'{"copied":0,"bytes":0,"remaining":0}');
INSERT INTO housekeeping_jobs VALUES('bulk-action-gc','2026-11-22T23:12:44.132Z',0,0,NULL,'2026-11-22T22:12:44.107Z','2026-11-22T22:12:44.132Z','succeeded',NULL,'{"removed":0}');
INSERT INTO housekeeping_jobs VALUES('credential-cleanup','2026-11-22T23:12:34.161Z',0,0,NULL,'2026-11-22T22:12:34.109Z','2026-11-22T22:12:34.161Z','succeeded',NULL,'{"deleted":0,"retired":0}');
INSERT INTO housekeeping_jobs VALUES('enrichment-sweep','2026-11-22T22:13:14.123Z',0,1,NULL,'2026-11-22T22:12:44.107Z','2026-11-22T22:12:44.123Z','succeeded',NULL,'{"extracted":0,"skipped":0,"failed":0}');
INSERT INTO housekeeping_jobs VALUES('event-log-cleanup','2026-11-22T23:12:24.119Z',0,0,NULL,'2026-11-22T22:12:24.106Z','2026-11-22T22:12:24.119Z','succeeded',NULL,'{"deleted":0,"purged_records":0}');
INSERT INTO housekeeping_jobs VALUES('feed-expiry','2026-11-22T23:12:19.119Z',0,0,NULL,'2026-11-22T22:12:19.109Z','2026-11-22T22:12:19.119Z','succeeded',NULL,'{"moved":0,"held":0}');
INSERT INTO housekeeping_jobs VALUES('inbound-delivery-cleanup','2026-11-22T22:13:29.123Z',0,0,NULL,'2026-11-22T22:12:29.108Z','2026-11-22T22:12:29.123Z','succeeded',NULL,'{"deleted":0,"remaining":false}');
INSERT INTO housekeeping_jobs VALUES('release-check','2026-11-22T22:13:14.104Z',0,0,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO housekeeping_jobs VALUES('table-row-cleanup','2026-11-22T23:12:44.165Z',0,0,NULL,'2026-11-22T22:12:44.107Z','2026-11-22T22:12:44.165Z','succeeded',NULL,'{"removed":0,"batches_removed":0,"changes_removed":0,"reordered":0,"reindexed":0,"pages":0}');
INSERT INTO housekeeping_jobs VALUES('trash-purge','2026-11-23T22:12:19.119Z',0,0,NULL,'2026-11-22T22:12:19.109Z','2026-11-22T22:12:19.119Z','succeeded',NULL,'{"deleted":0}');
INSERT INTO housekeeping_jobs VALUES('version-thinning','2026-11-22T23:12:19.119Z',0,0,NULL,'2026-11-22T22:12:19.109Z','2026-11-22T22:12:19.119Z','succeeded',NULL,'{"pruned":0,"items":0}');
CREATE TABLE bulk_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    action TEXT NOT NULL,
    input TEXT NOT NULL CHECK (json_valid(input)),
    key_id TEXT,
    grant_id TEXT,
    status TEXT NOT NULL
        CHECK (status IN ('queued', 'in_progress', 'completed', 'failed', 'canceled')),
    matched INTEGER NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0,
    errored INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE bulk_job_items (
    job_id TEXT NOT NULL REFERENCES bulk_jobs (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (job_id, position)
) STRICT, WITHOUT ROWID;
CREATE TABLE bulk_job_notes (
    job_id TEXT NOT NULL REFERENCES bulk_jobs (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('changed', 'error', 'carried', 'blob')),
    name TEXT NOT NULL,
    body TEXT CHECK (body IS NULL OR json_valid(body)),
    UNIQUE (job_id, kind, name)
) STRICT;
INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql)VALUES('table','items_fts','items_fts',0,'CREATE VIRTUAL TABLE items_fts USING fts5(
    title, body, description, name, extra, tags,
    tokenize = ''porter unicode61''
)');
CREATE TABLE IF NOT EXISTS 'items_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO items_fts_data VALUES(1,x'03000700000202');
INSERT INTO items_fts_data VALUES(10,x'000000000103030003010101020101030101');
INSERT INTO items_fts_data VALUES(137438953473,x'00000031063066697273740106010102010468696768010601040201026f6e01060105020103776974010c010103010503040c0b09');
INSERT INTO items_fts_data VALUES(274877906945,x'0000002504306c6f77020601040201067365636f6e64020601010201037769740206010103040a0d');
INSERT INTO items_fts_data VALUES(412316860417,x'0000002202306103060101020104636f7265030601010301046e6f7465030601010404080b');
CREATE TABLE IF NOT EXISTS 'items_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
INSERT INTO items_fts_idx VALUES(1,x'',2);
INSERT INTO items_fts_idx VALUES(2,x'',2);
INSERT INTO items_fts_idx VALUES(3,x'',2);
CREATE TABLE IF NOT EXISTS 'items_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5);
INSERT INTO items_fts_content VALUES(1,'','first witness','','','high','one witness');
INSERT INTO items_fts_content VALUES(2,'','second witness','','','low','');
INSERT INTO items_fts_content VALUES(3,'','a core note','','','','');
CREATE TABLE IF NOT EXISTS 'items_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
INSERT INTO items_fts_docsize VALUES(1,x'000200000102');
INSERT INTO items_fts_docsize VALUES(2,x'000200000100');
INSERT INTO items_fts_docsize VALUES(3,x'000300000000');
CREATE TABLE IF NOT EXISTS 'items_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO items_fts_config VALUES('version',4);
CREATE TABLE items_fts_sizes (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    state TEXT NOT NULL,
    source TEXT NOT NULL,
    tokens INTEGER NOT NULL CHECK (tokens >= 0)
) STRICT;
INSERT INTO items_fts_sizes VALUES(1,'01f00000-0000-7000-8000-000000000001','user.upgrade_witness','active','upgrade-fixture',5);
INSERT INTO items_fts_sizes VALUES(2,'01f00000-0000-7000-8000-000000000002','user.upgrade_witness','active','upgrade-fixture',3);
INSERT INTO items_fts_sizes VALUES(3,'01f00000-0000-7000-8000-000000000003','core.note','active','upgrade-fixture',3);
CREATE TABLE items_fts_totals (
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    entries INTEGER NOT NULL CHECK (entries >= 0),
    tokens INTEGER NOT NULL CHECK (tokens >= 0),
    PRIMARY KEY (type, source)
) STRICT, WITHOUT ROWID;
INSERT INTO items_fts_totals VALUES('core.note','upgrade-fixture',1,3);
INSERT INTO items_fts_totals VALUES('user.upgrade_witness','upgrade-fixture',2,8);
CREATE TABLE items_fts_pending (
    seq INTEGER PRIMARY KEY
) STRICT;
CREATE TABLE items_fts_stale (
    type TEXT NOT NULL,
    state TEXT NOT NULL,
    after_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (type, state)
) STRICT, WITHOUT ROWID;
CREATE TABLE sort_indexes (
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    filled_through INTEGER NOT NULL DEFAULT 0,
    ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
    PRIMARY KEY (type, name)
) STRICT, WITHOUT ROWID;
CREATE TABLE sort_indexes_dropping (
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (type, name)
) STRICT, WITHOUT ROWID;
CREATE TABLE item_sort_keys (
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    value ANY NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (type, name, value, id)
) STRICT, WITHOUT ROWID;
CREATE TABLE owner (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT,
    password TEXT NOT NULL,
    credentials INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
INSERT INTO owner VALUES('01a20551-501c-7195-83a1-94de5e30d8fc','conformance-owner','conformance-owner',NULL,'$argon2id$v=19$m=19456,t=2,p=1$VYah2+vv9rNNtHlOlux/wQ$Bz2RkA820vXIFCXYQJ5Q1S1G95aKHZKBGz6GCxUyF6U',0,'2026-11-22T22:12:24.732Z','2026-11-22T22:12:24.732Z');
CREATE TABLE sign_ins (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    client_ip TEXT
) STRICT;
CREATE TABLE setup_proof (
    digest TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('code', 'ticket', 'session')),
    generation TEXT NOT NULL,
    expires_at TEXT
) STRICT, WITHOUT ROWID;
CREATE TABLE mcp_spent_confirmations (
    token TEXT PRIMARY KEY NOT NULL,
    credential TEXT NOT NULL,
    subject_digest TEXT NOT NULL,
    total INTEGER NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY NOT NULL,
    application_type TEXT NOT NULL CHECK (application_type IN ('web', 'native')),
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    response_types TEXT NOT NULL,
    scopes TEXT NOT NULL,
    client_name TEXT,
    client_uri TEXT,
    logo_uri TEXT,
    tos_uri TEXT,
    policy_uri TEXT,
    contacts TEXT NOT NULL,
    software_id TEXT,
    software_version TEXT,
    created_at TEXT NOT NULL,
    offered_at TEXT
) STRICT;
CREATE TABLE oauth_client_documents (
    client_id TEXT PRIMARY KEY NOT NULL
        REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    fetched_at TEXT NOT NULL,
    fresh_until TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE oauth_consents (
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    grant_id TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    withdrawn_at TEXT, login_after TEXT,
    PRIMARY KEY (client_id, owner_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE webhooks (
    id TEXT PRIMARY KEY NOT NULL,
    url TEXT NOT NULL,
    events TEXT NOT NULL CHECK (json_valid(events)),
    type_filter TEXT,
    secret TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE,
    grant_id TEXT REFERENCES oauth_consents (grant_id) ON DELETE CASCADE,
    starts_after INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE webhook_turns (
    key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE,
    grant_id TEXT REFERENCES oauth_consents (grant_id) ON DELETE CASCADE,
    turns INTEGER NOT NULL,
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT;
CREATE TABLE webhook_deliveries (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    webhook_id TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
    status_code INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0,
    cycle_attempt INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    due_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webhook_id, event_id),
    CHECK (payload IS NOT NULL OR status IN ('succeeded', 'canceled'))
) STRICT;
CREATE TABLE webhook_position (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    event_id INTEGER NOT NULL
) STRICT;
INSERT INTO webhook_position VALUES(1,4);
CREATE TABLE oauth_consent_destinations (
    client_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    page_origin TEXT,
    PRIMARY KEY (client_id, owner_id, redirect_uri),
    FOREIGN KEY (client_id, owner_id)
        REFERENCES oauth_consents (client_id, owner_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE oauth_codes (
    digest TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    authenticated_at TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    challenge TEXT NOT NULL,
    resources TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    spent_at TEXT,
    chain_id TEXT
) STRICT, WITHOUT ROWID;
CREATE TABLE oauth_device_codes (
    device_code TEXT PRIMARY KEY NOT NULL,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    destinations TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'spent')),
    owner_id TEXT REFERENCES owner (id) ON DELETE CASCADE,
    authenticated_at TEXT,
    signed_in_after TEXT,
    interval_seconds INTEGER NOT NULL,
    last_polled_at TEXT,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE oauth_access_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    authenticated_at TEXT NOT NULL,
    scopes TEXT NOT NULL,
    audience TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT;
CREATE TABLE oauth_refresh_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    chain_id TEXT NOT NULL,
    authenticated_at TEXT NOT NULL,
    scopes TEXT NOT NULL,
    audience TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    rotated_at TEXT,
    ended_at TEXT
) STRICT;
CREATE TABLE passkeys (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES owner (id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    name TEXT,
    credential TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
) STRICT;
CREATE TABLE passkey_challenges_answered (
    digest TEXT PRIMARY KEY NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE blobs (
    hash TEXT PRIMARY KEY NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    recorded_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE stores (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('disk', 'folder', 's3')),
    locator TEXT NOT NULL,
    attached_at TEXT NOT NULL,
    detached_at TEXT
) STRICT, WITHOUT ROWID;
INSERT INTO stores VALUES('01a20551-267d-71d5-aa62-3b74fc1b25e2','disk','/data/blobs','2026-11-22T22:12:14.074Z',NULL);
CREATE TABLE blob_copies (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores (id),
    object TEXT NOT NULL DEFAULT '',
    written INTEGER NOT NULL CHECK (written IN (0, 1)),
    recorded_at TEXT NOT NULL,
    verified_at TEXT,
    PRIMARY KEY (hash, store_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE blob_copy_failures (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores (id),
    failures INTEGER NOT NULL CHECK (failures > 0),
    PRIMARY KEY (hash, store_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE blob_proofs (
    hash TEXT NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    holder TEXT NOT NULL,
    PRIMARY KEY (hash, holder)
) STRICT, WITHOUT ROWID;
CREATE TABLE blob_references (
    hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('item', 'edge', 'extension', 'version', 'owner')),
    seq INTEGER NOT NULL,
    namespace TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    lends INTEGER NOT NULL CHECK (lends IN (0, 1)),
    item_type TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    PRIMARY KEY (hash, kind, seq, namespace, version)
) STRICT, WITHOUT ROWID;
CREATE TABLE blob_job_holds (
    hash TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES bulk_jobs (id) ON DELETE CASCADE,
    PRIMARY KEY (hash, job_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE blob_orphans (
    hash TEXT PRIMARY KEY NOT NULL REFERENCES blobs (hash) ON DELETE CASCADE,
    reported_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE blob_pending_deletions (
    hash TEXT NOT NULL,
    store_id TEXT NOT NULL REFERENCES stores (id),
    object TEXT NOT NULL DEFAULT '',
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (hash, store_id, object)
) STRICT, WITHOUT ROWID;
CREATE TABLE owner_avatar (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    hash TEXT NOT NULL CHECK (length(hash) = 71),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
    updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE folder_status (
    folder_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    key_id TEXT REFERENCES api_keys (id) ON DELETE CASCADE,
    grant_id TEXT REFERENCES oauth_consents (grant_id) ON DELETE CASCADE,
    sign_in_kind TEXT GENERATED ALWAYS AS (CASE WHEN key_id IS NULL THEN 'app' ELSE 'key' END) VIRTUAL,
    sign_in_id TEXT GENERATED ALWAYS AS (coalesce(key_id, grant_id)) VIRTUAL,
    sign_in_name TEXT NOT NULL,
    folder_store_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    received_at TEXT NOT NULL,
    last_success_at TEXT,
    pending_uploads INTEGER NOT NULL CHECK (pending_uploads >= 0),
    pending_downloads INTEGER NOT NULL CHECK (pending_downloads >= 0),
    paused_removals INTEGER NOT NULL CHECK (paused_removals >= 0),
    first_sync_waiting INTEGER NOT NULL CHECK (first_sync_waiting IN (0, 1)),
    problems TEXT NOT NULL CHECK (json_valid(problems)),
    CHECK ((key_id IS NULL) <> (grant_id IS NULL))
) STRICT;
CREATE TABLE connectors (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    key_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (length(source) > 0),
    name TEXT NOT NULL CHECK (length(name) > 0),
    description TEXT,
    read_only_types TEXT NOT NULL CHECK (json_valid(read_only_types)),
    registered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_heartbeat_at TEXT
) STRICT;
CREATE TABLE connector_runs (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    connector_id TEXT NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    summary TEXT,
    error TEXT,
    reported_at TEXT NOT NULL
) STRICT;
CREATE TABLE connector_holds (
    connector_id TEXT PRIMARY KEY REFERENCES connectors (id) ON DELETE CASCADE,
    process TEXT NOT NULL,
    expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE connector_states (
    source TEXT PRIMARY KEY CHECK (length(source) > 0),
    state TEXT NOT NULL CHECK (json_valid(state)),
    problems TEXT NOT NULL CHECK (json_valid(problems)),
    updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE connector_agreements (
    source TEXT NOT NULL CHECK (length(source) > 0),
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    waiting INTEGER NOT NULL CHECK (waiting IN (0, 1)),
    record TEXT NOT NULL CHECK (json_valid(record)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE clock_trust (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    trusted_at TEXT NOT NULL,
    held_ms INTEGER CHECK (held_ms >= 0)
) STRICT;
INSERT INTO clock_trust VALUES(1,'2026-11-22T22:12:44.165Z',NULL);
CREATE TABLE read_only_generation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
) STRICT;
CREATE TABLE enrichment_files (
    item_seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'read', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    reason TEXT CHECK (reason IN ('unsupported', 'encrypted', 'over_limit', 'ocr', 'missing')),
    signature TEXT NOT NULL DEFAULT '',
    -- The limit that stopped an over-limit file, and what it was then.
    capped_by TEXT CHECK (capped_by IN ('blob', 'inflated', 'memory', 'fixed')),
    cap INTEGER,
    -- A skipped file offered once more because a field a read fills was cleared; the refusal stays.
    refill INTEGER NOT NULL DEFAULT 0 CHECK (refill IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_seq, hash),
    CHECK (refill = 0 OR state = 'skipped'),
    CHECK ((state = 'skipped') = (reason IS NOT NULL)),
    CHECK ((reason IS 'over_limit') = (capped_by IS NOT NULL)),
    CHECK ((capped_by IS NULL) = (cap IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE backup_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    changes INTEGER NOT NULL DEFAULT 0,
    backed_up INTEGER,
    backed_up_version INTEGER,
    last_backup TEXT,
    last_backup_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_failed_at TEXT,
    last_error_in_store INTEGER NOT NULL DEFAULT 0 CHECK (last_error_in_store IN (0, 1))
) STRICT;
INSERT INTO backup_state VALUES(1,36,NULL,NULL,NULL,NULL,0,NULL,NULL,0);
CREATE TABLE backups (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    -- Its asker's access ended before it was recorded: never confirmed, its manifest deleted.
    refused INTEGER NOT NULL DEFAULT 0 CHECK (refused IN (0, 1)),
    -- How many listings in a row have omitted it while a later backup was recorded.
    omissions INTEGER NOT NULL DEFAULT 0 CHECK (omissions >= 0),
    UNIQUE (store_id, name)
) STRICT;
CREATE TABLE backup_files (
    store_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER,
    PRIMARY KEY (store_id, hash)
) STRICT, WITHOUT ROWID;
CREATE TABLE found_backups (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    name TEXT NOT NULL,
    files_read INTEGER NOT NULL DEFAULT 0 CHECK (files_read IN (0, 1)),
    omissions INTEGER NOT NULL DEFAULT 0 CHECK (omissions >= 0),
    UNIQUE (store_id, name)
) STRICT;
CREATE TABLE found_backup_files (
    seq INTEGER NOT NULL REFERENCES found_backups (seq),
    hash TEXT NOT NULL,
    PRIMARY KEY (seq, hash)
) STRICT, WITHOUT ROWID;
CREATE TABLE found_backup_parts (
    seq INTEGER NOT NULL REFERENCES found_backups (seq),
    sha256 TEXT NOT NULL,
    PRIMARY KEY (seq, sha256)
) STRICT, WITHOUT ROWID;
CREATE TABLE backup_parts (
    store_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    tag TEXT,
    hashed_at TEXT,
    damaged INTEGER NOT NULL DEFAULT 0 CHECK (damaged IN (0, 1)),
    PRIMARY KEY (store_id, sha256)
) STRICT, WITHOUT ROWID;
CREATE TABLE inbound_sources (
    source TEXT PRIMARY KEY CHECK (length(source) > 0),
    connector_id TEXT NOT NULL UNIQUE REFERENCES connectors (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TABLE inbound_endpoints (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL REFERENCES inbound_sources (source) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    token_last4 TEXT NOT NULL CHECK (length(token_last4) = 4),
    label TEXT CHECK (label IS NULL OR length(label) > 0),
    duplicate_header TEXT,
    created_at TEXT NOT NULL,
    retired_at TEXT
) STRICT;
CREATE TABLE inbound_deliveries (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    endpoint_id TEXT NOT NULL REFERENCES inbound_endpoints (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    received_at TEXT NOT NULL,
    method TEXT NOT NULL,
    query TEXT NOT NULL,
    headers TEXT NOT NULL CHECK (json_valid(headers)),
    size INTEGER NOT NULL CHECK (size >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    dedupe_key TEXT,
    charge INTEGER NOT NULL CHECK (charge >= size),
    handled_at TEXT,
    outcome TEXT CHECK (outcome IN ('processed', 'duplicate', 'rejected')),
    CHECK ((handled_at IS NULL) = (outcome IS NULL))
) STRICT;
CREATE TABLE inbound_bodies (
    delivery_seq INTEGER PRIMARY KEY REFERENCES inbound_deliveries (seq) ON DELETE CASCADE,
    body BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sqlite_sequence(name,seq);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('items',3);
INSERT INTO sqlite_sequence VALUES('event_log',4);
INSERT INTO sqlite_sequence VALUES('edges',1);
CREATE TRIGGER row_search_added AFTER INSERT ON row_search BEGIN
    UPDATE table_summaries SET indexed = indexed + 1, indexed_tokens = indexed_tokens + NEW.tokens
    WHERE seq = NEW.table_seq;
END;
CREATE TRIGGER row_search_removed AFTER DELETE ON row_search BEGIN
    UPDATE table_summaries SET indexed = indexed - 1, indexed_tokens = indexed_tokens - OLD.tokens
    WHERE seq = OLD.table_seq;
END;
CREATE TRIGGER row_search_resized AFTER UPDATE OF tokens ON row_search BEGIN
    UPDATE table_summaries SET indexed_tokens = indexed_tokens - OLD.tokens + NEW.tokens
    WHERE seq = NEW.table_seq;
END;
CREATE TRIGGER items_fts_sized AFTER INSERT ON items_fts_sizes BEGIN
    INSERT INTO items_fts_totals (type, source, entries, tokens)
    VALUES (NEW.type, NEW.source, 1, NEW.tokens)
    ON CONFLICT (type, source) DO UPDATE
    SET entries = entries + 1, tokens = tokens + excluded.tokens;
END;
CREATE TRIGGER items_fts_unsized AFTER DELETE ON items_fts_sizes BEGIN
    UPDATE items_fts_totals SET entries = entries - 1, tokens = tokens - OLD.tokens
    WHERE type = OLD.type AND source = OLD.source;
END;
CREATE TRIGGER items_fts_resized AFTER UPDATE OF type, source, tokens ON items_fts_sizes BEGIN
    UPDATE items_fts_totals SET entries = entries - 1, tokens = tokens - OLD.tokens
    WHERE type = OLD.type AND source = OLD.source;
    INSERT INTO items_fts_totals (type, source, entries, tokens)
    VALUES (NEW.type, NEW.source, 1, NEW.tokens)
    ON CONFLICT (type, source) DO UPDATE
    SET entries = entries + 1, tokens = tokens + excluded.tokens;
END;
CREATE TRIGGER items_fts_moved AFTER UPDATE OF type, source, state ON items
WHEN NEW.type IS NOT OLD.type OR NEW.source IS NOT OLD.source OR NEW.state IS NOT OLD.state
BEGIN
    UPDATE items_fts_sizes SET type = NEW.type, source = NEW.source, state = NEW.state
    WHERE seq = NEW.seq;
END;
CREATE TRIGGER items_fts_inserted AFTER INSERT ON items BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (NEW.seq);
END;
CREATE TRIGGER items_fts_updated AFTER UPDATE OF type, state, properties ON items
WHEN NEW.type IS NOT OLD.type OR NEW.state IS NOT OLD.state
    OR NEW.properties IS NOT OLD.properties
BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (NEW.seq);
END;
CREATE TRIGGER items_fts_deleted AFTER DELETE ON items BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (OLD.seq);
END;
CREATE TRIGGER item_tags_fts_inserted AFTER INSERT ON item_tags BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (NEW.item_seq);
END;
CREATE TRIGGER item_tags_fts_deleted AFTER DELETE ON item_tags BEGIN
    INSERT OR IGNORE INTO items_fts_pending (seq) VALUES (OLD.item_seq);
END;
CREATE TRIGGER items_restored
AFTER UPDATE OF state ON items
WHEN OLD.state = 'trashed' AND NEW.state <> 'trashed'
BEGIN
    UPDATE items SET restored_at = NEW.updated_at WHERE seq = NEW.seq;
END;
CREATE TRIGGER item_sort_keys_inserted AFTER INSERT ON items
WHEN EXISTS (SELECT 1 FROM sort_indexes WHERE type = NEW.type)
BEGIN
    INSERT OR IGNORE INTO item_sort_keys (type, name, value, id, seq)
    SELECT NEW.type, s.name, COALESCE(CASE json_type(NEW.properties, '$.' || s.name) WHEN 'integer' THEN CAST(json_extract(NEW.properties, '$.' || s.name) AS REAL) WHEN 'real' THEN CAST(json_extract(NEW.properties, '$.' || s.name) AS REAL) WHEN 'text' THEN (SELECT CASE WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) / 1000.0, 'unixepoch'), CASE WHEN (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) IS NOT NULL THEN '9999-12-31T23:59:59.999Z+' || printf('%09d', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) - 253402300799999) END, v) ELSE v END FROM (SELECT json_extract(NEW.properties, '$.' || s.name) AS v)) WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 ELSE NULL END, X''), NEW.id, NEW.seq
    FROM sort_indexes s WHERE s.type = NEW.type;
END;
CREATE TRIGGER item_sort_keys_changed AFTER UPDATE OF type, properties ON items
WHEN (NEW.type IS NOT OLD.type OR NEW.properties IS NOT OLD.properties)
    AND (EXISTS (SELECT 1 FROM sort_indexes WHERE type = OLD.type)
        OR EXISTS (SELECT 1 FROM sort_indexes WHERE type = NEW.type))
BEGIN
    DELETE FROM item_sort_keys WHERE (type, name, value, id) IN (
        SELECT OLD.type, s.name, COALESCE(CASE json_type(OLD.properties, '$.' || s.name) WHEN 'integer' THEN CAST(json_extract(OLD.properties, '$.' || s.name) AS REAL) WHEN 'real' THEN CAST(json_extract(OLD.properties, '$.' || s.name) AS REAL) WHEN 'text' THEN (SELECT CASE WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) / 1000.0, 'unixepoch'), CASE WHEN (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) IS NOT NULL THEN '9999-12-31T23:59:59.999Z+' || printf('%09d', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) - 253402300799999) END, v) ELSE v END FROM (SELECT json_extract(OLD.properties, '$.' || s.name) AS v)) WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 ELSE NULL END, X''), OLD.id
        FROM sort_indexes s WHERE s.type = OLD.type);
    INSERT OR IGNORE INTO item_sort_keys (type, name, value, id, seq)
    SELECT NEW.type, s.name, COALESCE(CASE json_type(NEW.properties, '$.' || s.name) WHEN 'integer' THEN CAST(json_extract(NEW.properties, '$.' || s.name) AS REAL) WHEN 'real' THEN CAST(json_extract(NEW.properties, '$.' || s.name) AS REAL) WHEN 'text' THEN (SELECT CASE WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) / 1000.0, 'unixepoch'), CASE WHEN (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) IS NOT NULL THEN '9999-12-31T23:59:59.999Z+' || printf('%09d', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) - 253402300799999) END, v) ELSE v END FROM (SELECT json_extract(NEW.properties, '$.' || s.name) AS v)) WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 ELSE NULL END, X''), NEW.id, NEW.seq
    FROM sort_indexes s WHERE s.type = NEW.type;
END;
CREATE TRIGGER item_sort_keys_deleted AFTER DELETE ON items
WHEN EXISTS (SELECT 1 FROM sort_indexes WHERE type = OLD.type)
BEGIN
    DELETE FROM item_sort_keys WHERE (type, name, value, id) IN (
        SELECT OLD.type, s.name, COALESCE(CASE json_type(OLD.properties, '$.' || s.name) WHEN 'integer' THEN CAST(json_extract(OLD.properties, '$.' || s.name) AS REAL) WHEN 'real' THEN CAST(json_extract(OLD.properties, '$.' || s.name) AS REAL) WHEN 'text' THEN (SELECT CASE WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) / 1000.0, 'unixepoch'), CASE WHEN (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) IS NOT NULL THEN '9999-12-31T23:59:59.999Z+' || printf('%09d', (CASE WHEN date(substr(v, 1, 10)) IS NOT substr(v, 1, 10) THEN NULL WHEN length(v) = 10 THEN CAST(round((julianday(v) - 2440587.5) * 86400000.0) AS INTEGER) WHEN substr(v, 11, 1) <> 'T' THEN NULL WHEN v GLOB '*Z' THEN CAST(round((julianday(substr(v, 1, length(v) - 1)) - 2440587.5) * 86400000.0) AS INTEGER) WHEN v GLOB '*[+-][0-9][0-9]:[0-9][0-9]' AND CAST(substr(v, -5, 2) AS INTEGER) < 24 AND CAST(substr(v, -2) AS INTEGER) < 60 THEN CAST(round((julianday(substr(v, 1, length(v) - 6)) - 2440587.5) * 86400000.0) AS INTEGER) - (CASE substr(v, -6, 1) WHEN '-' THEN -60000 ELSE 60000 END) * (CAST(substr(v, -5, 2) AS INTEGER) * 60 + CAST(substr(v, -2) AS INTEGER)) END) - 253402300799999) END, v) ELSE v END FROM (SELECT json_extract(OLD.properties, '$.' || s.name) AS v)) WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 ELSE NULL END, X''), OLD.id
        FROM sort_indexes s WHERE s.type = OLD.type);
END;
CREATE TRIGGER blob_references_retyped AFTER UPDATE OF type ON items
WHEN NEW.type IS NOT OLD.type
BEGIN
    UPDATE blob_references SET item_type = NEW.type
    WHERE kind IN ('item', 'extension') AND seq = NEW.seq;
    UPDATE blob_references SET item_type = NEW.type
    WHERE kind = 'edge' AND seq IN (SELECT seq FROM edges WHERE from_id = NEW.id);
END;
CREATE TRIGGER blob_references_edge_moved AFTER UPDATE OF from_id, edge_type ON edges
WHEN NEW.from_id IS NOT OLD.from_id OR NEW.edge_type IS NOT OLD.edge_type
BEGIN
    UPDATE blob_references
    SET item_type = (SELECT type FROM items WHERE id = NEW.from_id), edge_type = NEW.edge_type
    WHERE kind = 'edge' AND seq = NEW.seq;
END;
CREATE TRIGGER read_only_registered AFTER INSERT ON connectors
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER read_only_declared AFTER UPDATE OF read_only_types ON connectors
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER read_only_removed AFTER DELETE ON connectors
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER read_only_key_changed
AFTER UPDATE OF source, type_permissions, expires_at, revoked_at ON api_keys
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER read_only_key_removed AFTER DELETE ON api_keys
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER read_only_claim_changed AFTER INSERT ON api_key_sources
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER read_only_claim_removed AFTER DELETE ON api_key_sources
BEGIN
    INSERT INTO read_only_generation (id, value) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET value = value + 1;
END;
CREATE TRIGGER enrichment_files_referenced AFTER INSERT ON blob_references
WHEN NEW.kind = 'item' AND NEW.lends = 1
BEGIN
    INSERT OR REPLACE INTO enrichment_files (item_seq, hash, updated_at)
    VALUES (NEW.seq, NEW.hash, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    UPDATE housekeeping_jobs SET wake_requested = 1 WHERE wakes_on_files = 1 AND wake_requested = 0;
END;
CREATE TRIGGER enrichment_files_changed AFTER UPDATE OF type, properties ON items
WHEN NEW.properties ->> '$.blob_ref' IS NOT NULL AND (
    NEW.type IS NOT OLD.type
    OR NEW.properties ->> '$.blob_ref' IS NOT OLD.properties ->> '$.blob_ref'
    OR NEW.properties ->> '$.mime_type' IS NOT OLD.properties ->> '$.mime_type'
    OR (NEW.properties ->> '$.extracted_text' IS NULL AND OLD.properties ->> '$.extracted_text' IS NOT NULL)
    OR (NEW.properties ->> '$.width' IS NULL AND OLD.properties ->> '$.width' IS NOT NULL)
    OR (NEW.properties ->> '$.height' IS NULL AND OLD.properties ->> '$.height' IS NOT NULL)
    OR (NEW.properties ->> '$.duration' IS NULL AND OLD.properties ->> '$.duration' IS NOT NULL))
BEGIN
    INSERT INTO enrichment_files (item_seq, hash, updated_at)
    VALUES (NEW.seq, NEW.properties ->> '$.blob_ref', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (item_seq, hash) DO UPDATE
    SET state = CASE enrichment_files.state WHEN 'read' THEN 'waiting' ELSE enrichment_files.state END,
        attempts = 0,
        reason = CASE enrichment_files.state WHEN 'read' THEN NULL ELSE enrichment_files.reason END,
        signature = CASE enrichment_files.state WHEN 'read' THEN '' ELSE enrichment_files.signature END,
        refill = CASE enrichment_files.state WHEN 'skipped' THEN 1 ELSE 0 END,
        updated_at = excluded.updated_at
    WHERE enrichment_files.state IN ('read', 'skipped')
       OR (enrichment_files.state = 'waiting' AND enrichment_files.attempts > 0
           AND (NEW.type IS NOT OLD.type
                OR NEW.properties ->> '$.mime_type' IS NOT OLD.properties ->> '$.mime_type'));
    UPDATE housekeeping_jobs SET wake_requested = 1 WHERE wakes_on_files = 1 AND wake_requested = 0;
END;
CREATE TRIGGER enrichment_files_copy_recorded AFTER INSERT ON blob_copies
WHEN EXISTS (SELECT 1 FROM enrichment_files WHERE hash = NEW.hash AND reason = 'missing')
BEGIN
    UPDATE enrichment_files
    SET state = 'waiting', reason = NULL, refill = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE hash = NEW.hash AND reason = 'missing';
    UPDATE housekeeping_jobs SET wake_requested = 1 WHERE wakes_on_files = 1 AND wake_requested = 0;
END;
CREATE TRIGGER enrichment_files_store_attached AFTER UPDATE OF detached_at ON stores
WHEN OLD.detached_at IS NOT NULL AND NEW.detached_at IS NULL
BEGIN
    UPDATE enrichment_files
    SET state = 'waiting', reason = NULL, refill = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE reason = 'missing'
      AND hash IN (SELECT hash FROM blob_copies WHERE store_id = NEW.id);
    UPDATE housekeeping_jobs SET wake_requested = 1 WHERE wakes_on_files = 1 AND wake_requested = 0;
END;
CREATE TRIGGER enrichment_files_unreferenced AFTER DELETE ON blob_references
WHEN OLD.kind = 'item'
BEGIN
    DELETE FROM enrichment_files WHERE item_seq = OLD.seq AND hash = OLD.hash;
END;
CREATE TRIGGER backup_items_inserted AFTER INSERT ON items BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_items_updated AFTER UPDATE ON items BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_items_deleted AFTER DELETE ON items BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_tags_inserted AFTER INSERT ON item_tags BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_tags_updated AFTER UPDATE ON item_tags BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_tags_deleted AFTER DELETE ON item_tags BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_extensions_inserted AFTER INSERT ON item_extensions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_extensions_updated AFTER UPDATE ON item_extensions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_extensions_deleted AFTER DELETE ON item_extensions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_versions_inserted AFTER INSERT ON item_versions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_versions_updated AFTER UPDATE ON item_versions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_item_versions_deleted AFTER DELETE ON item_versions BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_edges_inserted AFTER INSERT ON edges BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_edges_updated AFTER UPDATE ON edges BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_edges_deleted AFTER DELETE ON edges BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_types_inserted AFTER INSERT ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_types_updated AFTER UPDATE ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_types_deleted AFTER DELETE ON types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_edge_types_inserted AFTER INSERT ON edge_types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_edge_types_updated AFTER UPDATE ON edge_types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_edge_types_deleted AFTER DELETE ON edge_types BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_source_names_inserted AFTER INSERT ON source_names BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_source_names_updated AFTER UPDATE ON source_names BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_source_names_deleted AFTER DELETE ON source_names BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_connector_states_inserted AFTER INSERT ON connector_states BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_connector_states_updated AFTER UPDATE ON connector_states BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_connector_states_deleted AFTER DELETE ON connector_states BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_connector_agreements_inserted AFTER INSERT ON connector_agreements BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_connector_agreements_updated AFTER UPDATE ON connector_agreements BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_connector_agreements_deleted AFTER DELETE ON connector_agreements BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_settings_inserted AFTER INSERT ON settings
BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_settings_updated AFTER UPDATE ON settings
BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE TRIGGER backup_settings_deleted AFTER DELETE ON settings
BEGIN
    INSERT INTO backup_state (id, changes) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET changes = changes + 1;
END;
CREATE UNIQUE INDEX api_keys_held_source
    ON api_keys (source) WHERE revoked_at IS NULL;
CREATE INDEX api_key_sources_source ON api_key_sources (source);
CREATE INDEX audit_log_newest ON audit_log (created_at, id);
CREATE INDEX audit_log_action ON audit_log (action, created_at, id);
CREATE INDEX audit_log_resource
    ON audit_log (resource_type, resource_id, created_at, id);
CREATE INDEX types_parent ON types (parent) WHERE parent IS NOT NULL;
CREATE UNIQUE INDEX edge_types_reverse_name
    ON edge_types (reverse_name) WHERE reverse_name IS NOT NULL;
CREATE UNIQUE INDEX items_natural_key
    ON items (source, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX items_link ON items (type, link) WHERE link IS NOT NULL;
CREATE INDEX items_title_key
    ON items (title_key, id) WHERE title_key IS NOT NULL;
CREATE INDEX items_type_newest ON items (type, state, created_at, id);
CREATE INDEX items_source_newest ON items (source, type, state, created_at, id);
CREATE INDEX items_changed ON items (updated_at, id);
CREATE INDEX items_occurred ON items (occurred_at, id);
CREATE INDEX items_newest ON items (created_at, id);
CREATE INDEX items_bin ON items (created_at, id) WHERE state = 'trashed';
CREATE INDEX items_trashed_with ON items (trashed_with)
    WHERE trashed_with IS NOT NULL;
CREATE INDEX items_feed_window ON items (type, created_at, id)
    WHERE tier = 'feed' AND state = 'active' AND restored_at IS NULL;
CREATE INDEX items_bin_age ON items (trashed_at)
    WHERE state = 'trashed';
CREATE INDEX items_activity ON items (last_activity_at, id);
CREATE INDEX items_event_start
    ON items (julianday(json_extract(properties, '$.starts_at')))
    WHERE json_type(properties, '$.starts_at') = 'text';
CREATE INDEX items_event_always ON items (seq)
    WHERE json_type(properties, '$.recurrence') IN ('array', 'object', 'text', 'integer', 'real', 'true', 'false')
        OR (json_type(properties, '$.starts_at') = 'text' AND (julianday(json_extract(properties, '$.starts_at')) IS NULL
            OR (json_type(properties, '$.ends_at') = 'text' AND julianday(json_extract(properties, '$.ends_at')) IS NULL)
            OR COALESCE(CASE WHEN json_type(properties, '$.ends_at') = 'text' THEN julianday(json_extract(properties, '$.ends_at')) END,
                        julianday(json_extract(properties, '$.starts_at')) + json_extract(properties, '$.duration') / 86400.0)
               - julianday(json_extract(properties, '$.starts_at')) > 31.0));
CREATE INDEX table_rows_updated ON table_rows (table_seq, updated_at);
CREATE INDEX table_rows_ordered ON table_rows (table_seq, ord) WHERE ord IS NOT NULL;
CREATE INDEX row_batches_table ON row_batches (table_seq, seq);
CREATE INDEX edges_from ON edges (from_id, edge_type, created_at, id);
CREATE INDEX edges_to ON edges (to_id, edge_type, created_at, id);
CREATE INDEX edges_type ON edges (edge_type, created_at, id);
CREATE INDEX edges_newest ON edges (created_at, id);
CREATE INDEX edges_changed ON edges (updated_at, id);
CREATE INDEX item_versions_id ON item_versions (id);
CREATE INDEX natural_key_tombstones_key
    ON natural_key_tombstones (source, source_id);
CREATE INDEX idempotency_records_age ON idempotency_records (created_at);
CREATE INDEX bulk_jobs_open ON bulk_jobs (status)
    WHERE status IN ('queued', 'in_progress');
CREATE INDEX bulk_jobs_finished ON bulk_jobs (finished_at)
    WHERE finished_at IS NOT NULL;
CREATE INDEX item_sort_keys_descending
    ON item_sort_keys (type, name, value DESC, id, seq);
CREATE INDEX sign_ins_owner ON sign_ins (owner_id);
CREATE INDEX mcp_spent_confirmations_expiry
    ON mcp_spent_confirmations (expires_at);
CREATE INDEX webhooks_key ON webhooks (key_id) WHERE key_id IS NOT NULL;
CREATE INDEX webhooks_grant ON webhooks (grant_id) WHERE grant_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_turns_key ON webhook_turns (key_id) WHERE key_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_turns_grant ON webhook_turns (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX webhook_deliveries_due
    ON webhook_deliveries (due_at, seq) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_newest ON webhook_deliveries (webhook_id, seq);
CREATE INDEX webhook_deliveries_settled
    ON webhook_deliveries (created_at) WHERE status <> 'pending';
CREATE INDEX oauth_codes_grant ON oauth_codes (client_id, owner_id);
CREATE INDEX oauth_device_codes_client ON oauth_device_codes (client_id);
CREATE INDEX oauth_access_tokens_chain ON oauth_access_tokens (chain_id);
CREATE INDEX oauth_access_tokens_grant ON oauth_access_tokens (client_id, owner_id);
CREATE INDEX oauth_refresh_tokens_chain ON oauth_refresh_tokens (chain_id);
CREATE INDEX oauth_refresh_tokens_grant ON oauth_refresh_tokens (client_id, owner_id);
CREATE INDEX passkeys_owner ON passkeys (owner_id);
CREATE INDEX passkey_challenges_answered_expiry
    ON passkey_challenges_answered (expires_at);
CREATE INDEX blob_copies_store ON blob_copies (store_id, verified_at);
CREATE INDEX blob_references_row ON blob_references (kind, seq);
CREATE INDEX blob_lenders
    ON blob_references (hash, kind, item_type, edge_type, namespace) WHERE lends = 1;
CREATE INDEX blob_job_holds_job ON blob_job_holds (job_id);
CREATE UNIQUE INDEX folder_status_copy
    ON folder_status (folder_id, sign_in_kind, sign_in_id, folder_store_id);
CREATE INDEX folder_status_key ON folder_status (key_id) WHERE key_id IS NOT NULL;
CREATE INDEX folder_status_grant ON folder_status (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX connector_runs_newest
    ON connector_runs (connector_id, reported_at DESC, seq DESC);
CREATE INDEX connector_agreements_order
    ON connector_agreements (source, updated_at, item_id);
CREATE INDEX connector_agreements_item ON connector_agreements (item_id);
CREATE INDEX enrichment_files_state ON enrichment_files (state, attempts);
CREATE INDEX enrichment_files_missing ON enrichment_files (hash) WHERE reason = 'missing';
CREATE INDEX found_backup_files_hash ON found_backup_files (hash);
CREATE INDEX inbound_endpoints_source ON inbound_endpoints (source, seq);
CREATE INDEX inbound_deliveries_order ON inbound_deliveries (source, received_at, seq);
CREATE INDEX inbound_deliveries_tally ON inbound_deliveries (source, handled_at, size, charge);
CREATE INDEX inbound_deliveries_endpoint ON inbound_deliveries (endpoint_id, received_at, seq);
CREATE INDEX inbound_deliveries_repeat
    ON inbound_deliveries (endpoint_id, dedupe_key, received_at, seq) WHERE dedupe_key IS NOT NULL;
CREATE INDEX inbound_deliveries_pending_age
    ON inbound_deliveries (received_at, seq) WHERE handled_at IS NULL;
CREATE INDEX inbound_deliveries_handled_age
    ON inbound_deliveries (handled_at, seq) WHERE handled_at IS NOT NULL;
PRAGMA writable_schema=OFF;
COMMIT;
PRAGMA user_version = 3;
