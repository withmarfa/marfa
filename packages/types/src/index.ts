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
  TypeRole,
  TypeSchema,
  VersionPolicy,
} from "./schema-types.js";
export { TYPE_ROLES } from "./schema-types.js";

export type {
  EdgeTypeSchemaValidationResult,
  SchemaValidationContext,
  SchemaValidationIssue,
  TypeSchemaValidationResult,
} from "./schema-validation.js";
export {
  ALWAYS_SEARCHED_FIELDS,
  EDGE_CARDINALITIES,
  EDGE_CASCADES,
  FIELD_FORMATS,
  FIELD_TYPES,
  MERGE_STRATEGIES,
  RESERVED_ITEM_FIELDS,
  ROLE_CONSTRAINT_PREFIX,
  isRoleConstraint,
  normalizeFieldDefinition,
  roleFromConstraint,
  validateEdgeTypeSchema,
  validateTypeSchema,
} from "./schema-validation.js";

export {
  ALL_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPE_IDS,
  SHIPPED_TYPE_SHAPES,
} from "../generated/type-registry.js";
export type { PlatformTypeId } from "../generated/type-registry.js";
export {
  ALL_EDGE_TYPES,
  SHIPPED_EDGE_TYPE_SHAPES,
} from "../generated/edge-type-registry.js";
