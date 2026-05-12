// Auto-generated from core/edges/*.json — do not edit manually.
// Run `pnpm --filter @mymehq/types generate` to regenerate.

import type { EdgeTypeSchema } from "../src/schema-types.js";

const about: EdgeTypeSchema = {
  id: "about",
  label: "About",
  description: "Source item is about the target item. Topical connection between items across types.",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  property_schema: {},
};

const attachedTo: EdgeTypeSchema = {
  id: "attached-to",
  label: "Attached to",
  description: "Source is an attachment (a file or media item) belonging to the target. Many-to-many: a file may be attached to multiple hosts; a host may have multiple attachments. Deleting the host orphans the attachment (it may still be attached to other items).",
  cardinality: "many-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
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
  property_schema: {},
};

const inThread: EdgeTypeSchema = {
  id: "in-thread",
  label: "In thread",
  description: "Source item is in the thread-target sequence. Each source is in at most one thread; the target is the thread item. Carries position for ordering.",
  cardinality: "many-to-one",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "orphan",
  property_schema: {
    position: { type: "number", description: "Ordering within the thread (1-based)." },
  },
};

const parentOf: EdgeTypeSchema = {
  id: "parent-of",
  label: "Parent of",
  description: "Source is the parent of the target. Target has at most one parent. Deleting the parent cascades to children.",
  cardinality: "one-to-many",
  source_type_constraints: ["*"],
  target_type_constraints: ["*"],
  cascade_on_delete: "cascade",
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
  property_schema: {},
};

export const ALL_EDGE_TYPES: EdgeTypeSchema[] = [
  about,
  attachedTo,
  authoredBy,
  derivedFrom,
  inThread,
  parentOf,
  references,
  supersedes,
];

