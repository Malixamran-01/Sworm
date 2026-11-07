import { z } from "zod";

/**
 * Rules that decide which way a workflow goes (WF-009): on an If/Switch
 * node's cases and on "Only if" connectors. They are data, evaluated the same
 * way on the server and in the editor's "Try it" box, and never run code.
 */

export const ruleOps = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "starts_with",
  "ends_with",
  "empty",
  "not_empty",
  "gt",
  "gte",
  "lt",
  "lte",
  "true",
  "false",
] as const;
export type RuleOp = (typeof ruleOps)[number];

/** Ops that compare against a value; the rest look only at the subject. */
export const opNeedsValue = (op: RuleOp) => !["empty", "not_empty", "true", "false"].includes(op);

export const OP_LABELS: Record<RuleOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "is",
  not_equals: "is not",
  starts_with: "starts with",
  ends_with: "ends with",
  empty: "is empty",
  not_empty: "is not empty",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  true: "is yes / true",
  false: "is no / false",
};

export const ruleSchema = z.object({
  /** A field of a JSON output, like "score" or "items[0].name". Empty tests the whole text. */
  field: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_.[\]-]*$/, "Fields are names joined by dots, like result.score or items[0].name.")
    .default(""),
  op: z.enum(ruleOps),
  value: z.string().max(1_000).default(""),
  ignoreCase: z.boolean().default(true),
});
export type Rule = z.infer<typeof ruleSchema>;

export const conditionSchema = z.object({
  /** all: every rule must hold. any: one is enough. */
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(ruleSchema).min(1).max(10),
});
export type Condition = z.infer<typeof conditionSchema>;

/** Read a field from text that holds JSON. Undefined when the text is not JSON or the field is missing. */
export function fieldOf(text: string, path: string): unknown {
  if (!path) return text;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const asText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** A number from a value: itself, a numeric string, or the first number in a text like "Score: 8/10". */
function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const s = asText(v).trim();
  if (s === "") return Number.NaN;
  const n = Number(s);
  if (!Number.isNaN(n)) return n;
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? Number(m[0]) : Number.NaN;
}

const YES = new Set(["true", "yes", "y", "1", "approved", "pass", "passed", "ok"]);
const NO = new Set(["false", "no", "n", "0", "rejected", "fail", "failed", ""]);

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return asText(v).trim() === "";
}

export function testRule(rule: Rule, text: string): boolean {
  const subject = fieldOf(text, rule.field);
  const fold = (s: string) => (rule.ignoreCase ? s.toLowerCase() : s);
  const a = fold(asText(subject).trim());
  const b = fold(rule.value.trim());
  switch (rule.op) {
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    case "equals":
      return a === b;
    case "not_equals":
      return a !== b;
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    case "empty":
      return isEmpty(subject);
    case "not_empty":
      return !isEmpty(subject);
    case "true":
      return typeof subject === "boolean" ? subject : YES.has(asText(subject).trim().toLowerCase().replace(/[.!]+$/, ""));
    case "false":
      return typeof subject === "boolean" ? !subject : NO.has(asText(subject).trim().toLowerCase().replace(/[.!]+$/, ""));
    default: {
      const x = asNumber(subject);
      const y = asNumber(rule.value);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      return rule.op === "gt" ? x > y : rule.op === "gte" ? x >= y : rule.op === "lt" ? x < y : x <= y;
    }
  }
}

export function testCondition(condition: Condition, text: string): boolean {
  const results = condition.rules.map((r) => testRule(r, text));
  return condition.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** A short, readable form for labels on the canvas: `contains "refund"`, `score is more than 7`. */
export function describeCondition(condition: Condition): string {
  const parts = condition.rules.map((r) => `${r.field ? `${r.field} ` : ""}${OP_LABELS[r.op]}${opNeedsValue(r.op) ? ` "${r.value}"` : ""}`);
  return parts.join(condition.match === "any" ? " or " : " and ");
}
