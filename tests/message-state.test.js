"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeText,
  isSystemChat,
  createFingerprint,
  reconcileState
} = require("../lib/message-state.js");

function chat(overrides = {}) {
  return {
    chatId: "chat-1",
    name: "Иван",
    preview: "Здравствуйте",
    time: "12:18",
    unread: true,
    unreadCount: 1,
    system: false,
    outgoing: false,
    ...overrides
  };
}

test("normalizeText collapses whitespace", () => {
  assert.equal(normalizeText("  Новое\u00a0  сообщение\n"), "Новое сообщение");
});

test("system chats are recognized by name and markers", () => {
  assert.equal(isSystemChat("Поддержка Авито", ""), true);
  assert.equal(isSystemChat("Иван", "chat system-notification"), true);
  assert.equal(isSystemChat("Иван", "ordinary-chat"), false);
});

test("fingerprint tracks preview, time and unread count", () => {
  const first = createFingerprint(chat());
  assert.notEqual(first, createFingerprint(chat({ preview: "Другой текст" })));
  assert.notEqual(first, createFingerprint(chat({ unreadCount: 2 })));
});

test("first scan activates reminders for existing unread chats", () => {
  const result = reconcileState({}, [chat()]);
  assert.equal(result.initialized, true);
  assert.equal(result.newMessages.length, 1);
  assert.ok(result.active["chat-1"]);
});

test("new unread chat activates an alert after baseline", () => {
  const baseline = reconcileState({}, []);
  const result = reconcileState(baseline, [chat()]);
  assert.equal(result.newMessages.length, 1);
  assert.ok(result.active["chat-1"]);
});

test("unchanged unread chat stays active without duplicate event", () => {
  const baseline = reconcileState({}, [chat()]);
  const result = reconcileState(baseline, [chat()]);
  assert.equal(result.newMessages.length, 0);
  assert.ok(result.active["chat-1"]);
});

test("active unread chat remains active without duplicate event", () => {
  const baseline = reconcileState({}, []);
  const activated = reconcileState(baseline, [chat()]);
  const result = reconcileState(activated, [chat()]);
  assert.equal(result.newMessages.length, 0);
  assert.ok(result.active["chat-1"]);
});

test("changed message in active chat produces another event", () => {
  const baseline = reconcileState({}, []);
  const activated = reconcileState(baseline, [chat()]);
  const result = reconcileState(activated, [chat({ preview: "Вы здесь?", time: "12:19" })]);
  assert.equal(result.newMessages.length, 1);
  assert.ok(result.active["chat-1"]);
});

test("reading a chat removes its active reminder", () => {
  const baseline = reconcileState({}, []);
  const activated = reconcileState(baseline, [chat()]);
  const result = reconcileState(activated, [chat({ unread: false, unreadCount: 0 })]);
  assert.deepEqual(result.active, {});
  assert.deepEqual(result.readChatIds, ["chat-1"]);
});

test("system and outgoing messages never activate", () => {
  const baseline = reconcileState({}, []);
  const result = reconcileState(baseline, [
    chat({ chatId: "system", system: true }),
    chat({ chatId: "outgoing", outgoing: true })
  ]);
  assert.deepEqual(result.newMessages, []);
  assert.deepEqual(result.active, {});
});
