// Barcha sozlamalar muhit o'zgaruvchilaridan o'qiladi. Maxfiy qiymatlar kodda saqlanmaydi.

const env = process.env;
const isProd = env.NODE_ENV === "production";

function parseTimes(raw) {
  const out = [];
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 24 && min < 60) out.push(h * 60 + min);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export const config = {
  isProd,
  port: Number(env.PORT) || 8080,
  botToken: (env.BOT_TOKEN || "").trim(),
  adminIds: new Set(
    (env.ADMIN_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{1,16}$/.test(s))
      .map(Number),
  ),
  dataKeyHex: (env.DATA_KEY || "").trim(),
  dbPath: env.DB_PATH || "/data/visa-admin.db",
  // Tekshiruv vaqtlari (mahalliy vaqt bo'yicha). Standart: 09:00, 14:00, 20:00
  checkTimes: parseTimes(env.CHECK_TIMES || "09:00,14:00,20:00"),
  // Asia/Tashkent = UTC+5 (yozgi vaqt yo'q)
  tzOffsetMin: Number.isFinite(Number(env.TZ_OFFSET_MINUTES)) && env.TZ_OFFSET_MINUTES !== undefined ? Number(env.TZ_OFFSET_MINUTES) : 300,
  delayBetweenChecksMs: Number(env.CHECK_DELAY_MS) || 5000,
  initDataMaxAgeSec: 24 * 3600,
  trustProxy: env.TRUST_PROXY !== "false",
  // Faqat test uchun (production'da e'tiborga olinmaydi)
  upstream: !isProd && env.VISA_UPSTREAM_DEV ? env.VISA_UPSTREAM_DEV : "https://visadoctors.uz/api/en/visas/v2/check-status/",
  telegramApi: !isProd && env.TELEGRAM_API_DEV ? env.TELEGRAM_API_DEV : "https://api.telegram.org",
  pollIntervalMs: !isProd && env.POLL_INTERVAL_DEV_MS ? Number(env.POLL_INTERVAL_DEV_MS) : 2000,
};

export function validateConfig() {
  const errors = [];
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(config.botToken)) errors.push("BOT_TOKEN noto'g'ri yoki yo'q");
  if (config.adminIds.size === 0) errors.push("ADMIN_IDS yo'q (masalan: 1830068413)");
  if (!/^[0-9a-fA-F]{64}$/.test(config.dataKeyHex)) errors.push("DATA_KEY 64 belgili hex bo'lishi kerak (32 bayt)");
  if (config.checkTimes.length === 0) errors.push("CHECK_TIMES noto'g'ri (masalan: 09:00,14:00,20:00)");
  return errors;
}
