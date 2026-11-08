// Rejalashtirgich: har kuni CHECK_TIMES vaqtlarida (Toshkent vaqti) barcha odamlarni tekshiradi.
// Odamlar ketma-ket, orasida pauza bilan tekshiriladi (visadoctors'ga ortiqcha yuk tushmasligi uchun).
// Viza chiqsa — adminga Telegram xabari (har bir odam uchun bir marta).

import { config } from "./config.js";
import { getPerson, listPersonIds, markIssuedNotified, saveCheck } from "./db.js";
import { notifyIssued } from "./telegram.js";
import { checkVisa, isIssued } from "./visa.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  running: false,
  reason: null,
  total: 0,
  done: 0,
  startedAt: null,
  finishedAt: null,
  nextRunAt: null,
};
const inFlight = new Set(); // bir odam bir vaqtda faqat bir marta tekshiriladi
let timer = null;

/** Keyingi rejali vaqt (UTC millisekund). */
export function nextRunAt(now = Date.now()) {
  const off = config.tzOffsetMin * 60_000;
  const local = new Date(now + off);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - off;
  for (let d = 0; d < 2; d++) {
    for (const m of config.checkTimes) {
      const t = dayStart + d * 86_400_000 + m * 60_000;
      if (t > now + 1000) return t;
    }
  }
  return dayStart + 86_400_000 + config.checkTimes[0] * 60_000;
}

export function schedulerStatus() {
  return { ...state, checkTimes: config.checkTimes, tzOffsetMin: config.tzOffsetMin };
}

/** Bitta odamni tekshirish, natijani saqlash va kerak bo'lsa adminga xabar. */
export async function checkPerson(id) {
  if (inFlight.has(id)) return { busy: true };
  const person = getPerson(id);
  if (!person) return { notFound: true };
  inFlight.add(id);
  try {
    const result = await checkVisa(person);
    if (!getPerson(id)) return { notFound: true }; // tekshiruv vaqtida o'chirilgan bo'lsa
    saveCheck(id, result);
    if (isIssued(result) && !person.issuedNotifiedAt) {
      if (await notifyIssued(person, result)) markIssuedNotified(id);
    }
    return { result };
  } finally {
    inFlight.delete(id);
  }
}

/** Hammasini tekshirish. Allaqachon ishlayotgan bo'lsa — false. */
export function runAll(reason) {
  if (state.running) return false;
  const ids = listPersonIds();
  Object.assign(state, { running: true, reason, total: ids.length, done: 0, startedAt: Date.now(), finishedAt: null });
  console.log(`[scheduler] tekshiruv boshlandi (${reason}): ${ids.length} ta`);
  (async () => {
    let errors = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        const r = await checkPerson(ids[i]);
        if (r.result?.state === "error") errors++;
      } catch (e) {
        errors++;
        console.error("[scheduler] xato:", e?.message);
      }
      state.done = i + 1;
      if (i < ids.length - 1) await sleep(config.delayBetweenChecksMs);
    }
    Object.assign(state, { running: false, finishedAt: Date.now() });
    console.log(`[scheduler] tekshiruv tugadi: ${ids.length} ta, xatolar: ${errors}`);
  })();
  return true;
}

function scheduleNext() {
  clearTimeout(timer);
  state.nextRunAt = nextRunAt();
  const wait = Math.max(1000, state.nextRunAt - Date.now());
  timer = setTimeout(() => {
    runAll("schedule");
    scheduleNext();
  }, Math.min(wait, 2 ** 31 - 1));
  timer.unref?.();
}

export function startScheduler() {
  scheduleNext();
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  console.log(`[scheduler] vaqtlar: ${config.checkTimes.map(fmt).join(", ")} (UTC${config.tzOffsetMin >= 0 ? "+" : ""}${config.tzOffsetMin / 60})`);
}

export function stopScheduler() {
  clearTimeout(timer);
}
