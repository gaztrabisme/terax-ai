import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

type Rule = {
  $ref?: string;
  $defs?: Record<string, Rule>;
  const?: unknown;
  enum?: unknown[];
  oneOf?: Rule[];
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Rule>;
  additionalProperties?: boolean;
  items?: Rule;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  exclusiveMinimum?: number;
};
export const snapshotSchema: Rule = JSON.parse(
  readFileSync("uat/schema/snapshot.json", "utf8"),
);

export function conforms(value: unknown, rule: Rule = snapshotSchema): boolean {
  if (rule.$ref)
    return conforms(
      value,
      snapshotSchema.$defs![rule.$ref.split("/").slice(-1)[0]],
    );
  if ("const" in rule && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (
    rule.oneOf &&
    rule.oneOf.filter((child) => conforms(value, child)).length !== 1
  )
    return false;
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (
      !types.some((type) =>
        type === "null"
          ? value === null
          : type === "array"
            ? Array.isArray(value)
            : type === "object"
              ? value !== null &&
                typeof value === "object" &&
                !Array.isArray(value)
              : type === "integer"
                ? Number.isInteger(value)
                : typeof value === type,
      )
    )
      return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (rule.required?.some((key) => !(key in object))) return false;
    for (const [key, child] of Object.entries(object)) {
      if (rule.properties?.[key]) {
        if (!conforms(child, rule.properties[key])) return false;
      } else if (rule.additionalProperties === false) return false;
    }
  }
  if (Array.isArray(value)) {
    if (rule.items && value.some((child) => !conforms(child, rule.items)))
      return false;
    if (
      rule.uniqueItems &&
      new Set(value.map((child) => JSON.stringify(child))).size !== value.length
    )
      return false;
  }
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (rule.minimum !== undefined && value < rule.minimum) ||
      (rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum))
  )
    return false;
  if (typeof value === "string") {
    if (
      (rule.minLength !== undefined && [...value].length < rule.minLength) ||
      (rule.maxLength !== undefined && [...value].length > rule.maxLength)
    )
      return false;
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
    if (
      rule.format === "date-time" &&
      (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      return false;
  }
  return true;
}

it("the schema rejects extra fields and unsupported versions", () => {
  expect(conforms({ v: 2 })).toBe(false);
  expect(snapshotSchema.additionalProperties).toBe(false);
  expect(snapshotSchema.$defs?.secret.required).toEqual([
    "uat",
    "scope",
    "index",
    "key",
    "secret",
  ]);
});
