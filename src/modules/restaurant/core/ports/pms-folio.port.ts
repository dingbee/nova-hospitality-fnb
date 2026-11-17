/**
 * Hospitality bridge — PMS folio port.
 *
 * The outlet never talks to a PMS directly. It asks for a folio port and gets
 * one of two implementations:
 *
 *   host (default)  the real folio adapter of the hosting PMS
 *   off             a standalone outlet with no hotel behind it: room charge
 *                   is simply not an available tender
 *
 * Resolution is dynamic so a standalone bundle never pulls hotel code into its
 * module graph.
 */
export type PmsFolioPort = typeof import("@/domains/hospitality/folio/folioAdapter.server");

function folioMode(): "host" | "off" {
  const flag =
    (typeof process !== "undefined" ? process.env?.["VITE_FNB_PMS_FOLIO"] : undefined) ??
    (import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_FNB_PMS_FOLIO"];
  return flag === "off" ? "off" : "host";
}

/** True when a PMS is present. Callers use this to hide the tender entirely. */
export function isRoomChargeAvailable(): boolean {
  return folioMode() === "host";
}

const UNAVAILABLE = "Room charge is unavailable: this outlet is not connected to a property management system.";

export async function loadPmsFolioPort(): Promise<PmsFolioPort> {
  if (folioMode() === "off") {
    const reject = async () => {
      throw new Error(UNAVAILABLE);
    };
    return {
      findChargeableStays: async () => [],
      validateRoomCharge: async () => ({
        eligible: false as const,
        code: "pms_unavailable",
        message: UNAVAILABLE,
        stay: null,
      }),
      postRoomCharge: reject,
      getFolioPostingStatus: reject,
    } as unknown as PmsFolioPort;
  }
  return import("@/domains/hospitality/folio/folioAdapter.server");
}
