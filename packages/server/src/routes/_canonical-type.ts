import { labelledTypeDefinition } from "@withmarfa/shared";
import type { TypeSchema } from "@withmarfa/shared";

/** Makes equivalent field defaults comparable without flattening inheritance. */
export function canonicalTypeDefinition(schema: TypeSchema): TypeSchema {
  return labelledTypeDefinition({
    ...schema,
    fields: Object.fromEntries(
      Object.entries(schema.fields).map(([name, field]) => [
        name,
        {
          ...field,
          required: field.required ?? false,
          searchable: field.searchable ?? true,
        },
      ]),
    ),
  });
}
