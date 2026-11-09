const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export const PBKDF2_ITERATIONS = 100_000;
const HASH_PREFIX = "pbkdf2-sha256";

export function randomId(): string {
  return crypto.randomUUID();
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `spx_${b64}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(digest);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

export function resolveIterations(configured?: string): number {
  const n = Number(configured);
  if (!configured || !Number.isInteger(n)) return PBKDF2_ITERATIONS;
  return Math.min(PBKDF2_ITERATIONS, Math.max(1000, n));
}

export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derive(password, salt, iterations);
  return { hash: `${HASH_PREFIX}$${iterations}$${derived}`, salt: toHex(salt.buffer as ArrayBuffer) };
}

export async function verifyPassword(password: string, stored: string, saltHex: string): Promise<boolean> {
  let iterations = PBKDF2_ITERATIONS;
  let expected = stored;
  const parts = stored.split("$");
  if (parts.length === 3 && parts[0] === HASH_PREFIX) {
    iterations = Number(parts[1]);
    expected = parts[2];
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  }
  const computed = await derive(password, fromHex(saltHex), iterations);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function validateMasterKey(masterKeyHex: string | undefined): string {
  const key = (masterKeyHex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("MASTER_KEY is missing or not 64 hex characters. Generate one with: openssl rand -hex 32, then: wrangler secret put MASTER_KEY");
  }
  return key;
}

async function importMasterKey(masterKeyHex: string): Promise<CryptoKey> {
  const raw = fromHex(validateMasterKey(masterKeyHex));
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, masterKeyHex: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importMasterKey(masterKeyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return { ciphertext: toHex(encrypted), iv: toHex(iv.buffer as ArrayBuffer) };
}

export async function decryptSecret(ciphertextHex: string, ivHex: string, masterKeyHex: string): Promise<string> {
  const key = await importMasterKey(masterKeyHex);
  const iv = fromHex(ivHex);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, fromHex(ciphertextHex).buffer as ArrayBuffer);
  return decoder.decode(decrypted);
}
