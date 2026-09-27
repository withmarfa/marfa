// Auto-generated from core/edges/*.json — do not edit manually.
// Run `pnpm --filter @withmarfa/types generate` to regenerate.

import type { EdgeTypeSchema } from "../src/schema-types.js";

const about: EdgeTypeSchema = {
  id: "about",
  label: "About",
  description: "Source item is about the target item. Topical connection between items across types.",
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
  description: "Source is an attachment (a file or media item) belonging to the target. Many-to-many: a file may be attached to multiple hosts; a host may have multiple attachments. Deleting the host orphans the attachment (it may still be attached to other items). The attachment's own file writes the edge, saying what it was made for; where the attachment cannot carry frontmatter, such as an image, the host's file writes it under the reverse name, `has-attachment`.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  reverse_name: "has-attachment",
  written_at: "source",
  property_schema: {},
};

const authoredBy: EdgeTypeSchema = {
  id: "authored-by",
  label: "Authored by",
  description: "Source was authored by the target (usually a core.entity.person).",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

const derivedFrom: EdgeTypeSchema = {
  id: "derived-from",
  label: "Derived from",
  description: "Source was produced from the target (imports, AI generation, transformations). Both items remain valid in parallel.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {},
};

const inCollection: EdgeTypeSchema = {
  id: "in-collection",
  label: "In collection",
  description: "Source item is a member of the target container. The target may be any type declaring the `container` role — a collection, an ongoing series, an album, a publisher's own container type — rather than a fixed list of type names, so a connector writing its own vocabulary can express containment without the platform naming its types first. An item may belong to any number of containers, and a container holds any number of members. A container may not itself be a member: containment here is flat, and `parent-of` is what hierarchy is for. Deleting the container leaves its members in place. Carries position for ordering within the container.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["role:container"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {
    position: { type: "number", description: "Ordering within the collection (1-based)." },
  },
};

const inFolder: EdgeTypeSchema = {
  id: "in-folder",
  label: "In folder",
  description: "Where an item's file sits in a folder: the source is the item, the target the folder's `system.folder`, and `path` the file's path relative to the folder's root. Placement only; a folder's search alone decides what it holds, and the edge is never written in a file's frontmatter. An item may sit in any number of folders. Revoking or removing the folder leaves its items in place, and a revoked folder takes no new placement.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["system.folder"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {
    path: { type: "string", description: "The file's path relative to the folder's root, with `/` between names; required, and it may not climb out of the folder. The edge takes no other property." },
  },
};

const inThread: EdgeTypeSchema = {
  id: "in-thread",
  label: "In thread",
  description: "Source item is in the thread-target sequence. Each source is in at most one thread; the target is the thread item. Carries position for ordering.",
  cardinality: "many-to-one",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  written_at: "source",
  property_schema: {
    position: { type: "number", description: "Ordering within the thread (1-based)." },
  },
};

const parentOf: EdgeTypeSchema = {
  id: "parent-of",
  label: "Parent of",
  description: "Source is the parent of the target. Target has at most one parent. Deleting the parent cascades to children. A child's file writes the edge, naming its parent under the reverse name, `child-of`, so a parent's file does not list every child.",
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
  description: "Source explicitly references the target. Distinct from `about` (topical) and `derived-from` (provenance). Covers wikilink-style mentions and the highlight-on-a-book case.",
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
  description: "Source replaces the target as the current version. Linear chain; no cycles. Deleting the head does not promote the predecessor (orphan).",
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
  authoredBy,
  derivedFrom,
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
    "cascade_on_delete": "orphan",
    "property_schema": {},
    "reverse_name": "has-attachment",
    "source_type_constraints": [
      "*"
    ],
    "target_type_constraints": [
      "*"
    ],
    "written_at": "source"
  },
  "authored-by": {
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
    "written_at": "source"
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

