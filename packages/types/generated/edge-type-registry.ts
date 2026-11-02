// Auto-generated from core/edges/*.json — do not edit manually.
// Run `pnpm --filter @withmarfa/types generate` to regenerate.

import type { EdgeTypeSchema } from "../src/schema-types.js";

const about: EdgeTypeSchema = {
  id: "about",
  label: "About",
  reverse_label: "Subject of",
  description: "Says that an item is about another item, such as a note about a book.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

const attachedTo: EdgeTypeSchema = {
  id: "attached-to",
  label: "Attached to",
  reverse_label: "Attachments",
  description: "Says that an item is attached to another item and exists for it, such as a scanned page attached to the document it was scanned for.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "with-hosts",
  reverse_name: "has-attachment",
  written_at: "source",
  property_schema: {
    position: { type: "number", description: "Where the attachment comes among the item's attachments, such as the page number of a scan." },
  },
};

const commentsOn: EdgeTypeSchema = {
  id: "comments-on",
  label: "Comment on",
  reverse_label: "Comments",
  description: "Says that an item is a comment on another item, including a reply to another comment.",
  cardinality: "many-to-one",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "with-hosts",
  written_at: "source",
  property_schema: {},
};

const derivedFrom: EdgeTypeSchema = {
  id: "derived-from",
  label: "Derived from",
  reverse_label: "Basis for",
  description: "Says that an item was made from another item, such as an imported copy or a summary generated from a note.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

const excerptOf: EdgeTypeSchema = {
  id: "excerpt-of",
  label: "Excerpt from",
  reverse_label: "Excerpts",
  description: "Says that an item is a highlight, quote or clip taken from another item, such as a quote from a book.",
  cardinality: "many-to-one",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

const inCollection: EdgeTypeSchema = {
  id: "in-collection",
  label: "In collection",
  reverse_label: "Contents",
  description: "Says that an item is a member of a container, such as a collection, a series or an album.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["role:container"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {
    position: { type: "number", description: "Where the item comes among the container's members." },
  },
};

const inFolder: EdgeTypeSchema = {
  id: "in-folder",
  label: "In folder",
  reverse_label: "Folder contents",
  description: "Says where an item's file sits in a synced folder.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["system.folder"],
  cascade_on_delete: "orphan",
  written_at: "none",
  property_schema: {
    path: { type: "string", description: "The file's path from the folder's root." },
  },
};

const inThread: EdgeTypeSchema = {
  id: "in-thread",
  label: "In thread",
  reverse_label: "Messages",
  description: "Says that an item is a message in a thread, such as a reply in a conversation.",
  cardinality: "many-to-one",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {
    position: { type: "number", description: "Where the message comes in the thread." },
  },
};

const parentOf: EdgeTypeSchema = {
  id: "parent-of",
  label: "Children",
  reverse_label: "Parent",
  description: "Says that an item is the parent of another item, so that items form a hierarchy.",
  cardinality: "one-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "cascade",
  reverse_name: "child-of",
  written_at: "target",
  property_schema: {},
};

const references: EdgeTypeSchema = {
  id: "references",
  label: "References",
  reverse_label: "Referenced by",
  description: "Says that an item mentions another item, such as a note that links to another note.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

const supersedes: EdgeTypeSchema = {
  id: "supersedes",
  label: "Supersedes",
  reverse_label: "Superseded by",
  description: "Says that an item replaces another item as the current version, such as a revised document that replaces its earlier draft.",
  cardinality: "one-to-one",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

export const ALL_EDGE_TYPES: EdgeTypeSchema[] = [
  about,
  attachedTo,
  commentsOn,
  derivedFrom,
  excerptOf,
  inCollection,
  inFolder,
  inThread,
  parentOf,
  references,
  supersedes,
];

export const SHIPPED_EDGE_TYPE_SHAPES = {
  "about": {
    "cardinality": "many-to-many",
    "cascade_on_delete": "orphan",
    "property_schema": {},
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "attached-to": {
    "cardinality": "many-to-many",
    "cascade_on_delete": "with-hosts",
    "property_schema": {
      "position": {
        "type": "number"
      }
    },
    "reverse_name": "has-attachment",
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "comments-on": {
    "cardinality": "many-to-one",
    "cascade_on_delete": "with-hosts",
    "property_schema": {},
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "derived-from": {
    "cardinality": "many-to-many",
    "cascade_on_delete": "orphan",
    "property_schema": {},
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "excerpt-of": {
    "cardinality": "many-to-one",
    "cascade_on_delete": "orphan",
    "property_schema": {},
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "in-collection": {
    "cardinality": "many-to-many",
    "cascade_on_delete": "orphan",
    "property_schema": {
      "position": {
        "type": "number"
      }
    },
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "role:container"
    ],
    "written_at": "source"
  },
  "in-folder": {
    "cardinality": "many-to-many",
    "cascade_on_delete": "orphan",
    "property_schema": {
      "path": {
        "type": "string"
      }
    },
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "system.folder"
    ],
    "written_at": "none"
  },
  "in-thread": {
    "cardinality": "many-to-one",
    "cascade_on_delete": "orphan",
    "property_schema": {
      "position": {
        "type": "number"
      }
    },
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "parent-of": {
    "cardinality": "one-to-many",
    "cascade_on_delete": "cascade",
    "property_schema": {},
    "reverse_name": "child-of",
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "target"
  },
  "references": {
    "cardinality": "many-to-many",
    "cascade_on_delete": "orphan",
    "property_schema": {},
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "supersedes": {
    "cardinality": "one-to-one",
    "cascade_on_delete": "orphan",
    "property_schema": {},
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  }
} as const;

