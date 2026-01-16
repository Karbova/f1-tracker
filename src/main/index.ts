import { app, shell, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import { initDb, db } from "./db";

// ---------- helpers ----------
function registerHandle(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
) {
  // В dev при пересборках легко получить "Attempted to register a second handler"
  // Поэтому всегда снимаем предыдущий, если он был
  try {
    ipcMain.removeHandler(channel);
  } catch {
    // ignore
  }
  ipcMain.handle(channel, handler);
}

function clampInt(v: any, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toISO(d: Date) {
  return d.toISOString();
}

function ymdToDate(ymd: string) {
  // ymd = YYYY-MM-DD
  const [y, m, d] = ymd.split("-").map((x) => Number(x));
  return new Date(y, (m || 1) - 1, d || 1);
}

function isLateByDays(deadlineYmd: string, finishedISO: string) {
  // считаем "опоздание" по календарным дням
  const deadline = ymdToDate(deadlineYmd);
  const finished = new Date(finishedISO);
  const diffMs = finished.getTime() - deadline.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function basePoints(sessionType: string) {
  switch (sessionType) {
    case "race":
      return 25;
    case "sprint":
      return 8;
    case "qualifying":
      return 3;
    case "pit":
      return 2;
    case "practice":
      return 1;
    case "parc":
      return 1;
    default:
      return 0;
  }
}

async function fetchJson(url: string, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- window ----------
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---------- main ----------
app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // DB init (создаёт таблицы / миграции)
  initDb();

  // ------------------------------------------------------------
  // IPC: Tasks (SQLite)
  // ------------------------------------------------------------
  registerHandle("tasks:list", async () => {
    return db.prepare("SELECT * FROM tasks ORDER BY id DESC").all();
  });

  registerHandle("tasks:create", async (_event, payload: any) => {
    const now = toISO(new Date());

    const title = String(payload?.title ?? "").trim();
    if (!title) throw new Error("title is required");

    const session_type = String(payload?.session_type ?? "sprint");
    const status = String(payload?.status ?? "start");
    const laps_total = clampInt(payload?.laps_total ?? 1, 1, 999);
    const laps_done = clampInt(payload?.laps_done ?? 0, 0, laps_total);
    const deadline = payload?.deadline ?? null;

    const info = db
      .prepare(
        `INSERT INTO tasks
        (title, session_type, status, laps_total, laps_done, created_at, deadline,
         points_base, points_bonus, points_penalty, points_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`
      )
      .run(title, session_type, status, laps_total, laps_done, now, deadline);

    return { id: Number(info.lastInsertRowid) };
  });

  registerHandle("tasks:update", async (_event, payload: any) => {
    const id = Number(payload?.id);
    if (!id) throw new Error("id is required");

    // разрешаем обновлять только то, что реально пришло
    const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!current) throw new Error("task not found");

    const title =
      payload?.title !== undefined ? String(payload.title).trim() : current.title;

    const session_type =
      payload?.session_type !== undefined
        ? String(payload.session_type)
        : current.session_type;

    const status =
      payload?.status !== undefined ? String(payload.status) : current.status;

    const laps_total =
      payload?.laps_total !== undefined
        ? clampInt(payload.laps_total, 1, 999)
        : Number(current.laps_total ?? 1);

    const laps_done =
      payload?.laps_done !== undefined
        ? clampInt(payload.laps_done, 0, laps_total)
        : Number(current.laps_done ?? 0);

    const deadline =
      payload?.deadline !== undefined ? payload.deadline : current.deadline;

    db.prepare(
      `UPDATE tasks
       SET title = ?, session_type = ?, status = ?, laps_total = ?, laps_done = ?, deadline = ?
       WHERE id = ?`
    ).run(title, session_type, status, laps_total, laps_done, deadline, id);

    return { ok: true };
  });

  registerHandle("tasks:finish", async (_event, id: number) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!task) throw new Error("task not found");

    const finishedAt = toISO(new Date());
    const base = basePoints(String(task.session_type));

    let penalty = 0;
    if (task.deadline) {
      const lateDays = isLateByDays(String(task.deadline), finishedAt);
      if (lateDays >= 3) penalty -= 5; // "авария" / сильное опоздание
    }

    const total = base + penalty;

    db.prepare(
      `UPDATE tasks
       SET status = 'finish',
           finished_at = ?,
           points_base = ?,
           points_bonus = 0,
           points_penalty = ?,
           points_total = ?
       WHERE id = ?`
    ).run(finishedAt, base, penalty, total, id);

    return { ok: true };
  });

  registerHandle("tasks:dnf", async (_event, id: number) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!task) throw new Error("task not found");

    const finishedAt = toISO(new Date());
    const penalty = -5;

    db.prepare(
      `UPDATE tasks
       SET status = 'dnf',
           finished_at = ?,
           points_base = 0,
           points_bonus = 0,
           points_penalty = ?,
           points_total = ?
       WHERE id = ?`
    ).run(finishedAt, penalty, penalty, id);

    return { ok: true };
  });

  registerHandle("tasks:delete", async (_event, id: number) => {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return { ok: true };
  });

  // ------------------------------------------------------------
  // IPC: F1 ближайший GP (main -> renderer), без CSP проблем
  // Канал ровно один: "f1:next"
  // ------------------------------------------------------------
  // На всякий случай подчистим старые/случайные каналы:
  try { ipcMain.removeHandler("f1:nextGp"); } catch {}
  try { ipcMain.removeHandler("f1:nextRace"); } catch {}

  registerHandle("f1:next", async () => {
    const endpoints = [
      "https://api.jolpi.ca/ergast/f1/current/next.json",
      "https://ergast.com/api/f1/current/next.json",
    ];

    let lastErr: any = null;

    for (const url of endpoints) {
      try {
        const data = await fetchJson(url);

        const race = data?.MRData?.RaceTable?.Races?.[0];
        if (!race) throw new Error("No races in response");

        const raceName = String(race.raceName || "Grand Prix");
        const locality = String(race?.Circuit?.Location?.locality || "");
        const country = String(race?.Circuit?.Location?.country || "");
        const location = [locality, country].filter(Boolean).join(", ");

        const date = String(race.date); // YYYY-MM-DD
        const time = String(race.time || "00:00:00Z");
        const dateTimeISO = `${date}T${time}`;

        return { name: raceName, location, dateTimeISO };
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`Failed to fetch next GP: ${String(lastErr?.message ?? lastErr)}`);
  });

  // create window
  createWindow();

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
