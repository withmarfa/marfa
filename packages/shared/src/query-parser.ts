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

import { ErrorCode, MarfaError } from "./errors.js";

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
  | { kind: "tags" }
  | {
      kind: "edge";
      edge_type: string;
      direction: "outbound" | "backref";
    };

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

/**
 * Longest filter expression the parser will look at.
 *
 * Exported because a caller that builds an expression from a value it did
 * not choose has to know the bound to stay inside it. Interpolating an
 * unbounded value and hoping is how a caller ends up throwing on every
 * attempt forever, and a second copy of the number is how it ends up
 * checking against the wrong one.
 */
export const MAX_FILTER_INPUT_LENGTH = 2048;
const MAX_INPUT_LENGTH = MAX_FILTER_INPUT_LENGTH;
const MAX_CONDITIONS = 10;

const SYSTEM_FIELDS = new Set([
  "state",
  "type",
  "source",
  "occurred_at",
  "created_at",
  "updated_at",
  // System fields beyond the original six. parent_id and in-thread
  // membership are carried as edges, not as generic-query-language filters;
  // use edge[<type>]= clauses for those.
  "tier",
  "version",
  "id",
  // The provenance path a client stored the item under. Filterable so a
  // prefix query can express "everything under this folder" — the path is
  // the only hierarchy the model has, since folders are not items.
  "source_id",
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

const EDGE_ALLOWED_OPS = new Set<ComparisonOp>([
  "eq",
  "neq",
  "exists",
  "not_exists",
]);

const PROPERTY_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Edge field references take the form `edge[<type>]` (outbound) or
 * `backref[<type>]` (inbound). The type segment is lax — it accepts the core
 * edge-type identifiers (`parent-of`, `in-thread`, `authored-by`, etc.) and
 * custom namespaced ones (`karakeep.list-member`).
 */
const EDGE_REF_RE = /^(edge|backref)\[([^\]\s]+)\]$/;

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
        throw new MarfaError(
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
        const value = Number(raw);
        // Enough digits read as Infinity, which no column compares to.
        if (!Number.isFinite(value)) {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Number out of range "${raw}" at position ${String(start)}`,
          );
        }
        tokens.push({
          kind: TokenKind.Number,
          value,
          raw,
          pos: start,
        });
        continue;
      }
    }

    // Edge-ref shorthand: edge[<type>] or backref[<type>] — consumed as a
    // single identifier token so parseFieldRef can detect the shape.
    if (ch === "e" || ch === "b") {
      const word = input.slice(i).split(/\s/, 1)[0] ?? "";
      const match = EDGE_REF_RE.exec(word);
      if (match) {
        const raw = match[0];
        tokens.push({
          kind: TokenKind.Identifier,
          value: raw,
          raw,
          pos: i,
        });
        i += raw.length;
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

    throw new MarfaError(
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
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Unexpected end of expression${after}: expected ${context}`,
    );
  }
  return token;
}

function parseFieldRef(token: Token): FieldRef {
  if (token.kind !== TokenKind.Identifier) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Expected field name at position ${String(token.pos)}, got ${token.raw}`,
    );
  }

  const name = token.value as string;

  const edgeMatch = EDGE_REF_RE.exec(name);
  if (edgeMatch) {
    const [, kind, edgeType] = edgeMatch;
    if (!edgeType) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Edge reference missing type at position ${String(token.pos)}`,
      );
    }
    return {
      kind: "edge",
      edge_type: edgeType,
      direction: kind === "backref" ? "backref" : "outbound",
    };
  }

  if (name === "tags") {
    return { kind: "tags" };
  }

  if (name.startsWith("properties.")) {
    const path = name.slice("properties.".length);
    if (!path) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Missing property name after "properties." at position ${String(token.pos)}`,
      );
    }
    if (path.includes(".")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Nested property paths are not supported in v1. Use "properties.<field>" at position ${String(token.pos)}`,
      );
    }
    if (!PROPERTY_PATH_RE.test(path)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid property name "${path}". Property names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
      );
    }
    return { kind: "property", path };
  }

  if (SYSTEM_FIELDS.has(name)) {
    return { kind: "system", column: name };
  }

  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Unknown field "${name}" at position ${String(token.pos)}. ` +
      `Valid system fields: ${[...SYSTEM_FIELDS].join(", ")}. ` +
      `Use "properties.<field>" for custom fields, or "tags" for tag filtering.`,
  );
}

function parseOp(token: Token): ComparisonOp {
  if (token.kind !== TokenKind.Identifier) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Expected operator at position ${String(token.pos)}, got ${token.raw}`,
    );
  }

  const op = token.value as string;
  if (!COMPARISON_OPS.has(op as ComparisonOp)) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Unknown operator "${op}" at position ${String(token.pos)}. ` +
        `Valid operators: ${[...COMPARISON_OPS].join(", ")}`,
    );
  }

  return op as ComparisonOp;
}

/**
 * A comparison with null is unknown in SQL and never matches, so the literal
 * is refused and the message names the operator that asks the question.
 */
function refuseNullComparison(
  token: Token,
  field: FieldRef,
  op: ComparisonOp,
): MarfaError {
  const never = `Null is not a value to compare with, so "${op} null" never matches at position ${String(token.pos)}.`;
  switch (field.kind) {
    case "property":
      return new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${never} Use "not_exists" to ask for a property that is absent or null, and "exists" for one that has a value`,
      );
    case "edge":
      return new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${never} Use "not_exists" to ask for rows that draw no edge of this type, and "exists" for rows that draw one`,
      );
    case "system":
      return new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${never} Compare "${field.column}" with a value`,
      );
    case "tags":
      return new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${never} Name the tag to look for`,
      );
  }
}

function parseValue(token: Token): FilterValue {
  switch (token.kind) {
    case TokenKind.String:
    case TokenKind.Number:
    case TokenKind.Boolean:
      return token.value;
    default:
      throw new MarfaError(
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
 * @throws MarfaError with VALIDATION_ERROR on invalid input
 */
export function parseFilter(input: string): FilterExpression {
  if (!input || input.trim().length === 0) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Filter expression cannot be empty",
    );
  }

  if (input.length > MAX_INPUT_LENGTH) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Filter expression too long (${String(input.length)} characters). Maximum is ${String(MAX_INPUT_LENGTH)}`,
    );
  }

  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new MarfaError(
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
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Operator "${op}" is not valid for "tags". Use: ${[...TAGS_ALLOWED_OPS].join(", ")}`,
      );
    }

    if (field.kind === "edge" && !EDGE_ALLOWED_OPS.has(op)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Operator "${op}" is not valid for edge references. Use: ${[...EDGE_ALLOWED_OPS].join(", ")}`,
      );
    }

    if (field.kind === "system" && UNARY_OPS.has(op)) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Operator "${op}" is not valid for system field "${field.column}". System fields always exist.`,
      );
    }

    // Parse value (or none for unary operators)
    let value: FilterValue = null;
    if (!UNARY_OPS.has(op)) {
      const valToken = expectToken(tokens, pos, "value");
      if (valToken.kind === TokenKind.Null) {
        throw refuseNullComparison(valToken, field, op);
      }
      value = parseValue(valToken);
      pos++;
    }

    conditions.push({ field, op, value });

    if (conditions.length > MAX_CONDITIONS) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Too many conditions (${String(conditions.length)}). Maximum is ${String(MAX_CONDITIONS)}`,
      );
    }

    // Parse logical operator (or end)
    if (pos < tokens.length) {
      const logToken = expectToken(tokens, pos, "AND or OR");
      if (logToken.kind !== TokenKind.Identifier) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Expected AND or OR at position ${String(logToken.pos)}, got "${logToken.raw}"`,
        );
      }

      const logValue = logToken.value as string;
      if (logValue !== "AND" && logValue !== "OR") {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Expected AND or OR at position ${String(logToken.pos)}, got "${logValue}"`,
        );
      }

      if (logical !== undefined && logical !== logValue) {
        throw new MarfaError(
          ErrorCode.VALIDATION_ERROR,
          `Cannot mix AND and OR in a single filter expression. ` +
            `Found "${logValue}" at position ${String(logToken.pos)} after "${logical}" used earlier. ` +
            `Use only AND or only OR.`,
        );
      }

      logical = logValue;
      pos++;

      // Must have another condition after a logical operator
      if (pos >= tokens.length) {
        throw new MarfaError(
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
