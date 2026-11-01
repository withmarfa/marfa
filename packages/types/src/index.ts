export type {
  DisplayHints,
  EdgeCardinality,
  EdgeCascade,
  EdgeTypeSchema,
  EntryMember,
  FieldDefinition,
  FieldFormat,
  FieldType,
  ItemState,
  MergePolicy,
  MergeStrategy,
  RetentionPolicy,
  StatusGroup,
  StatusValue,
  TypeRole,
  TypeSchema,
  VersionPolicy,
} from "./schema-types.js";
export { MAX_LABEL_LENGTH, STATUS_GROUPS, TYPE_ROLES } from "./schema-types.js";
export {
  STATUS_WORD_PATTERN,
  isStatusGroup,
  mergeFieldChain,
  mergeFieldDefinition,
  statusFieldName,
  statusGroupOf,
} from "./status.js";

export { labelFromName, pluralFromLabel, withFieldLabels } from "./labels.js";

export type { IconSet } from "./icon-sets.js";
export { ICON_SETS, lucideIconId } from "./icon-sets.js";

export type {
  InheritedShapeConflict,
  SchemaValidationIssue,
  TypeSchemaValidationResult,
} from "./schema-validation.js";
export {
  ALWAYS_SEARCHED_FIELDS,
  EDGE_CASCADES,
  EDGE_PROPERTY_KEYS,
  EDGE_TYPE_SCHEMA_KEYS,
  ENTRY_MEMBER_TYPES,
  FIELD_FORMATS,
  FIELD_TYPES,
  FORMAT_TO_FIELD_TYPE,
  MAX_FEED_DAYS,
  RESERVED_ITEM_FIELDS,
  ROLE_CONSTRAINT_PREFIX,
  iconNameIssue,
  isRoleConstraint,
  normalizeEdgeProperties,
  roleFromConstraint,
  storedShapeConflicts,
  unreadKeys,
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
