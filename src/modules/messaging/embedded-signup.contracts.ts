export type MetaEmbeddedSignupConfig = {
  appId: string;
  configId: string;
  graphApiVersion: string;
  solutionId?: string;
};

export type MetaEmbeddedSignupAssets = {
  wabaId: string;
  phoneNumberId: string;
};

export type MetaEmbeddedSignupEvent =
  | { event: "FINISH"; assets: MetaEmbeddedSignupAssets }
  | { event: "CANCEL"; currentStep: string | null }
  | { event: "ERROR"; message: string };

export type MetaEmbeddedSignupHandlers = {
  onAuthorizationCode(code: string): void;
  onEvent(event: MetaEmbeddedSignupEvent): void;
  onError(error: Error): void;
};

export function parseMetaEmbeddedSignupMessage(
  origin: string,
  rawData: unknown,
): MetaEmbeddedSignupEvent | null {
  if (origin !== "https://www.facebook.com" && origin !== "https://web.facebook.com") {
    return null;
  }
  if (typeof rawData !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const envelope = parsed as { type?: unknown; event?: unknown; data?: unknown };
  if (envelope.type !== "WA_EMBEDDED_SIGNUP" || typeof envelope.event !== "string") {
    return null;
  }
  const data =
    typeof envelope.data === "object" && envelope.data !== null
      ? (envelope.data as Record<string, unknown>)
      : {};

  if (envelope.event === "FINISH") {
    if (typeof data.waba_id !== "string" || typeof data.phone_number_id !== "string") {
      return null;
    }
    return {
      event: "FINISH",
      assets: { wabaId: data.waba_id, phoneNumberId: data.phone_number_id },
    };
  }
  if (envelope.event === "CANCEL") {
    return {
      event: "CANCEL",
      currentStep: typeof data.current_step === "string" ? data.current_step : null,
    };
  }
  if (envelope.event === "ERROR") {
    return {
      event: "ERROR",
      message:
        typeof data.error_message === "string"
          ? data.error_message
          : "Meta Embedded Signup failed.",
    };
  }
  return null;
}
