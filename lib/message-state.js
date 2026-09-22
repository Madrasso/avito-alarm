(function exposeMessageState(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.AvitoAlarmState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createMessageState() {
  "use strict";

  const SYSTEM_NAMES = [
    /^авито$/i,
    /^поддержка авито$/i,
    /^avito$/i,
    /^avito support$/i,
    /^служба поддержки(?: авито)?$/i
  ];

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSystemChat(name, markerText) {
    const normalizedName = normalizeText(name);
    const normalizedMarkers = normalizeText(markerText).toLowerCase();

    return (
      SYSTEM_NAMES.some((pattern) => pattern.test(normalizedName)) ||
      /(?:support|system|promo)[_-](?:chat|notification)|avito[_-]notification/.test(
        normalizedMarkers
      )
    );
  }

  function createFingerprint(chat) {
    return [
      normalizeText(chat.chatId),
      normalizeText(chat.preview),
      normalizeText(chat.time),
      Number.isFinite(Number(chat.unreadCount)) ? Number(chat.unreadCount) : 0
    ].join("|");
  }

  function isEligible(chat) {
    return Boolean(
      chat &&
        chat.chatId &&
        chat.unread &&
        !chat.system &&
        !chat.outgoing
    );
  }

  function pruneFingerprints(fingerprints, maxEntries) {
    const entries = Object.entries(fingerprints);
    if (entries.length <= maxEntries) {
      return fingerprints;
    }

    return Object.fromEntries(entries.slice(entries.length - maxEntries));
  }

  function reconcileState(previousState, chats, maxFingerprints = 500) {
    const previous = previousState || {};
    const initialized = Boolean(previous.initialized);
    const previousFingerprints = { ...(previous.fingerprints || {}) };
    const previousActive = previous.active || {};
    const nextActive = {};
    const newMessages = [];
    const currentChats = Array.isArray(chats) ? chats : [];

    for (const chat of currentChats) {
      if (!chat || !chat.chatId) {
        continue;
      }

      const fingerprint = createFingerprint(chat);
      const oldFingerprint = previousFingerprints[chat.chatId];
      previousFingerprints[chat.chatId] = fingerprint;

      if (!isEligible(chat)) {
        continue;
      }

      if (!initialized) {
        nextActive[chat.chatId] = fingerprint;
        newMessages.push(chat);
        continue;
      }

      if (previousActive[chat.chatId]) {
        nextActive[chat.chatId] = fingerprint;

        if (oldFingerprint !== fingerprint) {
          newMessages.push(chat);
        }
        continue;
      }

      if (oldFingerprint !== fingerprint) {
        nextActive[chat.chatId] = fingerprint;
        newMessages.push(chat);
      }
    }

    return {
      initialized: true,
      fingerprints: pruneFingerprints(previousFingerprints, maxFingerprints),
      active: nextActive,
      newMessages,
      readChatIds: Object.keys(previousActive).filter((chatId) => !nextActive[chatId])
    };
  }

  return {
    normalizeText,
    isSystemChat,
    createFingerprint,
    isEligible,
    reconcileState
  };
});
