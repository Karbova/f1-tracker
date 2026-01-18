import Database from "better-sqlite3";
import { app } from "electron";
import path from "path";

const dbPath = path.join(app.getPath("userData"), "f1-tracker.db");
export const db = new Database(dbPath);

function ensureColumns() {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));

  const add = (name: string, def: string) => {
    if (!names.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`);
  };

  add("deadline", "TEXT"); // YYYY-MM-DD
  add("estimate_min", "INTEGER");
  add("actual_min", "INTEGER");
  add("finished_at", "TEXT");

  add("points_base", "INTEGER NOT NULL DEFAULT 0");
  add("points_bonus", "INTEGER NOT NULL DEFAULT 0");
  add("points_penalty", "INTEGER NOT NULL DEFAULT 0");
  add("points_total", "INTEGER NOT NULL DEFAULT 0");

  // ✅ Новое поле: куда “зачислять” очки (фиксируем исходную категорию)
  // Например: task.session_type мог стать 'parc', но очки должны остаться в 'race'/'sprint'/...
  add("points_session_type", "TEXT");

  // ✅ Заполняем для старых записей (один раз, но безопасно запускать каждый старт)
  // Если уже заполнено — не трогаем.
  db.exec(`
    UPDATE tasks
    SET points_session_type = session_type
    WHERE points_session_type IS NULL OR points_session_type = '';
  `);
}

export function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      session_type TEXT NOT NULL,
      status TEXT NOT NULL,
      laps_total INTEGER NOT NULL DEFAULT 1,
      laps_done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       start_date TEXT NOT NULL,
       start_time TEXT,
       end_time TEXT,
       location TEXT,
       notes TEXT,
       created_at TEXT NOT NULL
    );
  `);

  ensureColumns();
}