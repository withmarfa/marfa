-- No type declares compatible_with any more; a stored definition that carries it loses the key.
UPDATE types
SET definition = json_remove(definition, '$.compatible_with')
WHERE json_type(definition, '$.compatible_with') IS NOT NULL;
