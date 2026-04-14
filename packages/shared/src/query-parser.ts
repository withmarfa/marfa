/**
 * Advanced query language parser for filter expressions.
 *
 * Parses filter strings like:
 *   properties.author eq "Orwell"
 *   state eq "active" AND properties.language eq "en"
 *   properties.director eq "Kubrick" OR properties.director eq "Spielberg"
 *
 * into a structured AST for SQL generation.
 */

import { ErrorCode, MymeError } from "./errors.js";

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------

export type FilterValue = string | number | boolean | null;

export type ComparisonOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts_with"
  | "exists"
  | "not_exists";

export type LogicalOp = "AND" | "OR";

export type FieldRef =
  | { kind: "system"; column: string }
  | { kind: "property"; path: string }
  | { kind: "tags" };

export interface FilterCondition {
  field: FieldRef;
  op: ComparisonOp;
  value: FilterValue;
}

export interface FilterExpression {
  conditions: FilterCondition[];
  logical: LogicalOp;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INPUT_LENGTH = 2048;
const MAX_CONDITIONS = 10;

const SYSTEM_FIELDS = new Set([
  "state",
  "type",
  "source",
  "origin",
  "timestamp",
  "created_at",
  "updated_at",
  // V0-spec system fields. parent_id and thread_id are deliberately not
  // listed — Wave 2 edges replaces them; filtering by them via the
  // generic query language would be a short-lived API surface.
  "library",
  "device",
  "version",
  "id",
]);

const COMPARISON_OPS = new Set<ComparisonOp>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "exists",
  "not_exists",
]);

const UNARY_OPS = new Set<ComparisonOp>(["exists", "not_exists"]);

const TAGS_ALLOWED_OPS = new Set<ComparisonOp>([
  "contains",
  "exists",
  "not_exists",
]);

const PROPERTY_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const enum TokenKind {
  Identifier,
  String,
  Number,
  Boolean,
  Null,
}

interface Token {
  kind: TokenKind;
  value: string | number | boolean | null;
  raw: string;
  pos: number;
}

/** Read a character from the string, returning empty string if out of bounds. */
function charAt(s: string, idx: number): string {
  return idx < s.length ? s.charAt(idx) : "";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isIdentChar(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch) || ch === "_" || ch === ".";
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = charAt(input, i);

    // Skip whitespace
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      const start = i;
      i++; // skip opening quote
      let value = "";
      while (i < input.length && charAt(input, i) !== '"') {
        if (charAt(input, i) === "\\" && charAt(input, i + 1) === '"') {
          value += '"';
          i += 2;
        } else {
          value += charAt(input, i);
          i++;
        }
      }
      if (i >= input.length) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Unterminated string starting at position ${String(start)}`,
        );
      }
      i++; // skip closing quote
      tokens.push({
        kind: TokenKind.String,
        value,
        raw: input.slice(start, i),
        pos: start,
      });
      continue;
    }

    // Number (integer or decimal, optionally negative)
    if (ch === "-" || isDigit(ch)) {
      // Only treat '-' as number start if followed by a digit
      if (ch === "-" && !isDigit(charAt(input, i + 1))) {
        // Not a number — fall through to identifier
      } else {
        const start = i;
        if (ch === "-") i++;
        while (i < input.length && isDigit(charAt(input, i))) i++;
        if (charAt(input, i) === ".") {
          i++;
          while (i < input.length && isDigit(charAt(input, i))) i++;
        }
        const raw = input.slice(start, i);
        tokens.push({
          kind: TokenKind.Number,
          value: Number(raw),
          raw,
          pos: start,
        });
        continue;
      }
    }

    // Identifier (includes field paths like properties.author, operators, AND/OR, true/false/null)
    if (isAlpha(ch) || ch === "_") {
      const start = i;
      while (i < input.length && isIdentChar(charAt(input, i))) {
        i++;
      }
      const raw = input.slice(start, i);

      // Check for boolean/null literals
      if (raw === "true") {
        tokens.push({ kind: TokenKind.Boolean, value: true, raw, pos: start });
      } else if (raw === "false") {
        tokens.push({ kind: TokenKind.Boolean, value: false, raw, pos: start });
      } else if (raw === "null") {
        tokens.push({ kind: TokenKind.Null, value: null, raw, pos: start });
      } else {
        tokens.push({
          kind: TokenKind.Identifier,
          value: raw,
          raw,
          pos: start,
        });
      }
      continue;
    }

    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Unexpected character '${ch}' at position ${String(i)}`,
    );
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function expectToken(tokens: Token[], pos: number, context: string): Token {
  const token = tokens[pos];
  if (!token) {
    const prev = tokens[pos - 1];
    const after = prev ? ` after "${prev.raw}"` : "";
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Unexpected end of expression${after}: expected ${context}`,
    );
  }
  return token;
}

function parseFieldRef(token: Token): FieldRef {
  if (token.kind !== TokenKind.Identifier) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Expected field name at position ${String(token.pos)}, got ${token.raw}`,
    );
  }

  const name = token.value as string;

  if (name === "tags") {
    return { kind: "tags" };
  }

  if (name.startsWith("properties.")) {
    const path = name.slice("properties.".length);
    if (!path) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Missing property name after "properties." at position ${String(token.pos)}`,
      );
    }
    if (path.includes(".")) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Nested property paths are not supported in v1. Use "properties.<field>" at position ${String(token.pos)}`,
      );
    }
    if (!PROPERTY_PATH_RE.test(path)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid property name "${path}". Property names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
      );
    }
    return { kind: "property", path };
  }

  if (SYSTEM_FIELDS.has(name)) {
    return { kind: "system", column: name };
  }

  throw new MymeError(
    ErrorCode.VALIDATION_ERROR,
    `Unknown field "${name}" at position ${String(token.pos)}. ` +
      `Valid system fields: ${[...SYSTEM_FIELDS].join(", ")}. ` +
      `Use "properties.<field>" for custom fields, or "tags" for tag filtering.`,
  );
}

function parseOp(token: Token): ComparisonOp {
  if (token.kind !== TokenKind.Identifier) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Expected operator at position ${String(token.pos)}, got ${token.raw}`,
    );
  }

  const op = token.value as string;
  if (!COMPARISON_OPS.has(op as ComparisonOp)) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Unknown operator "${op}" at position ${String(token.pos)}. ` +
        `Valid operators: ${[...COMPARISON_OPS].join(", ")}`,
    );
  }

  return op as ComparisonOp;
}

function parseValue(token: Token): FilterValue {
  switch (token.kind) {
    case TokenKind.String:
    case TokenKind.Number:
    case TokenKind.Boolean:
    case TokenKind.Null:
      return token.value as FilterValue;
    default:
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Expected value at position ${String(token.pos)}, got "${token.raw}"`,
      );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a filter expression string into a structured AST.
 *
 * @throws MymeError with VALIDATION_ERROR on invalid input
 */
export function parseFilter(input: string): FilterExpression {
  if (!input || input.trim().length === 0) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "Filter expression cannot be empty",
    );
  }

  if (input.length > MAX_INPUT_LENGTH) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      `Filter expression too long (${String(input.length)} characters). Maximum is ${String(MAX_INPUT_LENGTH)}`,
    );
  }

  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "Filter expression cannot be empty",
    );
  }

  const conditions: FilterCondition[] = [];
  let logical: LogicalOp | undefined;
  let pos = 0;

  while (pos < tokens.length) {
    // Parse field
    const fieldToken = expectToken(tokens, pos, "field name");
    const field = parseFieldRef(fieldToken);
    pos++;

    // Parse operator
    const opToken = expectToken(tokens, pos, "operator");
    const op = parseOp(opToken);
    pos++;

    // Validate operator for field type
    if (field.kind === "tags" && !TAGS_ALLOWED_OPS.has(op)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Operator "${op}" is not valid for "tags". Use: ${[...TAGS_ALLOWED_OPS].join(", ")}`,
      );
    }

    if (field.kind === "system" && UNARY_OPS.has(op)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Operator "${op}" is not valid for system field "${field.column}". System fields always exist.`,
      );
    }

    // Parse value (or none for unary operators)
    let value: FilterValue = null;
    if (!UNARY_OPS.has(op)) {
      const valToken = expectToken(tokens, pos, "value");
      value = parseValue(valToken);
      pos++;
    }

    conditions.push({ field, op, value });

    if (conditions.length > MAX_CONDITIONS) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Too many conditions (${String(conditions.length)}). Maximum is ${String(MAX_CONDITIONS)}`,
      );
    }

    // Parse logical operator (or end)
    if (pos < tokens.length) {
      const logToken = expectToken(tokens, pos, "AND or OR");
      if (logToken.kind !== TokenKind.Identifier) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Expected AND or OR at position ${String(logToken.pos)}, got "${logToken.raw}"`,
        );
      }

      const logValue = logToken.value as string;
      if (logValue !== "AND" && logValue !== "OR") {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Expected AND or OR at position ${String(logToken.pos)}, got "${logValue}"`,
        );
      }

      if (logical !== undefined && logical !== logValue) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Cannot mix AND and OR in a single filter expression. ` +
            `Found "${logValue}" at position ${String(logToken.pos)} after "${logical}" used earlier. ` +
            `Use only AND or only OR.`,
        );
      }

      logical = logValue as LogicalOp;
      pos++;

      // Must have another condition after a logical operator
      if (pos >= tokens.length) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Unexpected end of expression after "${logValue}": expected another condition`,
        );
      }
    }
  }

  return {
    conditions,
    logical: logical ?? "AND",
  };
}
