import { expect, it } from "vitest";
import { parseMetaEmbeddedSignupMessage } from "./embedded-signup.client";

it("accepts FINISH only from Meta origins and returns WABA/phone identifiers", () => {
  const payload = JSON.stringify({
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH",
    data: { waba_id: "waba-1", phone_number_id: "phone-1" },
  });
  expect(parseMetaEmbeddedSignupMessage("https://www.facebook.com", payload)).toEqual({
    event: "FINISH",
    assets: { wabaId: "waba-1", phoneNumberId: "phone-1" },
  });
  expect(parseMetaEmbeddedSignupMessage("https://evilfacebook.com", payload)).toBeNull();
});

it("handles cancellation and error events without trusting arbitrary messages", () => {
  expect(
    parseMetaEmbeddedSignupMessage(
      "https://www.facebook.com",
      JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { current_step: "PHONE" },
      }),
    ),
  ).toEqual({ event: "CANCEL", currentStep: "PHONE" });
  expect(
    parseMetaEmbeddedSignupMessage(
      "https://www.facebook.com",
      JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "ERROR",
        data: { error_message: "Onboarding failed" },
      }),
    ),
  ).toEqual({ event: "ERROR", message: "Onboarding failed" });
  expect(parseMetaEmbeddedSignupMessage("https://www.facebook.com", "not-json")).toBeNull();
  expect(
    parseMetaEmbeddedSignupMessage(
      "https://www.facebook.com",
      JSON.stringify({
        type: "OTHER",
        event: "FINISH",
        data: { waba_id: "waba-1", phone_number_id: "phone-1" },
      }),
    ),
  ).toBeNull();
});

it("rejects a FINISH event with incomplete asset identifiers", () => {
  expect(
    parseMetaEmbeddedSignupMessage(
      "https://www.facebook.com",
      JSON.stringify({
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: { waba_id: "waba-1" },
      }),
    ),
  ).toBeNull();
});
