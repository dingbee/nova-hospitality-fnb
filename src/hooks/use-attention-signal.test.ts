/**
 * This codebase's convention (see use-guest-theme.test.ts) is to unit-test
 * only the pure/exported browser-boundary logic directly, in plain Node —
 * no jsdom/testing-library dependency exists here. There is no `window` or
 * `AudioContext` global in this test's environment, which is itself the
 * "unsupported" case §16/§17 of the spec calls for: these tests prove the
 * degradation path really is silent, not just that the code looks like it
 * should be.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { unlockAttentionAudio, vibrateSafely } from "./use-attention-signal";

describe("unlockAttentionAudio — audio restrictions gracefully degrade", () => {
  it("never throws when no AudioContext is available (this test's own environment)", () => {
    expect(() => unlockAttentionAudio()).not.toThrow();
  });

  it("is safe to call repeatedly (idempotent unlock attempts)", () => {
    expect(() => {
      unlockAttentionAudio();
      unlockAttentionAudio();
      unlockAttentionAudio();
    }).not.toThrow();
  });
});

describe("vibrateSafely — unsupported vibration gracefully degrades", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never throws when navigator.vibrate does not exist", () => {
    vi.stubGlobal("navigator", {});
    expect(() => vibrateSafely([40])).not.toThrow();
  });

  it("never throws when there is no navigator global at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(() => vibrateSafely(90)).not.toThrow();
  });

  it("calls navigator.vibrate with the given pattern when it IS supported", () => {
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { vibrate });
    vibrateSafely([40, 20, 40]);
    expect(vibrate).toHaveBeenCalledWith([40, 20, 40]);
  });

  it("degrades silently even if the browser's vibrate() itself throws (e.g. called outside a user gesture)", () => {
    vi.stubGlobal("navigator", {
      vibrate: () => {
        throw new Error("NotAllowedError");
      },
    });
    expect(() => vibrateSafely([40])).not.toThrow();
  });
});
