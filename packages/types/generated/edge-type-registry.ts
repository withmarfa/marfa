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

const annotates: EdgeTypeSchema = {
  id: "annotates",
  label: "Annotates",
  description: "Source annotates the target. Canonical case: a core.highlight annotating a media item. Source annotates at most one target.",
  cardinality: "many-to-one",
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

const pinnedTo: EdgeTypeSchema = {
  id: "pinned-to",
  label: "Pinned to",
  description: "Source is a member of a group / folder / collection item represented by the target.",
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
  annotates,
  authoredBy,
  derivedFrom,
  inThread,
  parentOf,
  pinnedTo,
  supersedes,
];

