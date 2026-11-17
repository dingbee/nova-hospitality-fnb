/**
 * NOVA Hospitality — Restaurant & Bar OS
 * Local TLS origin (PRODUCTIZATION-4C, Phase C).
 *
 * Android Chrome only treats an origin as secure — and therefore only offers
 * PWA installation and modern web APIs — over HTTPS. The appliance has no
 * public DNS name and no cloud certificate authority, so the product issues
 * its own per-installation CA and a LAN server certificate from it.
 *
 * Pure logic only: no filesystem, no process, no secrets. The shell scripts
 * collect the facts; this module decides.
 */

export const TLS_DEFAULTS = {
  httpsPort: 8443,
  httpPort: 8000,
  /** Long enough to survive a season, short enough to stay hygienic. */
  serverCertDays: 397,
  caCertDays: 3650,
  renewWithinDays: 30,
} as const;

export type TlsMode = "auto" | "off";

export interface TlsFacts {
  /** Resolved paths; presence is what matters to the decision. */
  certPresent: boolean;
  keyPresent: boolean;
  /** ISO timestamp parsed from the certificate, when one exists. */
  notAfter?: string | null;
}

export interface TlsConfig {
  enabled: boolean;
  /** HTTPS listener port (only meaningful when enabled). */
  httpsPort: number;
  /** Plain-HTTP listener, kept alive purely to redirect terminals to HTTPS. */
  httpPort: number;
  /** Why TLS is off, when it is off. Surfaced to the operator, never to guests. */
  reason?: string;
}

const port = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
};

export function resolveTlsMode(env: Record<string, string | undefined>): TlsMode {
  return (env["NOVA_TLS_MODE"] ?? "auto").trim().toLowerCase() === "off" ? "off" : "auto";
}

export function resolveTlsConfig(
  env: Record<string, string | undefined>,
  facts: TlsFacts,
): TlsConfig {
  const httpsPort = port(env["NOVA_GATEWAY_TLS_PORT"], TLS_DEFAULTS.httpsPort);
  const httpPort = port(env["NOVA_GATEWAY_PORT"], TLS_DEFAULTS.httpPort);

  if (resolveTlsMode(env) === "off") {
    return { enabled: false, httpsPort, httpPort, reason: "disabled by configuration" };
  }
  if (!facts.certPresent || !facts.keyPresent) {
    return { enabled: false, httpsPort, httpPort, reason: "no certificate material installed" };
  }
  return { enabled: true, httpsPort, httpPort };
}

/**
 * Subject Alternative Names for the appliance certificate. A terminal may
 * reach the server by hostname, by mDNS name or by LAN address, and every one
 * of those must validate or Chrome refuses the origin.
 */
export function buildSanList(input: { hostnames: string[]; ipAddresses: string[] }): string[] {
  const dns = new Set<string>(["localhost"]);
  const ips = new Set<string>(["127.0.0.1", "::1"]);

  for (const raw of input.hostnames) {
    const host = raw.trim().toLowerCase();
    if (!host || host === "localhost") continue;
    dns.add(host);
    if (!host.includes(".")) dns.add(`${host}.local`);
  }
  for (const raw of input.ipAddresses) {
    const ip = raw.trim();
    // Loopback and link-local addresses add nothing a terminal can use.
    if (!ip || ip.startsWith("169.254.")) continue;
    ips.add(ip);
  }
  return [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((i) => `IP:${i}`)];
}

export type CertificateStatus = "ok" | "expiring" | "expired" | "unknown";

export interface CertificateLifecycle {
  status: CertificateStatus;
  daysRemaining: number | null;
  action: string;
}

export function evaluateCertificate(
  notAfter: string | null | undefined,
  now: Date = new Date(),
): CertificateLifecycle {
  if (!notAfter) {
    return { status: "unknown", daysRemaining: null, action: "Issue a certificate with gen-tls.sh." };
  }
  const expiry = new Date(notAfter);
  if (Number.isNaN(expiry.getTime())) {
    return { status: "unknown", daysRemaining: null, action: "Certificate date unreadable; re-issue." };
  }
  const days = Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) {
    return { status: "expired", daysRemaining: days, action: "Re-issue now: terminals will refuse to connect." };
  }
  if (days <= TLS_DEFAULTS.renewWithinDays) {
    return { status: "expiring", daysRemaining: days, action: "Re-issue with gen-tls.sh --force during a quiet period." };
  }
  return { status: "ok", daysRemaining: days, action: "None." };
}

/** The URL an operator should type into a terminal. */
export function terminalOrigin(config: TlsConfig, host: string): string {
  return config.enabled
    ? `https://${host}${config.httpsPort === 443 ? "" : `:${config.httpsPort}`}`
    : `http://${host}${config.httpPort === 80 ? "" : `:${config.httpPort}`}`;
}

/**
 * Android Chrome installability, judged honestly. HTTPS with a certificate the
 * device trusts is the only LAN path; a private CA must be installed on the
 * tablet first.
 */
export function pwaInstallability(input: {
  https: boolean;
  certificateTrustedByDevice: boolean;
  host: string;
}): { installable: boolean; reason: string } {
  if (!input.https) {
    return {
      installable: input.host === "localhost" || input.host === "127.0.0.1",
      reason: "Plain HTTP is not a secure origin on a LAN address.",
    };
  }
  if (!input.certificateTrustedByDevice) {
    return {
      installable: false,
      reason: "The appliance CA is not installed in the device trust store.",
    };
  }
  return { installable: true, reason: "Secure origin with a trusted certificate." };
}
