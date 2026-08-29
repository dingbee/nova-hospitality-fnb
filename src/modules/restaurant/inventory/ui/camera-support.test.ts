import { describe, expect, it } from "vitest";
import { hasCameraApi } from "./camera-support";

describe("hasCameraApi", () => {
  it("recognises a browser exposing navigator.mediaDevices.getUserMedia", () => {
    expect(hasCameraApi({ mediaDevices: { getUserMedia: () => Promise.resolve() } })).toBe(true);
  });

  it("returns false when mediaDevices is missing entirely (very old/insecure-context browsers)", () => {
    expect(hasCameraApi({})).toBe(false);
  });

  it("returns false when getUserMedia itself is missing", () => {
    expect(hasCameraApi({ mediaDevices: {} })).toBe(false);
  });

  it("returns false for undefined navigator (SSR)", () => {
    expect(hasCameraApi(undefined)).toBe(false);
  });
});
