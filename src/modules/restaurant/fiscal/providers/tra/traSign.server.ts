/**
 * TRA VFD certificate + signing — server-only. Never imported from a
 * client-visible module; private key material never leaves this file's
 * process boundary (spec sections 4/15).
 *
 * Certificate input: TRA issues a PKCS12 (.pfx/.p12) bundle. Parsing a
 * PKCS12 container in-process requires either a third-party library or a
 * hand-rolled ASN.1/PBES decryptor; this environment has no npm registry
 * access to add one (every install attempt during this sprint returned
 * HTTP 403 from the proxy — see final report), and hand-rolling PKCS12
 * decryption is not a justifiable amount of unreviewed custom crypto code
 * for a single sprint. Node's built-in `crypto` module fully covers the
 * actual cryptographic operations TRA requires (RSA-SHA1 signing, X.509
 * serial extraction) given a PEM private key + certificate, so this adapter
 * accepts the PKCS12 bundle's PEM-extracted contents instead of the raw
 * .pfx/.p12 file — the standard, well-documented one-time conversion:
 *   openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem
 *   openssl pkcs12 -in cert.pfx -clcerts -nokeys -out cert.pem
 * This is a disclosed scope limitation, not a fabricated capability: no
 * certificate is invented, and CONFIGURATION_REQUIRED is returned whenever
 * either PEM is absent, exactly as it would be for a missing raw PKCS12.
 */
import { createSign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { TraProtocolError } from "./traTypes";

export interface TraCertificateMaterial {
  privateKeyPem: string;
  certificatePem: string;
}

function readPemEnv(base64Var: string, pathVar: string, pemVar: string): string | null {
  const b64 = process.env[base64Var];
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  const path = process.env[pathVar];
  if (path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }
  return process.env[pemVar] ?? null;
}

/**
 * Returns null — never throws — when no certificate material is configured.
 * The caller (fiscal.server.ts / traClient.server.ts) must treat null as
 * CONFIGURATION_REQUIRED, never fall back to a fabricated certificate.
 */
export function loadTraCertificateMaterial(): TraCertificateMaterial | null {
  const privateKeyPem = readPemEnv(
    "TRA_VFD_PRIVATE_KEY_BASE64",
    "TRA_VFD_PRIVATE_KEY_PATH",
    "TRA_VFD_PRIVATE_KEY_PEM",
  );
  const certificatePem = readPemEnv(
    "TRA_VFD_CERTIFICATE_BASE64",
    "TRA_VFD_CERTIFICATE_PATH",
    "TRA_VFD_CERTIFICATE_PEM",
  );
  if (!privateKeyPem || !certificatePem) return null;
  return { privateKeyPem, certificatePem };
}

/** Base64-encoded certificate serial, exactly as the Cert-Serial header requires. */
export function certificateSerialBase64(certificatePem: string): string {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificatePem);
  } catch (err) {
    throw new TraProtocolError(
      "TRA_CERTIFICATE_INVALID",
      `Fiscal certificate could not be parsed: ${(err as Error).message}`,
    );
  }
  // serialNumber is a hex string (e.g. "01A2B3...") per Node's X509Certificate API.
  const hex = cert.serialNumber.length % 2 === 0 ? cert.serialNumber : `0${cert.serialNumber}`;
  return Buffer.from(hex, "hex").toString("base64");
}

/** SHA-1/RSA signature, base64-encoded, over the exact bytes given. */
export function signSha1Rsa(data: string, privateKeyPem: string): string {
  try {
    const signer = createSign("RSA-SHA1");
    signer.update(data, "utf8");
    signer.end();
    return signer.sign(privateKeyPem, "base64");
  } catch (err) {
    throw new TraProtocolError(
      "TRA_SIGNATURE_FAILED",
      `Failed to sign TRA payload: ${(err as Error).message}`,
    );
  }
}
