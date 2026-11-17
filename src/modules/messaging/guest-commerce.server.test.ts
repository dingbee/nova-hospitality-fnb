import { describe, expect, it } from "vitest";
import { classifyGuestCommerceIntent } from "./guest-commerce.server";
describe("WhatsApp Guest Commerce intent classification", () => {
  it.each([
    ["MENU", "menu"],
    ["menyu", "menu"],
    ["hello", "menu"],
    ["ODA", "order"],
    ["place order", "order"],
    ["msaada", "help"],
    ["help!", "help"],
    ["JOIN", "subscribe"],
    ["START", "subscribe"],
    ["STOP", "unsubscribe"],
    ["unsubscribe", "unsubscribe"],
    ["STAFF", "handoff"],
    ["agent", "handoff"],
    ["what are your opening hours?", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
  ])("classifies %s", (input, expected) => {
    expect(classifyGuestCommerceIntent(input)).toBe(expected);
  });
});
