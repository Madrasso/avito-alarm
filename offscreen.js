"use strict";

let audioContext = null;
let repeatTimer = null;
let loopSettings = null;

const SOUND_PATTERNS = {
  chime: [
    { frequency: 740, offset: 0, duration: 0.14, gain: 0.65 },
    { frequency: 988, offset: 0.13, duration: 0.25, gain: 0.55 }
  ],
  double: [
    { frequency: 880, offset: 0, duration: 0.12, gain: 0.65 },
    { frequency: 880, offset: 0.23, duration: 0.12, gain: 0.65 }
  ],
  alert: [
    { frequency: 660, offset: 0, duration: 0.16, gain: 0.65 },
    { frequency: 520, offset: 0.17, duration: 0.16, gain: 0.65 },
    { frequency: 660, offset: 0.34, duration: 0.22, gain: 0.7 }
  ]
};

function normalizedSettings(settings) {
  const repeatIntervalMs = Number(settings?.repeatIntervalMs);
  return {
    soundId: SOUND_PATTERNS[settings?.soundId] ? settings.soundId : "chime",
    volume: Math.min(1, Math.max(0, Number(settings?.volume ?? 0.75))),
    repeatIntervalMs: globalThis.AvitoAlarmSettings.normalizeRepeatIntervalMs(repeatIntervalMs)
  };
}

async function getAudioContext() {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  return audioContext;
}

async function playPattern(settings) {
  const normalized = normalizedSettings(settings);
  if (normalized.volume <= 0) {
    return;
  }

  const context = await getAudioContext();
  const startAt = context.currentTime + 0.02;

  for (const note of SOUND_PATTERNS[normalized.soundId]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = startAt + note.offset;
    const noteEnd = noteStart + note.duration;

    oscillator.type = normalized.soundId === "alert" ? "square" : "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, normalized.volume * note.gain),
      noteStart + 0.015
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.02);
  }
}

function stopLoop() {
  if (repeatTimer) {
    clearInterval(repeatTimer);
    repeatTimer = null;
  }
  loopSettings = null;
}

async function startLoop(settings, immediate) {
  const normalized = normalizedSettings(settings);
  const changed = JSON.stringify(normalized) !== JSON.stringify(loopSettings);
  loopSettings = normalized;

  if (changed || !repeatTimer) {
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }
    repeatTimer = setInterval(() => {
      playPattern(loopSettings).catch(console.error);
    }, normalized.repeatIntervalMs);
  }

  if (immediate) {
    await playPattern(normalized);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") {
    return;
  }

  switch (message.type) {
    case "PLAY_SOUND":
      startLoop(message.settings, Boolean(message.immediate)).catch(console.error);
      break;
    case "STOP_SOUND":
      stopLoop();
      break;
    case "TEST_SOUND":
      playPattern(message.settings).catch(console.error);
      break;
    default:
      break;
  }
});
