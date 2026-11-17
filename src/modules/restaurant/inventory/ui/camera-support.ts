/**
 * Camera scanning's one real precondition: `getUserMedia`, available in
 * every modern mobile browser engine (Chromium, WebKit/Safari, Gecko)
 * over a secure context. This used to be gated on the browser-native
 * `BarcodeDetector` API instead, which is Chromium-only — no iOS Safari,
 * no Firefox — so on most real staff phones the scanner was silently
 * absent even though the phone's camera and browser were both capable.
 * Decoding itself now happens in pure JS (@zxing/browser), so the only
 * thing worth checking up front is whether a camera stream can be
 * requested at all.
 *
 * A plain function of `navigator` (not a hook) so it's testable without a
 * DOM environment.
 */
export function hasCameraApi(
  nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined,
): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === "function";
}
