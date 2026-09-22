"use strict";

importScripts("lib/message-state.js", "lib/settings.js");

const MESSENGER_URL = "https://www.avito.ru/profile/messenger";
const MESSENGER_PATTERN = "https://www.avito.ru/profile/messenger*";
const OFFSCREEN_URL = "offscreen.html";
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  soundId: "chime",
  volume: 0.75,
  repeatIntervalMs: 15_000
});

let monitorPromise = null;
let offscreenPromise = null;
let redirectingMonitorActivation = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTabEditError(error) {
  return /tabs cannot be edited right now|user may be dragging a tab/i.test(
    String(error?.message || error || "")
  );
}

async function withTabEditRetry(operation, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientTabEditError(error) || attempt === attempts - 1) {
        throw error;
      }
      await delay(250 * (attempt + 1));
    }
  }
  return null;
}

function updateTab(tabId, updateProperties) {
  return withTabEditRetry(() => chrome.tabs.update(tabId, updateProperties));
}

function createTab(createProperties) {
  return withTabEditRetry(() => chrome.tabs.create(createProperties));
}

function removeTab(tabId) {
  return withTabEditRetry(() => chrome.tabs.remove(tabId));
}

function reportBackgroundError(context, error) {
  if (!isTransientTabEditError(error)) {
    console.error(`Avito Alarm ${context}:`, error);
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const storedRepeatInterval = Number(stored.repeatIntervalMs);
  return {
    enabled: Boolean(stored.enabled),
    soundId: ["chime", "double", "alert"].includes(stored.soundId)
      ? stored.soundId
      : DEFAULT_SETTINGS.soundId,
    volume: Math.min(1, Math.max(0, Number(stored.volume))),
    repeatIntervalMs: globalThis.AvitoAlarmSettings.normalizeRepeatIntervalMs(
      storedRepeatInterval,
      DEFAULT_SETTINGS.repeatIntervalMs
    )
  };
}

async function getSession() {
  const data = await chrome.storage.session.get({
    monitor: null,
    pageStatus: {
      status: "starting",
      detail: "Запуск мониторинга",
      observedAt: 0
    },
    messageState: {
      initialized: false,
      fingerprints: {},
      active: {}
    }
  });
  return data;
}

async function setBadge(status, activeCount = 0) {
  let text = "";
  let color = "#64748b";
  let title = "Avito Alarm";

  if (status === "disabled") {
    text = "OFF";
    title = "Avito Alarm выключен";
  } else if (activeCount > 0) {
    text = String(Math.min(activeCount, 99));
    color = "#e11933";
    title = `Непрочитанных чатов: ${activeCount}`;
  } else if (status === "ok") {
    text = "ON";
    color = "#16a34a";
    title = "Avito Alarm работает";
  } else if (status === "loading" || status === "starting") {
    text = "…";
    color = "#2563eb";
    title = "Avito Alarm запускается";
  } else {
    text = "!";
    color = "#ea580c";
    title = "Avito Alarm требует внимания";
  }

  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

async function tabExists(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (_error) {
    return false;
  }
}

async function ensureMonitorTab() {
  if (monitorPromise) {
    return monitorPromise;
  }

  monitorPromise = (async () => {
    const settings = await getSettings();
    if (!settings.enabled) {
      return null;
    }

    const { monitor } = await getSession();
    if (monitor && (await tabExists(monitor.tabId))) {
      const tab = await chrome.tabs.get(monitor.tabId);
      if (!tab.pinned) {
        await updateTab(tab.id, { pinned: true });
      }
      return tab;
    }

    const existing = await chrome.tabs.query({ url: MESSENGER_PATTERN });
    if (existing.length > 0) {
      const tab = existing[0];
      await updateTab(tab.id, { pinned: true });
      await chrome.storage.session.set({
        monitor: {
          tabId: tab.id,
          createdByExtension: false,
          originalPinned: Boolean(tab.pinned)
        }
      });
      return tab;
    }

    const tab = await createTab({
      url: MESSENGER_URL,
      active: false,
      pinned: true
    });
    await chrome.storage.session.set({
      monitor: {
        tabId: tab.id,
        createdByExtension: true,
        originalPinned: false
      },
      pageStatus: {
        status: "loading",
        detail: "Открывается страница сообщений",
        observedAt: Date.now()
      }
    });
    return tab;
  })().finally(() => {
    monitorPromise = null;
  });

  return monitorPromise;
}

async function releaseMonitorTab() {
  const { monitor } = await getSession();
  if (monitor && (await tabExists(monitor.tabId))) {
    chrome.tabs.sendMessage(monitor.tabId, {
      type: "SET_MONITOR_ROLE",
      isMonitor: false
    }).catch(() => {});
  }
  await chrome.storage.session.set({ monitor: null });

  if (!monitor || !(await tabExists(monitor.tabId))) {
    return;
  }

  if (monitor.createdByExtension) {
    await removeTab(monitor.tabId);
  } else if (!monitor.originalPinned) {
    await updateTab(monitor.tabId, { pinned: false });
  }
}

function isCanonicalMessengerUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://www.avito.ru" &&
      /^\/profile\/messenger\/?$/.test(parsed.pathname) &&
      !parsed.search &&
      !parsed.hash
    );
  } catch (_error) {
    return false;
  }
}

async function openWorkTab(preferredWindowId) {
  const { monitor } = await getSession();
  const existing = (await chrome.tabs.query({ url: MESSENGER_PATTERN }))
    .filter((tab) => tab.id !== monitor?.tabId)
    .sort((left, right) => {
      const leftPreferred = left.windowId === preferredWindowId ? 1 : 0;
      const rightPreferred = right.windowId === preferredWindowId ? 1 : 0;
      return rightPreferred - leftPreferred;
    });

  if (existing.length > 0) {
    const tab = await updateTab(existing[0].id, { active: true });
    if (Number.isInteger(tab.windowId)) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return tab;
  }

  return createTab({
    url: MESSENGER_URL,
    active: true,
    pinned: false,
    ...(Number.isInteger(preferredWindowId) ? { windowId: preferredWindowId } : {})
  });
}

async function ensureFreshMonitorContent(tabId) {
  if (!Number.isInteger(tabId) || !(await tabExists(tabId))) {
    return;
  }

  await delay(750);
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING_CONTENT" });
    if (response?.ok && response.version === chrome.runtime.getManifest().version) {
      return;
    }
  } catch (_error) {
    // После перезагрузки расширения в открытой странице остаётся старый content script.
  }

  if (await tabExists(tabId)) {
    await chrome.tabs.reload(tabId);
  }
}

async function ensureOffscreenDocument() {
  if (offscreenPromise) {
    return offscreenPromise;
  }

  offscreenPromise = (async () => {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Проигрывание выбранного пользователем сигнала о новом сообщении Авито"
      });
    }
  })().finally(() => {
    offscreenPromise = null;
  });

  return offscreenPromise;
}

async function sendAudioMessage(type, extra = {}) {
  if (type !== "STOP_SOUND") {
    await ensureOffscreenDocument();
  }

  try {
    await chrome.runtime.sendMessage({ type, target: "offscreen", ...extra });
  } catch (error) {
    if (type !== "STOP_SOUND") {
      throw error;
    }
  }
}

async function stopSound() {
  await sendAudioMessage("STOP_SOUND");
}

function sanitizedPageState(payload) {
  const allowedStatuses = new Set([
    "ok",
    "loading",
    "auth_required",
    "captcha",
    "structure_error"
  ]);
  return {
    status: allowedStatuses.has(payload?.status) ? payload.status : "structure_error",
    detail: String(payload?.detail || "Неизвестное состояние страницы").slice(0, 240),
    observedAt: Number(payload?.observedAt) || Date.now(),
    url: String(payload?.url || "").slice(0, 500)
  };
}

async function handlePageState(message, sender) {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { isMonitor: false };
  }

  const session = await getSession();
  if (!sender.tab || sender.tab.id !== session.monitor?.tabId) {
    if (
      sender.tab &&
      message.payload?.status === "ok" &&
      ["auth_required", "captcha"].includes(session.pageStatus?.status) &&
      (await tabExists(session.monitor?.tabId))
    ) {
      await updateTab(session.monitor.tabId, { url: MESSENGER_URL, pinned: true });
    }
    return { isMonitor: false };
  }

  const pageStatus = sanitizedPageState(message.payload);
  await chrome.storage.session.set({ pageStatus });

  if (pageStatus.status !== "ok") {
    await stopSound();
    await setBadge(pageStatus.status, 0);
    return { isMonitor: true, pageStatus };
  }

  const chats = Array.isArray(message.payload?.chats) ? message.payload.chats : [];
  const nextState = globalThis.AvitoAlarmState.reconcileState(session.messageState, chats);

  await chrome.storage.session.set({
    messageState: {
      initialized: nextState.initialized,
      fingerprints: nextState.fingerprints,
      active: nextState.active
    }
  });

  const activeCount = Object.keys(nextState.active).length;
  await setBadge("ok", activeCount);

  if (nextState.readChatIds.length > 0) {
    chrome.runtime.sendMessage({
      type: "READ_STATE_CHANGED",
      chatIds: nextState.readChatIds
    }).catch(() => {});
  }

  if (nextState.newMessages.length > 0) {
    chrome.runtime.sendMessage({
      type: "NEW_MESSAGE",
      chatIds: nextState.newMessages.map((chat) => chat.chatId)
    }).catch(() => {});
  }

  if (activeCount === 0) {
    await stopSound();
  } else {
    await sendAudioMessage("PLAY_SOUND", {
      settings,
      immediate: nextState.newMessages.length > 0
    });
  }
  return { isMonitor: true, pageStatus };
}

async function getPublicStatus() {
  const [settings, session] = await Promise.all([getSettings(), getSession()]);
  const monitorExists = await tabExists(session.monitor?.tabId);
  return {
    settings,
    monitorExists,
    monitorTabId: monitorExists ? session.monitor.tabId : null,
    pageStatus: settings.enabled
      ? session.pageStatus
      : { status: "disabled", detail: "Мониторинг выключен", observedAt: Date.now() },
    activeCount: Object.keys(session.messageState?.active || {}).length
  };
}

async function updateSettings(patch) {
  const current = await getSettings();
  const requestedRepeatInterval = Number(patch.repeatIntervalMs);
  const next = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    soundId: ["chime", "double", "alert"].includes(patch.soundId)
      ? patch.soundId
      : current.soundId,
    volume: Number.isFinite(Number(patch.volume))
      ? Math.min(1, Math.max(0, Number(patch.volume)))
      : current.volume,
    repeatIntervalMs: globalThis.AvitoAlarmSettings.normalizeRepeatIntervalMs(
      requestedRepeatInterval,
      current.repeatIntervalMs
    )
  };
  await chrome.storage.local.set(next);

  if (!next.enabled) {
    await stopSound();
    await setBadge("disabled", 0);
    await releaseMonitorTab();
  } else {
    await ensureMonitorTab();
    const { messageState, pageStatus } = await getSession();
    const activeCount = Object.keys(messageState.active || {}).length;
    await setBadge(pageStatus.status, activeCount);
    if (activeCount > 0 && pageStatus.status === "ok") {
      await sendAudioMessage("PLAY_SOUND", { settings: next, immediate: false });
    }
  }
  return getPublicStatus();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  const task = (async () => {
    switch (message?.type) {
      case "PAGE_STATE":
        return { ok: true, ...(await handlePageState(message, sender)) };
      case "GET_TAB_ROLE": {
        const settings = await getSettings();
        const { monitor, pageStatus } = await getSession();
        return {
          ok: true,
          isMonitor: Boolean(settings.enabled && sender.tab?.id === monitor?.tabId),
          pageStatus
        };
      }
      case "GET_STATUS":
        return { ok: true, ...(await getPublicStatus()) };
      case "SET_SETTINGS":
        return { ok: true, ...(await updateSettings(message.settings || {})) };
      case "TEST_SOUND": {
        const settings = await getSettings();
        await sendAudioMessage("TEST_SOUND", { settings });
        return { ok: true };
      }
      case "OPEN_MONITOR":
      case "OPEN_WORK_TAB": {
        const tab = await openWorkTab(sender.tab?.windowId);
        return { ok: true, tabId: tab?.id };
      }
      default:
        return { ok: false, error: "UNKNOWN_MESSAGE" };
    }
  })();

  task.then(sendResponse).catch((error) => {
    console.error("Avito Alarm:", error);
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

async function handleInstalled({ reason }) {
  const stored = await chrome.storage.local.get(null);
  if (Object.keys(stored).length === 0) {
    await chrome.storage.local.set(DEFAULT_SETTINGS);
  }
  await chrome.storage.session.set({
    messageState: { initialized: false, fingerprints: {}, active: {} }
  });
  const settings = await getSettings();
  if (settings.enabled) {
    await setBadge("starting", 0);
    const tab = await ensureMonitorTab();
    if (reason === "update" && tab?.id) {
      await chrome.tabs.reload(tab.id);
    }
  } else {
    await setBadge("disabled", 0);
  }
}

async function handleStartup() {
  await chrome.storage.session.set({
    messageState: { initialized: false, fingerprints: {}, active: {} },
    monitor: null
  });
  const settings = await getSettings();
  if (settings.enabled) {
    await setBadge("starting", 0);
    await ensureMonitorTab();
  } else {
    await setBadge("disabled", 0);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details).catch((error) => reportBackgroundError("install", error));
});

chrome.runtime.onStartup.addListener(() => {
  handleStartup().catch((error) => reportBackgroundError("browser startup", error));
});

async function handleTabRemoved(tabId) {
  const { monitor } = await getSession();
  if (monitor?.tabId !== tabId) {
    return;
  }
  await chrome.storage.session.set({
    monitor: null,
    pageStatus: {
      status: "loading",
      detail: "Восстановление вкладки мониторинга",
      observedAt: Date.now()
    }
  });
  const settings = await getSettings();
  if (settings.enabled) {
    await stopSound();
    await setBadge("loading", 0);
    await ensureMonitorTab();
  }
}

async function handleTabUpdated(tabId, changeInfo) {
  if (!changeInfo.url) {
    return;
  }
  const { monitor, pageStatus } = await getSession();
  if (!monitor) {
    return;
  }
  const settings = await getSettings();
  if (!settings.enabled) {
    return;
  }

  if (monitor.tabId !== tabId) {
    if (changeInfo.url.startsWith(MESSENGER_URL) &&
        ["auth_required", "captcha"].includes(pageStatus?.status) &&
        (await tabExists(monitor.tabId))) {
      await updateTab(monitor.tabId, { url: MESSENGER_URL, pinned: true });
    }
    return;
  }

  if (!isCanonicalMessengerUrl(changeInfo.url)) {
    const authPage = /(?:login|auth|captcha|challenge)/i.test(changeInfo.url);
    if (!authPage) {
      await updateTab(tabId, { url: MESSENGER_URL, pinned: true });
      return;
    }
    const pageStatus = {
      status: authPage ? "auth_required" : "structure_error",
      detail: authPage
        ? "Завершите вход в Авито, затем откройте страницу сообщений"
        : "Вкладка мониторинга покинула страницу сообщений",
      observedAt: Date.now(),
      url: changeInfo.url.slice(0, 500)
    };
    await chrome.storage.session.set({ pageStatus });
    await stopSound();
    await setBadge(pageStatus.status, 0);
  }
}

async function handleTabActivated({ tabId, windowId }) {
  if (redirectingMonitorActivation) {
    return;
  }

  const [settings, { monitor, pageStatus }] = await Promise.all([getSettings(), getSession()]);
  if (!settings.enabled || monitor?.tabId !== tabId) {
    return;
  }

  if (["auth_required", "captcha"].includes(pageStatus?.status)) {
    return;
  }

  redirectingMonitorActivation = true;
  try {
    await openWorkTab(windowId);
  } finally {
    redirectingMonitorActivation = false;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch((error) => reportBackgroundError("tab removed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  handleTabUpdated(tabId, changeInfo).catch((error) => reportBackgroundError("tab updated", error));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivated(activeInfo).catch((error) => reportBackgroundError("tab activated", error));
});

getSettings().then(async (settings) => {
  if (settings.enabled) {
    await setBadge("starting", 0);
    const tab = await ensureMonitorTab();
    await ensureFreshMonitorContent(tab?.id);
  } else {
    await setBadge("disabled", 0);
  }
}).catch((error) => console.error("Avito Alarm startup:", error));
