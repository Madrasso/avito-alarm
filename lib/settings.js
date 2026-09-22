(function exposeSettings(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AvitoAlarmSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSettings() {
  "use strict";

  const MIN_REPEAT_INTERVAL_MS = 2_000;
  const MAX_REPEAT_INTERVAL_MS = 20_000;
  const DEFAULT_REPEAT_INTERVAL_MS = 15_000;

  function normalizeRepeatIntervalMs(value, fallback = DEFAULT_REPEAT_INTERVAL_MS) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return fallback;
    }

    return Math.min(
      MAX_REPEAT_INTERVAL_MS,
      Math.max(MIN_REPEAT_INTERVAL_MS, Math.round(numericValue / 1000) * 1000)
    );
  }

  return {
    MIN_REPEAT_INTERVAL_MS,
    MAX_REPEAT_INTERVAL_MS,
    DEFAULT_REPEAT_INTERVAL_MS,
    normalizeRepeatIntervalMs
  };
});
