export type {
  DisplayHints,
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
  FieldDefinition,
  FieldFormat,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  TypeSchema,
  VersionPolicy,
} from "./schema-types.js";

export type {
  EdgeTypeSchemaValidationResult,
  SchemaValidationContext,
  SchemaValidationIssue,
  TypeSchemaValidationResult,
} from "./schema-validation.js";
export {
  EDGE_CARDINALITIES,
  EDGE_CASCADES,
  FIELD_FORMATS,
  FIELD_TYPES,
  MERGE_STRATEGIES,
  RESERVED_ITEM_FIELDS,
  normalizeFieldDefinition,
  validateEdgeTypeSchema,
  validateTypeSchema,
} from "./schema-validation.js";

export {
  ALL_TYPES,
  ALL_CONNECTOR_TYPES,
  ALL_SYSTEM_TYPES,
} from "../generated/type-registry.js";
export { ALL_EDGE_TYPES } from "../generated/edge-type-registry.js";
