import {
  parseMetaEmbeddedSignupMessage,
  type MetaEmbeddedSignupConfig,
  type MetaEmbeddedSignupEvent,
  type MetaEmbeddedSignupHandlers,
} from "./embedded-signup.contracts";

export { parseMetaEmbeddedSignupMessage };
export type {
  MetaEmbeddedSignupAssets,
  MetaEmbeddedSignupConfig,
  MetaEmbeddedSignupEvent,
  MetaEmbeddedSignupHandlers,
} from "./embedded-signup.contracts";

type FacebookLoginResponse = {
  authResponse?: { code?: string };
  status?: string;
};

type FacebookSdk = {
  init(config: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: "code";
      override_default_response_type: true;
      extras: { setup: { solutionID?: string } };
    },
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SCRIPT_ID = "meta-jssdk";
let sdkPromise: Promise<void> | null = null;
let initializedAppId: string | null = null;

function validateConfig(config: MetaEmbeddedSignupConfig): void {
  if (!config.appId.trim() || !config.configId.trim()) {
    throw new Error("Meta App ID and Embedded Signup configuration ID are required.");
  }
  if (!/^v\d+\.\d+$/.test(config.graphApiVersion)) {
    throw new Error("Meta Graph API version must use the format vNN.NN.");
  }
}

/** Load and initialise the Meta JavaScript SDK only on the page that hosts onboarding. */
export function loadMetaFacebookSdk(config: MetaEmbeddedSignupConfig): Promise<void> {
  validateConfig(config);
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Meta Embedded Signup is available only in a browser."));
  }

  if (window.FB) {
    if (initializedAppId !== config.appId) {
      window.FB.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: config.graphApiVersion,
      });
      initializedAppId = config.appId;
    }
    return Promise.resolve();
  }
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SDK_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const timeout = window.setTimeout(() => {
      sdkPromise = null;
      reject(new Error("Meta JavaScript SDK did not load in time."));
    }, 20_000);

    const initialise = () => {
      if (!window.FB) return;
      try {
        window.FB.init({
          appId: config.appId,
          autoLogAppEvents: true,
          xfbml: false,
          version: config.graphApiVersion,
        });
        initializedAppId = config.appId;
        window.clearTimeout(timeout);
        resolve();
      } catch {
        window.clearTimeout(timeout);
        sdkPromise = null;
        reject(new Error("Meta JavaScript SDK initialisation failed."));
      }
    };

    window.fbAsyncInit = initialise;
    if (!existing) {
      script.id = SDK_SCRIPT_ID;
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.onerror = () => {
        window.clearTimeout(timeout);
        sdkPromise = null;
        reject(new Error("Meta JavaScript SDK could not be loaded."));
      };
      document.head.appendChild(script);
    } else if (window.FB) {
      initialise();
    } else {
      script.addEventListener("load", initialise, { once: true });
      script.addEventListener(
        "error",
        () => {
          window.clearTimeout(timeout);
          sdkPromise = null;
          reject(new Error("Meta JavaScript SDK could not be loaded."));
        },
        { once: true },
      );
    }
  });

  return sdkPromise;
}

/**
 * Start Embedded Signup directly from a user click. The returned disposer
 * removes the cross-window listener; the authorization code and Meta asset
 * identifiers are delivered separately and must be joined server-side.
 */
export function startMetaEmbeddedSignup(
  config: MetaEmbeddedSignupConfig,
  handlers: MetaEmbeddedSignupHandlers,
): () => void {
  validateConfig(config);
  if (!window.FB || initializedAppId !== config.appId) {
    throw new Error("Meta JavaScript SDK is not ready for this App ID.");
  }

  const onMessage = (event: MessageEvent) => {
    const signupEvent: MetaEmbeddedSignupEvent | null = parseMetaEmbeddedSignupMessage(
      event.origin,
      event.data,
    );
    if (signupEvent) handlers.onEvent(signupEvent);
  };
  window.addEventListener("message", onMessage);

  try {
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (code) {
          handlers.onAuthorizationCode(code);
        } else {
          handlers.onError(
            new Error("Meta Embedded Signup was cancelled or did not return an authorization code."),
          );
        }
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: config.solutionId ? { solutionID: config.solutionId } : {} },
      },
    );
  } catch {
    window.removeEventListener("message", onMessage);
    throw new Error("Meta Embedded Signup could not be launched.");
  }

  return () => window.removeEventListener("message", onMessage);
}
