// SQLite baza (Node.js ichidagi node:sqlite — tashqi paket yo'q).
// Shaxsiy ma'lumotlar (pasport, ism, tug'ilgan sana, izoh) faqat shifrlangan holda saqlanadi.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { blindIndex, seal, unseal } from "./crypto.js";

let db = null;
const MAX_HISTORY = 60;

export function initDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;

    CREATE TABLE IF NOT EXISTS people (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      pidx               TEXT    NOT NULL UNIQUE,
      data               TEXT    NOT NULL,
      created_at         INTEGER NOT NULL,
      last_checked_at    INTEGER,
      last_state         TEXT,
      last_status        TEXT,
      last_progress      TEXT,
      last_color         TEXT,
      last_text          TEXT,
      last_app_date      TEXT,
      last_visa_type     TEXT,
      last_eta           TEXT,
      last_error         TEXT,
      issued_notified_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS checks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      state     TEXT    NOT NULL,
      status    TEXT,
      progress  TEXT,
      message   TEXT
    );
    CREATE INDEX IF NOT EXISTS checks_person_at ON checks (person_id, at DESC);
  `);
}

const rowToPerson = (r) => {
  if (!r) return null;
  let data;
  try {
    data = unseal(r.data);
  } catch {
    data = { passport: "??????", surname: "SHIFR XATOSI", name: "", patronymic: "", birthDate: "", note: "" };
  }
  return {
    id: r.id,
    ...data,
    createdAt: r.created_at,
    lastCheckedAt: r.last_checked_at,
    lastState: r.last_state,
    lastStatus: r.last_status,
    lastProgress: r.last_progress,
    lastColor: r.last_color,
    lastText: r.last_text,
    lastAppDate: r.last_app_date,
    lastVisaType: r.last_visa_type,
    lastEta: r.last_eta,
    lastError: r.last_error,
    issuedNotifiedAt: r.issued_notified_at,
  };
};

/** Yangi odam qo'shish. Shu pasport bilan odam bor bo'lsa — null. */
export function addPerson(person) {
  const pidx = blindIndex(person.passport);
  if (db.prepare("SELECT 1 FROM people WHERE pidx = ?").get(pidx)) return null;
  const r = db
    .prepare("INSERT INTO people (pidx, data, created_at) VALUES (?, ?, ?)")
    .run(pidx, seal(person), Date.now());
  return getPerson(Number(r.lastInsertRowid));
}

export function getPerson(id) {
  return rowToPerson(db.prepare("SELECT * FROM people WHERE id = ?").get(id));
}

export function listPeople() {
  return db.prepare("SELECT * FROM people ORDER BY created_at DESC").all().map(rowToPerson);
}

export function listPersonIds() {
  return db.prepare("SELECT id FROM people ORDER BY id").all().map((r) => r.id);
}

export function deletePerson(id) {
  return db.prepare("DELETE FROM people WHERE id = ?").run(id).changes > 0;
}

export function countPeople() {
  return db.prepare("SELECT COUNT(*) AS n FROM people").get().n;
}

/** Tekshiruv natijasini saqlash. Xato bo'lsa oxirgi muvaffaqiyatli holat saqlanib qoladi. */
export function saveCheck(id, r) {
  const now = Date.now();
  if (r.state === "error") {
    db.prepare("UPDATE people SET last_checked_at = ?, last_error = ? WHERE id = ?").run(now, r.message || "xato", id);
  } else {
    const v = r.visa || {};
    db.prepare(`
      UPDATE people SET
        last_checked_at = ?, last_state = ?, last_status = ?, last_progress = ?, last_color = ?,
        last_text = ?, last_app_date = ?, last_visa_type = ?, last_eta = ?, last_error = NULL
      WHERE id = ?`).run(
      now, r.state, v.status ?? null, v.progressStatus ?? null, v.color ?? null,
      r.state === "done" ? v.responseText ?? null : r.message ?? null,
      v.applicationDate ?? null, v.visaType ?? null, v.processing?.message ?? null, id,
    );
  }
  db.prepare("INSERT INTO checks (person_id, at, state, status, progress, message) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, now, r.state, r.visa?.status ?? null, r.visa?.progressStatus ?? null,
    r.state === "done" ? r.visa?.processing?.message ?? null : r.message ?? null,
  );
  db.prepare(`
    DELETE FROM checks WHERE person_id = ? AND id NOT IN (
      SELECT id FROM checks WHERE person_id = ? ORDER BY at DESC LIMIT ?
    )`).run(id, id, MAX_HISTORY);
}

export function markIssuedNotified(id) {
  db.prepare("UPDATE people SET issued_notified_at = ? WHERE id = ?").run(Date.now(), id);
}

export function history(id, limit = 30) {
  return db
    .prepare("SELECT at, state, status, progress, message FROM checks WHERE person_id = ? ORDER BY at DESC LIMIT ?")
    .all(id, limit);
}
