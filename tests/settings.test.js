"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_REPEAT_INTERVAL_MS,
  MAX_REPEAT_INTERVAL_MS,
  DEFAULT_REPEAT_INTERVAL_MS,
  normalizeRepeatIntervalMs
} = require("../lib/settings.js");

test("repeat interval accepts whole seconds from 2 to 20", () => {
  assert.equal(normalizeRepeatIntervalMs(2_000), MIN_REPEAT_INTERVAL_MS);
  assert.equal(normalizeRepeatIntervalMs(11_000), 11_000);
  assert.equal(normalizeRepeatIntervalMs(20_000), MAX_REPEAT_INTERVAL_MS);
});

test("repeat interval is clamped to configured limits", () => {
  assert.equal(normalizeRepeatIntervalMs(500), MIN_REPEAT_INTERVAL_MS);
  assert.equal(normalizeRepeatIntervalMs(60_000), MAX_REPEAT_INTERVAL_MS);
});

test("repeat interval rounds to full seconds and falls back safely", () => {
  assert.equal(normalizeRepeatIntervalMs(7_600), 8_000);
  assert.equal(normalizeRepeatIntervalMs("invalid"), DEFAULT_REPEAT_INTERVAL_MS);
  assert.equal(normalizeRepeatIntervalMs(undefined, 9_000), 9_000);
});
