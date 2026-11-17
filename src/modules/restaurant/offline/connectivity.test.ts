/* eslint-disable @typescript-eslint/no-explicit-any -- test-only mock payloads/results are untyped at this boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * This suite runs in vitest's default `node` environment (this repo has no
 * jsdom/happy-dom dependency, and none is warranted for a single module) —
 * `window` does not exist as a Node global. Rather than add a DOM-emulation
 * dependency, this uses Node's own native, spec-compliant `EventTarget` as
 * `window`: real `addEventListener`/`removeEventListener`/`dispatchEvent`
 * semantics, not a hand-rolled approximation of them. `navigator` already
 * exists as a Node global (a minimal built-in stub); `onLine` is not one of
 * its real properties, so it's added here the same way a browser exposes
 * it — a plain, redefinable property. Both must exist before connectivity.ts
 * is imported, since it reads them at module scope in some engines' module
 * evaluation order — hence the top-level setup before the dynamic import,
 * not a beforeAll (which would run too late).
 */
(globalThis as any).window = new EventTarget();
Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

const { browserReportsOnline, resetConnectivityForTests, subscribeConnectivity } =
  await import("./connectivity");

afterEach(() => {
  resetConnectivityForTests();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("connectivity state", () => {
  it("browserReportsOnline reflects navigator.onLine", () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    expect(browserReportsOnline()).toBe(true);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    expect(browserReportsOnline()).toBe(false);
  });

  it("fires the subscriber on a real 'offline' then 'online' transition", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConnectivity((online) => seen.push(online));

    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    window.dispatchEvent(new Event("offline"));
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    window.dispatchEvent(new Event("online"));

    expect(seen).toEqual([false, true]);
    unsubscribe();
  });

  it("flapping connectivity (rapid offline/online/offline) delivers every transition deterministically, in order — no coalescing that could hide a real drop", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConnectivity((online) => seen.push(online));

    for (const state of [false, true, false, true]) {
      Object.defineProperty(navigator, "onLine", { value: state, configurable: true });
      window.dispatchEvent(new Event(state ? "online" : "offline"));
    }

    expect(seen).toEqual([false, true, false, true]);
    unsubscribe();
  });

  it("unsubscribing stops delivering events to that listener", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConnectivity((online) => seen.push(online));
    unsubscribe();

    window.dispatchEvent(new Event("offline"));
    expect(seen).toEqual([]);
  });

  it("never attaches duplicate window listeners for multiple subscribers (P10 Phase 19)", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const unsubA = subscribeConnectivity(() => {});
    const unsubB = subscribeConnectivity(() => {});
    // Two subscribers, but the underlying window listener is attached once
    // per event type (online/offline) — not once per subscriber.
    const onlineAttachCount = addSpy.mock.calls.filter((c) => c[0] === "online").length;
    expect(onlineAttachCount).toBe(1);
    unsubA();
    unsubB();
    addSpy.mockRestore();
  });

  it("removes the underlying window listener once the last subscriber unsubscribes, and re-attaches cleanly for a later subscriber", () => {
    const seenFirst: boolean[] = [];
    const unsubFirst = subscribeConnectivity((online) => seenFirst.push(online));
    unsubFirst();

    // No listeners now — an event must not reach a stale closure.
    window.dispatchEvent(new Event("offline"));
    expect(seenFirst).toEqual([]);

    const seenSecond: boolean[] = [];
    const unsubSecond = subscribeConnectivity((online) => seenSecond.push(online));
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    window.dispatchEvent(new Event("offline"));
    expect(seenSecond).toEqual([false]);
    unsubSecond();
  });
});
