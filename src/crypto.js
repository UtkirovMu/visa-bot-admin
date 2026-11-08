// Shaxsiy ma'lumotlarni shifrlash: AES-256-GCM (autentifikatsiyalangan shifrlash).
// Asosiy kalit (DATA_KEY) dan HKDF orqali ikki alohida kalit olinadi:
//   - encKey: ma'lumotni shifrlash uchun
//   - idxKey: pasport raqamining "ko'r indeksi" (HMAC) — takroriy yozuvni aniqlash uchun,
//             bazada pasport raqami ochiq ko'rinmaydi.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

let encKey = null;
let idxKey = null;

export function initCrypto(dataKeyHex) {
  const master = Buffer.from(dataKeyHex, "hex");
  if (master.length !== 32) throw new Error("DATA_KEY 32 bayt bo'lishi kerak");
  encKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "visa-admin/enc/v1", 32));
  idxKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "visa-admin/idx/v1", 32));
}

const AAD = Buffer.from("visa-admin/person/v1");

/** Obyektni shifrlaydi: "v1.<base64url(iv | tag | ciphertext)>" */
export function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}

/** Shifrni ochadi. Ma'lumot o'zgartirilgan bo'lsa (yoki kalit boshqa) — xato. */
export function unseal(sealed) {
  if (typeof sealed !== "string" || !sealed.startsWith("v1.")) throw new Error("bad_format");
  const buf = Buffer.from(sealed.slice(3), "base64url");
  if (buf.length < 29) throw new Error("bad_format");
  const d = createDecipheriv("aes-256-gcm", encKey, buf.subarray(0, 12));
  d.setAAD(AAD);
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

/** Pasport raqamining ko'r indeksi (bir xil pasport — bir xil indeks, lekin raqamni tiklab bo'lmaydi). */
export function blindIndex(passport) {
  return createHmac("sha256", idxKey).update(`passport:${passport}`).digest("base64url");
}
