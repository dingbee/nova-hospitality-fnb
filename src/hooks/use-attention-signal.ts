import { useCallback, useEffect, useRef, useState } from "react";
import { diffNewlyActive } from "@/lib/notifications/attention";

/**
 * Staff/guest attention affordance — a short WebAudio-synthesized ping plus
 * navigator.vibrate, layered on top of whatever visual notification is
 * already authoritative (a toast, a badge, a status card). Audio/vibration
 * are never the source of truth, only an attention affordance — losing
 * either one degrades to visual-only, silently, exactly like this app's
 * other guest-portal storage helpers (use-guest-theme.ts,
 * selforder-recovery.ts) already degrade when localStorage is unavailable.
 *
 * iOS Safari (and most browsers) refuse to start an AudioContext outside a
 * user gesture. Rather than a fragile "try to autoplay and catch the
 * error" hack, this establishes an "audio unlocked" state exactly once,
 * the first time the user interacts with the page at all (any pointerdown
 * or keydown, app-wide — not a dedicated "enable sound" button the user
 * has to find first), and reuses that single AudioContext for every ping
 * afterward. Before that first gesture, pings are silently skipped —
 * visual state is still correct, sound simply hasn't been unlocked yet.
 */

let sharedAudioContext: AudioContext | null = null;
let unlockListenersAttached = false;
let audioUnlocked = false;
const unlockSubscribers = new Set<() => void>();

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vendor-prefixed webkitAudioContext has no official type.
  const vendorCtor = (window as any).webkitAudioContext as typeof AudioContext | undefined;
  return window.AudioContext ?? vendorCtor ?? null;
}

function markUnlocked() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  for (const notify of unlockSubscribers) notify();
}

/** Idempotent — safe to call from any component that wants to guarantee a gesture has occurred, e.g. a "Sound: on" toggle button's own onClick. */
export function unlockAttentionAudio(): void {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return;
  try {
    if (!sharedAudioContext) sharedAudioContext = new Ctor();
    if (sharedAudioContext.state === "suspended") void sharedAudioContext.resume();
    markUnlocked();
  } catch {
    // No AudioContext support, or the browser refused — sound stays off,
    // never surfaced as an error to the caller.
  }
}

function attachGlobalUnlockListeners() {
  if (unlockListenersAttached || typeof document === "undefined") return;
  unlockListenersAttached = true;
  const handler = () => unlockAttentionAudio();
  document.addEventListener("pointerdown", handler, { passive: true });
  document.addEventListener("keydown", handler);
}

/** A short, professional two-tone blip — never a continuous tone, never a jingle. `profile` only changes loudness/duration: guest is deliberately more subtle than staff. */
function playTone(profile: "staff" | "guest"): void {
  if (!audioUnlocked || !sharedAudioContext) return;
  try {
    const ctx = sharedAudioContext;
    const now = ctx.currentTime;
    const peakGain = profile === "staff" ? 0.16 : 0.09;
    const duration = profile === "staff" ? 0.14 : 0.1;
    const frequencies = profile === "staff" ? [880, 1175] : [740];

    frequencies.forEach((freq, i) => {
      const start = now + i * (duration + 0.03);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peakGain, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    });
  } catch {
    // Never let a synthesis failure surface — visual notification already
    // carries the truth.
  }
}

/**
 * Wraps navigator.vibrate — unsupported (most desktop browsers, iOS Safari
 * entirely) or denied is a silent no-op, never a thrown error. Exported
 * (rather than kept private) specifically so this degradation is directly
 * unit-tested rather than only asserted by inspection.
 */
export function vibrateSafely(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // Some browsers throw for a vibrate() call outside a user gesture —
    // degrade silently exactly like an unsupported vibrate would.
  }
}

const STAFF_MUTE_KEY = "nova.staff.attention.muted";

function readStaffMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STAFF_MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Staff-side attention signal + a persisted mute preference. Any click
 * anywhere in the app unlocks audio (see attachGlobalUnlockListeners); this
 * hook just needs to know whether that has happened yet so a "Sound: off"
 * indicator can be shown honestly rather than implying sound is playing
 * when the browser hasn't allowed it to yet.
 */
export function useStaffAttentionSignal() {
  const [muted, setMutedState] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    setMutedState(readStaffMuted());
    setUnlocked(audioUnlocked);
    attachGlobalUnlockListeners();
    const onUnlock = () => setUnlocked(true);
    unlockSubscribers.add(onUnlock);
    return () => {
      unlockSubscribers.delete(onUnlock);
    };
  }, []);

  const setMuted = useCallback((value: boolean) => {
    setMutedState(value);
    try {
      window.localStorage.setItem(STAFF_MUTE_KEY, value ? "1" : "0");
    } catch {
      // Preference just won't persist across reloads — never blocks operation.
    }
  }, []);

  const notify = useCallback(
    (vibrationPattern: number[] = [90]) => {
      if (muted) return;
      playTone("staff");
      vibrateSafely(vibrationPattern);
    },
    [muted],
  );

  return { muted, setMuted, unlocked, notify };
}

/** Guest side never has a mute control — the spec calls for "subtle", not "silenceable"; a guest who doesn't want sound simply has their device on silent, same as any other notification. */
export function useGuestAttentionSignal() {
  useEffect(() => {
    attachGlobalUnlockListeners();
  }, []);

  return useCallback((vibrationPattern: number[] = [40]) => {
    playTone("guest");
    vibrateSafely(vibrationPattern);
  }, []);
}

/**
 * Tracks which of `activeKeys` are newly active since the last render,
 * using diffNewlyActive's "no alert on first observation" rule. Returns a
 * plain array (not a ref) so callers can useEffect on it directly.
 */
export function useNewlyActiveKeys(activeKeys: readonly string[]): string[] {
  const knownRef = useRef<Set<string>>(new Set());
  const hasBaselineRef = useRef(false);
  const [newlyActive, setNewlyActive] = useState<string[]>([]);

  useEffect(() => {
    const { newlyActive: fresh, next } = diffNewlyActive(
      knownRef.current,
      activeKeys,
      hasBaselineRef.current,
    );
    knownRef.current = next;
    hasBaselineRef.current = true;
    setNewlyActive(fresh);
    // activeKeys is an array literal from the caller on every poll; compare
    // by content, not identity, or this would "diff" on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKeys.join("|")]);

  return newlyActive;
}
