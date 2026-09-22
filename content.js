(function startAvitoAlarmContentScript() {
  "use strict";

  const stateTools = globalThis.AvitoAlarmState;
  const MESSENGER_PATH = "/profile/messenger";
  const STRUCTURE_GRACE_MS = 12_000;
  const SCAN_DEBOUNCE_MS = 350;
  const startedAt = Date.now();
  const extensionAssetUrls = {
    plexRegular: chrome.runtime.getURL("assets/fonts/IBMPlexSans-Regular.ttf"),
    plexSemibold: chrome.runtime.getURL("assets/fonts/IBMPlexSans-SemiBold.ttf"),
    plexMono: chrome.runtime.getURL("assets/fonts/IBMPlexMono-Medium.ttf")
  };
  let scanTimer = null;
  let graceScanTimer = null;
  let periodicScanTimer = null;
  let mutationObserver = null;
  let lastPayload = "";
  let isMonitorTab = false;
  let monitorStatus = "loading";
  let monitorLockHost = null;
  let temporaryUnlockUntil = 0;
  let relockTimer = null;
  let disposed = false;

  if (!stateTools) {
    return;
  }

  function isInvalidatedContextError(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function blockMonitorKeyboard(event) {
    if (isMonitorTab && monitorLockHost?.dataset.mode === "locked") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function disposeInvalidatedContext() {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(scanTimer);
    clearTimeout(graceScanTimer);
    clearTimeout(relockTimer);
    clearInterval(periodicScanTimer);
    mutationObserver?.disconnect();
    window.removeEventListener("popstate", scheduleScan);
    window.removeEventListener("pageshow", scheduleScan);
    document.removeEventListener("visibilitychange", scheduleScan);
    document.removeEventListener("keydown", blockMonitorKeyboard, true);
    monitorLockHost?.remove();
    monitorLockHost = null;
    isMonitorTab = false;
  }

  function safeRuntimeMessage(message) {
    if (disposed) {
      return Promise.resolve(null);
    }

    try {
      return chrome.runtime.sendMessage(message).catch((error) => {
        if (isInvalidatedContextError(error)) {
          disposeInvalidatedContext();
          return null;
        }
        throw error;
      });
    } catch (error) {
      if (isInvalidatedContextError(error)) {
        disposeInvalidatedContext();
        return Promise.resolve(null);
      }
      return Promise.reject(error);
    }
  }

  function isMessengerPage() {
    return location.pathname.startsWith(MESSENGER_PATH);
  }

  function markerText(element) {
    if (!element) {
      return "";
    }

    const parts = [];
    for (const attribute of ["class", "data-marker", "aria-label", "title", "data-testid"]) {
      const value = element.getAttribute?.(attribute);
      if (value) {
        parts.push(value);
      }
    }
    return parts.join(" ");
  }

  function deriveChatId(link) {
    try {
      const url = new URL(link.href, location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      const messengerIndex = parts.lastIndexOf("messenger");
      const tail = messengerIndex >= 0 ? parts.slice(messengerIndex + 1) : [];

      if (tail.length > 0) {
        return decodeURIComponent(tail.join("/"));
      }

      for (const key of ["chatId", "chat_id", "channelId", "channel_id"]) {
        if (url.searchParams.has(key)) {
          return url.searchParams.get(key);
        }
      }
    } catch (_error) {
      return "";
    }

    return "";
  }

  function findRow(link) {
    const semanticRow = link.closest(
      '[data-marker*="chat" i], [data-marker*="dialog" i], [data-testid*="chat" i], [data-testid*="dialog" i], [role="listitem"], li, article'
    );
    if (semanticRow && [...semanticRow.querySelectorAll("span, div, i, svg")].some(isRedDot)) {
      return semanticRow;
    }

    let candidate = semanticRow || link;
    let parent = candidate.parentElement;
    for (let depth = 0; parent && depth < 8 && parent !== document.body; depth += 1) {
      const distinctChatIds = new Set(
        [...parent.querySelectorAll('a[href*="/profile/messenger/"], a[href*="/messenger/"]')]
          .map(deriveChatId)
          .filter(Boolean)
      );
      if (distinctChatIds.size > 1) {
        break;
      }

      const rect = parent.getBoundingClientRect();
      if (rect.height >= 38 && rect.height <= 150 && rect.width >= 280) {
        candidate = parent;
      }
      if ([...parent.querySelectorAll("span, div, i, svg")].some(isRedDot)) {
        return parent;
      }
      parent = parent.parentElement;
    }

    return candidate;
  }

  function findChatRows() {
    const links = document.querySelectorAll(
      'a[href*="/profile/messenger/"], a[href*="/messenger/"]'
    );
    const rows = new Map();

    for (const link of links) {
      const chatId = deriveChatId(link);
      if (!chatId || rows.has(chatId)) {
        continue;
      }

      const row = findRow(link);
      const text = stateTools.normalizeText(row.textContent);
      if (text) {
        rows.set(chatId, { chatId, link, row });
      }
    }

    return [...rows.values()];
  }

  function textFromSelector(row, selectors) {
    for (const selector of selectors) {
      const element = row.querySelector(selector);
      const text = stateTools.normalizeText(element?.textContent);
      if (text) {
        return text;
      }
    }
    return "";
  }

  function getTextLines(row) {
    return String(row.innerText || row.textContent || "")
      .split(/\r?\n/)
      .map(stateTools.normalizeText)
      .filter(Boolean);
  }

  function looksLikeTime(text) {
    return /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(text) ||
      /^\d{1,2}\s+(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сент|окт|нояб|дек)/i.test(text) ||
      /^(?:сегодня|вчера)$/i.test(text);
  }

  function extractName(row, lines) {
    return (
      textFromSelector(row, [
        '[data-marker*="name" i]',
        '[data-testid*="name" i]',
        '[class*="name" i]',
        '[class*="title" i]'
      ]) ||
      lines.find((line) => !looksLikeTime(line) && line.length <= 100) ||
      ""
    );
  }

  function extractTime(row, lines) {
    return (
      stateTools.normalizeText(row.querySelector("time")?.textContent) ||
      stateTools.normalizeText(row.querySelector("time")?.getAttribute("datetime")) ||
      lines.find(looksLikeTime) ||
      ""
    );
  }

  function extractPreview(row, lines, name, time) {
    const selected = textFromSelector(row, [
      '[data-marker*="preview" i]',
      '[data-marker*="message" i]',
      '[data-testid*="preview" i]',
      '[data-testid*="message" i]',
      '[class*="preview" i]'
    ]);
    if (selected && selected !== name) {
      return selected;
    }

    return (
      lines.find(
        (line) => line !== name && line !== time && !looksLikeTime(line) && line.length > 1
      ) || ""
    );
  }

  function parseColor(color) {
    const match = String(color || "").match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    return match ? match.slice(1, 4).map(Number) : null;
  }

  function isRedDot(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3 || rect.width > 24 || rect.height > 24) {
      return false;
    }

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rgb = parseColor(style.backgroundColor) || parseColor(style.fill) || parseColor(style.color);
    return Boolean(rgb && rgb[0] >= 180 && rgb[1] <= 140 && rgb[2] <= 160);
  }

  function isBoldPreview(row, preview) {
    const normalizedPreview = stateTools.normalizeText(preview);
    if (!normalizedPreview) {
      return false;
    }

    const candidates = [...row.querySelectorAll("strong, b, span, p, div")]
      .filter((element) => stateTools.normalizeText(element.textContent) === normalizedPreview)
      .sort((left, right) => left.childElementCount - right.childElementCount);

    return candidates.some((element) => {
      if (["STRONG", "B"].includes(element.tagName)) {
        return true;
      }
      const weight = getComputedStyle(element).fontWeight;
      return weight === "bold" || Number.parseInt(weight, 10) >= 600;
    });
  }

  function findUnreadCount(row, preview) {
    const explicit = row.querySelector(
      '[data-marker*="unread" i], [data-testid*="unread" i], [class*="unread" i], [aria-label*="непрочитан" i], [title*="непрочитан" i]'
    );
    const explicitText = stateTools.normalizeText(explicit?.textContent);
    const countMatch = explicitText.match(/\d+/);
    if (countMatch) {
      return Math.max(1, Number(countMatch[0]));
    }

    if (explicit) {
      return 1;
    }

    for (const element of row.querySelectorAll("span, div, i, svg")) {
      if (isRedDot(element)) {
        return 1;
      }
    }

    if (isBoldPreview(row, preview)) {
      return 1;
    }

    return 0;
  }

  function findGlobalUnreadCount() {
    let greatestCount = 0;
    const links = document.querySelectorAll(
      'a[href="/profile/messenger"], a[href="/profile/messenger/"], a[href$="/profile/messenger"]'
    );

    for (const link of links) {
      const containers = [
        link,
        link.closest('[data-marker*="messenger" i], [data-marker*="message" i], li, [role="listitem"]')
      ].filter(Boolean);

      for (const container of containers) {
        const text = stateTools.normalizeText(container.textContent);
        if (!/сообщения/i.test(text)) {
          continue;
        }
        const matches = [...text.matchAll(/(?:^|\D)(\d{1,3})(?=\D|$)/g)];
        for (const match of matches) {
          greatestCount = Math.max(greatestCount, Number(match[1]));
        }
      }
    }

    return greatestCount;
  }

  function isOutgoing(row, preview) {
    const markers = `${markerText(row)} ${[...row.querySelectorAll("[aria-label], [data-marker]")]
      .map(markerText)
      .join(" ")}`.toLowerCase();

    return /^(?:вы|you)\s*:/i.test(preview) ||
      /(?:^|[\s_-])(outgoing|sent-by-me|own-message)(?:$|[\s_-])/.test(markers);
  }

  function extractChat(candidate) {
    const { chatId, row } = candidate;
    const lines = getTextLines(row);
    const name = extractName(row, lines);
    const time = extractTime(row, lines);
    const preview = extractPreview(row, lines, name, time);
    const unreadCount = findUnreadCount(row, preview);
    const markers = `${markerText(row)} ${markerText(candidate.link)}`;

    return {
      chatId,
      name,
      preview,
      time,
      unread: unreadCount > 0,
      unreadCount,
      system: stateTools.isSystemChat(name, markers),
      outgoing: isOutgoing(row, preview)
    };
  }

  function pageHealth(rows) {
    const bodyText = stateTools.normalizeText(document.body?.innerText).toLowerCase();
    const url = location.href.toLowerCase();

    if (/captcha|challenge/.test(url) || /капч|подтвердите, что вы не робот|проверка безопасности/.test(bodyText)) {
      return { status: "captcha", detail: "Авито запросил проверку безопасности" };
    }

    if (
      /\/login|\/auth/.test(url) ||
      (/войти|вход/.test(bodyText) && /профил|аккаунт/.test(bodyText) && rows.length === 0)
    ) {
      return { status: "auth_required", detail: "Необходимо войти в профиль Авито" };
    }

    if (rows.length > 0 || /нет сообщений|пока нет сообщений|сообщений пока нет/.test(bodyText)) {
      return { status: "ok", detail: rows.length ? "Мониторинг активен" : "Список сообщений пуст" };
    }

    if (Date.now() - startedAt < STRUCTURE_GRACE_MS || document.readyState !== "complete") {
      return { status: "loading", detail: "Ожидание списка сообщений" };
    }

    return {
      status: "structure_error",
      detail: "Не удалось распознать список чатов — возможно, Авито изменил страницу"
    };
  }

  function monitorLockStyles() {
    return `
      @font-face { font-family: "Avito Alarm Plex"; src: url("${extensionAssetUrls.plexRegular}") format("truetype"); font-weight: 400; }
      @font-face { font-family: "Avito Alarm Plex"; src: url("${extensionAssetUrls.plexSemibold}") format("truetype"); font-weight: 600; }
      @font-face { font-family: "Avito Alarm Mono"; src: url("${extensionAssetUrls.plexMono}") format("truetype"); font-weight: 500; }
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        color: #f4f7fb;
        font-family: "Avito Alarm Plex", Arial, sans-serif;
        background-color: #0b1220;
        background-image:
          linear-gradient(rgba(100,216,255,.07) 1px, transparent 1px),
          linear-gradient(90deg, rgba(100,216,255,.07) 1px, transparent 1px);
        background-size: 48px 48px;
        cursor: default;
      }
      * { box-sizing: border-box; }
      .card {
        width: min(520px, calc(100vw - 48px));
        padding: 30px;
        border: 1px solid rgba(100,216,255,.3);
        border-left: 5px solid #176bff;
        border-radius: 8px;
        background: rgba(11,18,32,.96);
        box-shadow: 0 24px 80px rgba(0,0,0,.35);
      }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 30px; }
      .mark { position: relative; width: 30px; height: 28px; }
      .mark i { position: absolute; left: 4px; width: 23px; height: 8px; transform: skewX(-28deg); background: #64d8ff; }
      .mark i:nth-child(1) { top: 0; }
      .mark i:nth-child(2) { top: 10px; background: #fff; }
      .mark i:nth-child(3) { top: 20px; }
      .brand strong { font-size: 15px; font-weight: 600; }
      .brand strong span { color: #64d8ff; }
      .eyebrow { margin: 0 0 10px; color: #64d8ff; font: 500 10px "Avito Alarm Mono", Consolas, monospace; letter-spacing: .08em; }
      h1 { margin: 0; color: #fff; font-size: 30px; font-weight: 600; line-height: 1.08; letter-spacing: -.035em; }
      p { margin: 14px 0 0; color: #a9b7ca; font-size: 14px; line-height: 1.5; }
      .status { display: flex; align-items: center; gap: 8px; margin-top: 24px; padding-top: 17px; border-top: 1px solid rgba(215,224,234,.18); color: #64d8ff; font: 500 10px "Avito Alarm Mono", Consolas, monospace; }
      .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #16a36a; box-shadow: 0 0 0 4px rgba(22,163,106,.14); }
      .actions { display: flex; gap: 10px; margin-top: 24px; }
      button { min-height: 42px; padding: 0 17px; border: 1px solid #176bff; border-radius: 4px; color: #fff; background: #176bff; font: 600 13px "Avito Alarm Plex", Arial, sans-serif; cursor: pointer; }
      button.secondary { border-color: rgba(255,255,255,.38); background: transparent; }
      button:hover { filter: brightness(1.08); }
      .unlock { display: none; }
      :host([data-action-required="true"]) .unlock { display: inline-block; }
      :host([data-action-required="true"]) .status::before { background: #f0a202; box-shadow: 0 0 0 4px rgba(240,162,2,.14); }
      .banner { display: none; }
      :host([data-mode="banner"]) { place-items: start center; pointer-events: none; background: transparent; }
      :host([data-mode="banner"]) .card { display: none; }
      :host([data-mode="banner"]) .banner { display: flex; align-items: center; gap: 14px; margin-top: 18px; padding: 10px 12px 10px 16px; border: 1px solid #64d8ff; border-radius: 4px; color: #0b1220; background: #f4f7fb; box-shadow: 0 10px 35px rgba(11,18,32,.2); pointer-events: auto; font: 500 12px "Avito Alarm Plex", Arial, sans-serif; }
      :host([data-mode="banner"]) .banner button { min-height: 30px; padding: 0 11px; font-size: 11px; }
    `;
  }

  function ensureMonitorLock() {
    if (monitorLockHost?.isConnected) {
      return monitorLockHost;
    }

    monitorLockHost = document.createElement("div");
    monitorLockHost.id = "avito-alarm-monitor-lock";
    const shadow = monitorLockHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${monitorLockStyles()}</style>
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="avito-alarm-lock-title">
        <div class="brand">
          <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <strong>mdx <span>scripts</span></strong>
        </div>
        <div class="eyebrow">[ СИСТЕМА / AVITO ALARM ]</div>
        <h1 id="avito-alarm-lock-title">Служебная вкладка мониторинга</h1>
        <p class="description">Эта страница защищена от случайного открытия диалогов. Для чтения и ответа используйте отдельную рабочую вкладку.</p>
        <div class="status">МОНИТОРИНГ АКТИВЕН</div>
        <div class="actions">
          <button class="open-work" type="button">Открыть рабочую вкладку</button>
          <button class="unlock secondary" type="button">Разблокировать на 2 минуты</button>
        </div>
      </section>
      <div class="banner">
        <span>Служебная вкладка временно разблокирована</span>
        <button class="lock-now" type="button">Заблокировать</button>
      </div>
    `;

    shadow.querySelector(".open-work").addEventListener("click", () => {
      safeRuntimeMessage({ type: "OPEN_WORK_TAB" }).catch(() => {});
    });
    shadow.querySelector(".unlock").addEventListener("click", () => {
      temporaryUnlockUntil = Date.now() + 120_000;
      updateMonitorGuard(monitorStatus);
    });
    shadow.querySelector(".lock-now").addEventListener("click", () => {
      temporaryUnlockUntil = 0;
      updateMonitorGuard(monitorStatus);
    });

    document.documentElement.append(monitorLockHost);
    return monitorLockHost;
  }

  function updateMonitorGuard(status) {
    if (!isMonitorTab) {
      monitorLockHost?.remove();
      monitorLockHost = null;
      return;
    }

    monitorStatus = status || monitorStatus;
    const actionRequired = ["auth_required", "captcha"].includes(monitorStatus);
    if (!actionRequired) {
      temporaryUnlockUntil = 0;
    }

    const host = ensureMonitorLock();
    const temporarilyUnlocked = actionRequired && temporaryUnlockUntil > Date.now();
    host.dataset.mode = temporarilyUnlocked ? "banner" : "locked";
    host.dataset.actionRequired = String(actionRequired);

    const shadow = host.shadowRoot;
    shadow.querySelector("h1").textContent = actionRequired
      ? "Требуется действие на Авито"
      : "Служебная вкладка мониторинга";
    shadow.querySelector(".description").textContent = actionRequired
      ? "Откройте рабочую вкладку или временно разблокируйте эту страницу, чтобы завершить вход или проверку безопасности."
      : "Эта страница защищена от случайного открытия диалогов. Для чтения и ответа используйте отдельную рабочую вкладку.";
    shadow.querySelector(".status").textContent = actionRequired
      ? "АВТОРИЗАЦИЯ ИЛИ ПРОВЕРКА"
      : "МОНИТОРИНГ АКТИВЕН";

    clearTimeout(relockTimer);
    if (temporarilyUnlocked) {
      relockTimer = setTimeout(() => {
        temporaryUnlockUntil = 0;
        updateMonitorGuard(monitorStatus);
      }, temporaryUnlockUntil - Date.now());
    }
  }

  function acceptTabRole(response, status) {
    if (!response?.ok) {
      return;
    }
    isMonitorTab = Boolean(response.isMonitor);
    updateMonitorGuard(status || response.pageStatus?.status || "loading");
  }

  function sendPageState(payload) {
    const serialized = JSON.stringify(payload);
    if (serialized === lastPayload) {
      return;
    }
    lastPayload = serialized;

    safeRuntimeMessage({ type: "PAGE_STATE", payload })
      .then((response) => acceptTabRole(response, payload.status))
      .catch(() => {
        // Расширение могло быть перезагружено во время работы страницы.
      });
  }

  function scan() {
    scanTimer = null;
    if (disposed || !isMessengerPage()) {
      return;
    }

    const rows = findChatRows();
    const health = pageHealth(rows);
    const chats = health.status === "ok" ? rows.map(extractChat) : [];
    const globalUnreadCount = findGlobalUnreadCount();
    const detectedUnreadChats = chats.filter((chat) => chat.unread).length;
    let missingUnreadChats = Math.max(0, globalUnreadCount - detectedUnreadChats);
    if (missingUnreadChats > 0) {
      const fallbackChats = chats.filter(
        (chat) => !chat.unread && !chat.system && !chat.outgoing
      );
      for (const fallbackChat of fallbackChats) {
        if (missingUnreadChats <= 0) {
          break;
        }
        fallbackChat.unread = true;
        fallbackChat.unreadCount = 1;
        missingUnreadChats -= 1;
      }
    }

    sendPageState({
      ...health,
      url: location.href,
      observedAt: Date.now(),
      chats
    });
  }

  function scheduleScan() {
    if (disposed || !isMessengerPage() || scanTimer) {
      return;
    }
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  mutationObserver = new MutationObserver(scheduleScan);
  mutationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "aria-label", "data-marker", "data-testid", "title"]
  });

  window.addEventListener("popstate", scheduleScan);
  window.addEventListener("pageshow", scheduleScan);
  document.addEventListener("visibilitychange", scheduleScan);
  document.addEventListener("keydown", blockMonitorKeyboard, true);

  safeRuntimeMessage({ type: "GET_TAB_ROLE" })
    .then((response) => acceptTabRole(response))
    .catch(() => {});
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING_CONTENT") {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    }
    if (message?.type === "SET_MONITOR_ROLE") {
      isMonitorTab = Boolean(message.isMonitor);
      updateMonitorGuard(monitorStatus);
    }
    return false;
  });
  scheduleScan();

  graceScanTimer = setTimeout(scheduleScan, STRUCTURE_GRACE_MS + 250);
  periodicScanTimer = setInterval(scheduleScan, 10_000);
})();
