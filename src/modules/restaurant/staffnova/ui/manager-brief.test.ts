import { describe, expect, it } from "vitest";
import { shouldRenderManagerBrief } from "./manager-brief";

describe("shouldRenderManagerBrief", () => {
  it.each([
    "What should the manager pay attention to right now?",
    "Give me the manager's brief",
    "Show me the executive summary",
    "What are the top priorities today?",
    "What needs my attention?",
    "What should I focus on right now?",
    "Summarize what needs attention",
  ])("gates broad management synthesis: %s", (message) => {
    expect(shouldRenderManagerBrief(message)).toBe(true);
  });

  it.each([
    "What is running low?",
    "Why did food cost increase this week?",
    "Which items need replenishment?",
    "What happened to kitchen performance today?",
    "What is the current chicken cost?",
  ])("keeps focused questions in normal presentation: %s", (message) => {
    expect(shouldRenderManagerBrief(message)).toBe(false);
  });
});
