import { expect, test } from "bun:test";
import { finiteNumber, parseInstant, toUtcDateString } from "../src/lib/time";

test("parseInstant: finite number passthrough", () => {
  expect(parseInstant(1_700_000_000_000)).toBe(1_700_000_000_000);
  expect(parseInstant(0)).toBe(0);
});

test("parseInstant: ISO string parses to epoch ms", () => {
  expect(parseInstant("2026-09-19T00:00:00Z")).toBe(Date.parse("2026-09-19T00:00:00Z"));
  expect(parseInstant("2026-09-19")).toBe(Date.parse("2026-09-19"));
});

test("parseInstant: empty string, garbage, and non-finite numbers become null", () => {
  expect(parseInstant("")).toBeNull();
  expect(parseInstant("not-a-date")).toBeNull();
  expect(parseInstant(NaN)).toBeNull();
  expect(parseInstant(Infinity)).toBeNull();
  expect(parseInstant(-Infinity)).toBeNull();
  expect(parseInstant(null)).toBeNull();
  expect(parseInstant(undefined)).toBeNull();
  expect(parseInstant({})).toBeNull();
});

test("finiteNumber: only finite numbers survive", () => {
  expect(finiteNumber(42)).toBe(42);
  expect(finiteNumber(0)).toBe(0);
  expect(finiteNumber(-1.5)).toBe(-1.5);
  expect(finiteNumber(NaN)).toBeNull();
  expect(finiteNumber(Infinity)).toBeNull();
  expect(finiteNumber("42")).toBeNull();
  expect(finiteNumber(null)).toBeNull();
  expect(finiteNumber(undefined)).toBeNull();
});

test("toUtcDateString: UTC calendar date, null-safe", () => {
  expect(toUtcDateString(Date.parse("2026-09-19T00:00:00Z"))).toBe("2026-09-19");
  // Late-UTC-day instant still reports the same UTC calendar date (no local shift).
  expect(toUtcDateString(Date.parse("2026-09-19T23:59:59Z"))).toBe("2026-09-19");
  expect(toUtcDateString(null)).toBeNull();
  expect(toUtcDateString(NaN)).toBeNull();
});
