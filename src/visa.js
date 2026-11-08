// visadoctors.uz orqali viza holatini tekshirish (sayt bilan bir xil API).
// Manzil kodda qat'iy belgilangan (SSRF yo'q), javob hajmi va maydonlari tekshiriladi.

import { config } from "./config.js";
import { fullName } from "./validate.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADERS = {
  Accept: "application/json",
  "Accept-Language": "en",
  Origin: "https://visadoctors.uz",
  Referer: "https://visadoctors.uz/en/visa-status",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};
const MAX_POLLS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

async function upstream(path, init) {
  let res;
  try {
    res = await fetch(config.upstream + path, {
      ...init,
      headers: { ...HEADERS, ...(init.headers || {}) },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Viza xizmatiga ulanib bo'lmadi");
  }
  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength > 64 * 1024) throw new Error("Viza xizmati noto'g'ri javob berdi");
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new Error(`Viza xizmati noto'g'ri javob berdi (${res.status})`);
  }
  if (!res.ok) throw new Error(`Viza xizmati xatosi (${res.status})`);
  return data;
}

export function toResult(data) {
  const status = str(data?.status, 20).toUpperCase();
  if (["PENDING", "PROCESSING", "QUEUED", "STARTED"].includes(status)) return { state: "pending" };
  const rd = obj(data?.response_data);
  if (status === "FAILED" || status === "ERROR") return { state: "error", message: str(rd?.message ?? rd?.error, 300) || "Tekshiruv amalga oshmadi" };
  if (status !== "COMPLETED") return { state: "pending" };

  const vd = obj(rd?.visa_data);
  if (!rd || str(rd.status, 20) !== "success" || !vd) {
    return { state: "not_found", message: str(rd?.message ?? rd?.error ?? rd?.detail, 300) || "Ariza topilmadi" };
  }
  const pi = obj(vd.processing_info);
  const color = str(vd.color_background, 7);
  const date = str(vd.application_date, 10);
  return {
    state: "done",
    visa: {
      status: str(vd.status, 80),
      responseText: str(vd.response_text, 600),
      color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#2196F3",
      visaType: str(vd.visa_type, 60),
      progressStatus: str(vd.progress_status, 60),
      applicationDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
      processing: pi ? { isDelayed: pi.is_delayed === true, message: str(pi.status_message, 200) } : null,
    },
  };
}

/** Bitta odamni tekshiradi. Natija: { state: done | not_found | error, visa?, message? } */
export async function checkVisa(person) {
  try {
    const start = await upstream("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passport_number: person.passport,
        english_name: fullName(person),
        birth_date: person.birthDate,
        _form_start_time: Date.now() / 1000 - (20 + Math.random() * 40),
        website: "",
      }),
    });
    const id = typeof start?.id === "string" ? start.id : "";
    if (!UUID_RE.test(id)) throw new Error("Viza xizmati ID qaytarmadi");

    let result = toResult(start);
    for (let i = 0; result.state === "pending"; i++) {
      if (i >= MAX_POLLS) return { state: "error", message: "Javob kutish vaqti tugadi" };
      await sleep(config.pollIntervalMs);
      result = toResult(await upstream(`${id}/`, { method: "GET" }));
    }
    return result;
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : "Noma'lum xato" };
  }
}

/** Viza berilganmi (elchixona holati: 발급 — berilgan, 허가 — ruxsat berilgan) */
export const isIssued = (r) => r.state === "done" && ["발급", "허가"].includes(r.visa?.progressStatus);
