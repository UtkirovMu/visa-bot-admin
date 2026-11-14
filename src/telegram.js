// Adminga Telegram orqali xabar yuborish (bot tokeni bilan). Token log qilinmaydi.

import { config } from "./config.js";
import { maskPassport, fullName } from "./validate.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const KR = { "발급": "Viza berilgan", "허가": "Ruxsat berilgan", "유학.연수": "O'qish / malaka oshirish" };
const tr = (v) => (v ? (KR[v] ? `${KR[v]} · ${v}` : v) : "");

async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`${config.telegramApi}/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.warn("[telegram] sendMessage:", res.status, body?.description ?? "");
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[telegram] sendMessage xatosi:", e?.name ?? "unknown");
    return false;
  }
}

/** Viza chiqqani haqida barcha adminlarga xabar. Kamida bittasiga yetib borsa — true. */
export async function notifyIssued(person, result) {
  const v = result.visa || {};
  const lines = [
    "🎉 <b>Viza chiqdi!</b>",
    "",
    `👤 <b>${esc(fullName(person))}</b>`,
    `🛂 ${esc(maskPassport(person.passport))}`,
  ];
  if (person.note) lines.push(`📝 ${esc(person.note)}`);
  lines.push("", `📌 Holat: <b>${esc(v.status || tr(v.progressStatus))}</b>`);
  if (v.progressStatus) lines.push(`🏛 Elchixonada: ${esc(tr(v.progressStatus))}`);
  if (v.applicationDate) lines.push(`📅 Ariza sanasi: ${esc(v.applicationDate)}`);
  if (v.visaType) lines.push(`🗂 Viza turi: ${esc(tr(v.visaType))}${v.stayQualification ? ` (${esc(v.stayQualification)})` : ""}`);
  if (v.reviewDate) lines.push(`✅ Berilgan sana: ${esc(v.reviewDate)}`);
  if (v.expiryDate) lines.push(`⏳ Amal qilish muddati: ${esc(v.expiryDate)} gacha`);
  lines.push("", v.pdf ? "📄 Elektron viza (PDF) alohida yuboriladi." : "Batafsil — admin panelda.");

  let delivered = false;
  for (const id of config.adminIds) delivered = (await sendMessage(id, lines.join("\n"))) || delivered;
  return delivered;
}

/** Hujjat (PDF) yuborish — multipart, Node ichidagi FormData bilan. */
async function sendDocument(chatId, buf, filename, caption) {
  try {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    fd.append("caption", caption);
    fd.append("parse_mode", "HTML");
    fd.append("document", new Blob([buf], { type: "application/pdf" }), filename);
    const res = await fetch(`${config.telegramApi}/bot${config.botToken}/sendDocument`, {
      method: "POST",
      body: fd,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      console.warn("[telegram] sendDocument:", res.status, body?.description ?? "");
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[telegram] sendDocument xatosi:", e?.name ?? "unknown");
    return false;
  }
}

const safeFile = (s) => s.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "viza";

/** Elektron viza PDF'ini barcha adminlarga yuboradi. Kamida bittasiga yetib borsa — true. */
export async function sendVisaPdf(person, buf) {
  const filename = `Viza_${safeFile(`${person.surname} ${person.name}`)}.pdf`;
  const caption = `📄 <b>Elektron viza</b>\n👤 ${esc(fullName(person))}\n🛂 ${esc(maskPassport(person.passport))}`;
  let delivered = false;
  for (const id of config.adminIds) delivered = (await sendDocument(id, buf, filename, caption)) || delivered;
  return delivered;
}
