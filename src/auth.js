// Telegram Web App autentifikatsiyasi.
// Telegram har bir Web App ochilishida "initData" beradi va uni bot tokeni bilan imzolaydi:
//   secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
//   hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string))
// data_check_string — "hash" dan boshqa barcha maydonlar, kalit bo'yicha saralangan, "k=v" qatorlari.
// Server imzoni tekshiradi va foydalanuvchi ID'si ADMIN_IDS ichida ekanini tasdiqlaydi.
// Parol, cookie yoki sessiya yo'q — CSRF va parol o'g'irlash xavfi yo'q.

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyInitData(initData, { botToken, adminIds, maxAgeSec, now = Date.now() }) {
  if (typeof initData !== "string" || initData.length === 0 || initData.length > 4096) return { ok: false, reason: "missing" };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed" };

  const pairs = [];
  for (const [k, v] of params) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate * 1000 > now + 60_000 || now - authDate * 1000 > maxAgeSec * 1000) {
    return { ok: false, reason: "expired" };
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const id = user && Number.isSafeInteger(user.id) ? user.id : null;
  if (!id || !adminIds.has(id)) return { ok: false, reason: "not_admin" };

  return { ok: true, user: { id, firstName: typeof user.first_name === "string" ? user.first_name.slice(0, 64) : "" } };
}
