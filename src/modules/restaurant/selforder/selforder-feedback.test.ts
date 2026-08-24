import { describe, expect, it } from "vitest";
import { classifyFeedbackRouting } from "./selforder-feedback";

describe("classifyFeedbackRouting", () => {
  it("1-2 stars routes to service recovery", () => {
    expect(classifyFeedbackRouting(1)).toBe("service_recovery");
    expect(classifyFeedbackRouting(2)).toBe("service_recovery");
  });

  it("3 stars routes to a plain thank-you", () => {
    expect(classifyFeedbackRouting(3)).toBe("thanks");
  });

  it("4-5 stars routes to advocacy-ready (no external link is ever produced here)", () => {
    expect(classifyFeedbackRouting(4)).toBe("advocacy_ready");
    expect(classifyFeedbackRouting(5)).toBe("advocacy_ready");
  });
});
