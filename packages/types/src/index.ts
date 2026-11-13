export type { EdgeTypeSchema, TypeRole, TypeSchema } from "./schema-types.js";
export { labelFromName, pluralFromLabel } from "./labels.js";
export {
  ALWAYS_SEARCHED_FIELDS,
  ENTRY_MEMBER_TYPES,
  FIELD_TYPES,
  FORMAT_TO_FIELD_TYPE,
  RESERVED_ITEM_FIELDS,
} from "./schema-validation.js";
export {
  ALL_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPE_IDS,
  SHIPPED_TABLES,
  SHIPPED_TYPE_SHAPES,
} from "../generated/type-registry.js";
export {
  ALL_EDGE_TYPES,
  SHIPPED_EDGE_TYPE_SHAPES,
} from "../generated/edge-type-registry.js";
