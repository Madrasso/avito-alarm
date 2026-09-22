"use strict";

const elements = {
  enabled: document.querySelector("#enabled"),
  soundId: document.querySelector("#soundId"),
  volume: document.querySelector("#volume"),
  volumeValue: document.querySelector("#volumeValue"),
  repeatInterval: document.querySelector("#repeatInterval"),
  repeatIntervalValue: document.querySelector("#repeatIntervalValue"),
  statusDot: document.querySelector("#statusDot"),
  statusTitle: document.querySelector("#statusTitle"),
  statusDetail: document.querySelector("#statusDetail"),
  testSound: document.querySelector("#testSound"),
  openMonitor: document.querySelector("#openMonitor"),
  error: document.querySelector("#error")
};

const savingTimers = {
  volume: null,
  repeatInterval: null
};

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function statusTitle(status, activeCount) {
  if (status === "disabled") return "Мониторинг выключен";
  if (status === "ok" && activeCount > 0) return `Ожидают прочтения: ${activeCount}`;
  if (status === "ok") return "Мониторинг работает";
  if (status === "loading" || status === "starting") return "Запуск мониторинга";
  if (status === "auth_required") return "Нужно войти в Авито";
  if (status === "captcha") return "Требуется проверка Авито";
  return "Страница не распознана";
}

function render(state) {
  const { settings, pageStatus, activeCount, monitorExists } = state;
  elements.enabled.checked = settings.enabled;
  elements.soundId.value = settings.soundId;
  elements.volume.value = Math.round(settings.volume * 100);
  elements.volumeValue.textContent = `${elements.volume.value}%`;
  elements.repeatInterval.value = Math.round(settings.repeatIntervalMs / 1000);
  elements.repeatIntervalValue.textContent = `${elements.repeatInterval.value} с`;
  elements.soundId.disabled = !settings.enabled;
  elements.volume.disabled = !settings.enabled;
  elements.repeatInterval.disabled = !settings.enabled;
  elements.openMonitor.disabled = !settings.enabled;

  const status = pageStatus?.status || "starting";
  elements.statusDot.className = `status-dot ${
    status === "ok" ? "ok" : status === "loading" || status === "starting" ? status : "error"
  }`;
  elements.statusTitle.textContent = statusTitle(status, activeCount);
  elements.statusDetail.textContent = monitorExists
    ? pageStatus?.detail || "Вкладка сообщений подключена"
    : settings.enabled
      ? "Создаётся закреплённая вкладка сообщений"
      : "Закреплённая вкладка не используется";
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Расширение не ответило");
  }
  return response;
}

async function loadStatus() {
  try {
    showError("");
    render(await request({ type: "GET_STATUS" }));
  } catch (error) {
    showError(error.message);
  }
}

async function saveSettings(patch) {
  try {
    showError("");
    render(await request({ type: "SET_SETTINGS", settings: patch }));
  } catch (error) {
    showError(error.message);
  }
}

elements.enabled.addEventListener("change", () => {
  saveSettings({ enabled: elements.enabled.checked });
});

elements.soundId.addEventListener("change", () => {
  saveSettings({ soundId: elements.soundId.value });
});

elements.volume.addEventListener("input", () => {
  elements.volumeValue.textContent = `${elements.volume.value}%`;
  clearTimeout(savingTimers.volume);
  savingTimers.volume = setTimeout(() => {
    saveSettings({ volume: Number(elements.volume.value) / 100 });
  }, 180);
});

elements.repeatInterval.addEventListener("input", () => {
  elements.repeatIntervalValue.textContent = `${elements.repeatInterval.value} с`;
  clearTimeout(savingTimers.repeatInterval);
  savingTimers.repeatInterval = setTimeout(() => {
    saveSettings({ repeatIntervalMs: Number(elements.repeatInterval.value) * 1000 });
  }, 180);
});

elements.testSound.addEventListener("click", async () => {
  try {
    showError("");
    await request({ type: "TEST_SOUND" });
  } catch (error) {
    showError(error.message);
  }
});

elements.openMonitor.addEventListener("click", async () => {
  try {
    showError("");
    await request({ type: "OPEN_WORK_TAB" });
    window.close();
  } catch (error) {
    showError(error.message);
  }
});

loadStatus();
