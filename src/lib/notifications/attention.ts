/**
 * Pure logic for the staff/guest "attention" affordance layer — no DOM, no
 * WebAudio, no localStorage, so every rule here is exercised directly in
 * tests. See use-attention-signal.ts for the browser-touching half (audio
 * unlock, actual playback, vibration, mute persistence) that wraps this.
 *
 * The core rule this module exists to get right: an item (a service
 * request, a bill asked for, an order with unsent items) pings ONCE per
 * transition into "active", never once per poll while it stays active, and
 * never at all for whatever was already active the moment the screen first
 * loaded (opening the POS must never sound like every outstanding alert
 * just happened right now).
 */

/**
 * Diffs the currently-active key set against what was already known.
 * `hasBaseline: false` means "this is the very first observation" — every
 * key in `current` is recorded as known but none are reported as newly
 * active, exactly the "don't alert for pre-existing state on load" rule
 * above. Once a key drops out of `current` it is forgotten, so if it
 * becomes active again later it is treated as a genuinely new event and
 * pings again — that re-arming is deliberate, not a bug: "resolved, then
 * requested again" is a real second event.
 */
export function diffNewlyActive(
  previouslyKnown: ReadonlySet<string>,
  current: readonly string[],
  hasBaseline: boolean,
): { newlyActive: string[]; next: Set<string> } {
  const next = new Set(current);
  if (!hasBaseline) {
    return { newlyActive: [], next };
  }
  const newlyActive = current.filter((key) => !previouslyKnown.has(key));
  return { newlyActive, next };
}

/** mm:ss, floor-clamped at 00:00 — the guest cooldown countdown's one display format. */
export function formatCountdown(remainingSeconds: number): string {
  const clamped = Math.max(0, Math.round(remainingSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
