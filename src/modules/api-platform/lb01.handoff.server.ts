import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_ENV = "LB01_PEER_CREDENTIAL_ENCRYPTION_KEY";

function encryptionKey(): Buffer {
  const value = process.env[KEY_ENV] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${KEY_ENV} must be configured as 64 hexadecimal characters.`);
  }
  return Buffer.from(value, "hex");
}

function aad(connectionId: string, peerProduct: string): Buffer {
  return Buffer.from(`LB01-PEER-CREDENTIAL-V1|${connectionId}|${peerProduct}`, "utf8");
}

export function encryptLb01PeerCredential(
  token: string,
  connectionId: string,
  peerProduct: string,
): { ciphertext: string; iv: string; tag: string; prefix: string } {
  const match = /^lb01_v1_([a-f0-9]{24})_[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match) throw new Error("Invalid LB-01 peer credential format.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(aad(connectionId, peerProduct));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: `\\x${ciphertext.toString("hex")}`,
    iv: `\\x${iv.toString("hex")}`,
    tag: `\\x${cipher.getAuthTag().toString("hex")}`,
    prefix: match[1],
  };
}

export function decryptLb01PeerCredential(input: {
  ciphertext: unknown;
  iv: unknown;
  tag: unknown;
  connectionId: string;
  peerProduct: string;
}): string {
  const decodeBytea = (value: unknown): Buffer => {
    if (typeof value !== "string" || !value.startsWith(String.fromCharCode(92) + "x") || !/^[a-f0-9]+$/i.test(value.slice(2))) {
      throw new Error("Encrypted LB-01 credential material is invalid.");
    }
    return Buffer.from(value.slice(2), "hex");
  };
  const iv = decodeBytea(input.iv);
  const tag = decodeBytea(input.tag);
  const ciphertext = decodeBytea(input.ciphertext);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) {
    throw new Error("Encrypted LB-01 credential material is invalid.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAAD(aad(input.connectionId, input.peerProduct));
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  if (!/^lb01_v1_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Decrypted LB-01 credential failed format validation.");
  }
  return token;
}

export function hashLb01HandoffCode(code: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("Invalid LB-01 handoff code.");
  return `\\x${createHash("sha256").update(code, "utf8").digest("hex")}`;
}

export function createLb01HandoffCode(): string {
  return randomBytes(32).toString("base64url");
}

export function validateLb01PeerBaseUrl(): URL {
  const value = process.env.LB01_PEER_BASE_URL ?? "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LB01_PEER_BASE_URL must be configured to the peer product HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash) {
    throw new Error("LB01_PEER_BASE_URL must be an HTTPS origin without credentials, path, query or fragment.");
  }
  return url;
}
