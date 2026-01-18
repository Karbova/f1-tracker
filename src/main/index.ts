import { app, shell, BrowserWindow, ipcMain, Notification } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import { initDb, db } from "./db";
import { autoUpdater } from "electron-updater";
import log from "electron-log";


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
autoUpdater.logger = log;
(autoUpdater.logger as any).transports.file.level = "info";

// чтобы на Windows искал latest.yml в GitHub Releases
autoUpdater.autoDownload = true;

const notifTimers = new Map<number, NodeJS.Timeout>();

function clearNotif(id: number) {
  const t = notifTimers.get(id);
  if (t) clearTimeout(t);
  notifTimers.delete(id);
}

function scheduleDeadlineNotif(task: any) {
  // ожидаем: task.id, task.title, task.deadline (YYYY-MM-DD)
  clearNotif(Number(task.id));

  if (!task.deadline) return;
  if (task.status === "finish" || task.status === "dnf") return;

  // напоминание в 10:00 утра в день дедлайна (можно поменять)
  const target = new Date(`${task.deadline}T10:00:00`);
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return;

  notifTimers.set(
    Number(task.id),
    setTimeout(() => {
      if (Notification.isSupported()) {
        new Notification({
          title: "⏰ Дедлайн сегодня",
          body: task.title,
        }).show();
      }
      clearNotif(Number(task.id));
    }, ms)
  );
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
  autoUpdater.checkForUpdatesAndNotify();

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

  ipcMain.handle("update:check", async () => {
    return await autoUpdater.checkForUpdates();
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
          points_session_type,
          points_base, points_bonus, points_penalty, points_total)
        VALUES (?, ?, ?, ?, ?, ?, ?,
                ?,
                0, 0, 0, 0)`
      )
      .run(title, session_type, status, laps_total, laps_done, now, deadline, session_type);
      const created = db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid);
scheduleDeadlineNotif(created);

    return { id: Number(info.lastInsertRowid) };
  });

  registerHandle("tasks:rescheduleNotifications", async () => {
    // перечитаем все задачи и поставим таймеры заново
    const all = db.prepare("SELECT * FROM tasks").all();
    for (const t of all) scheduleDeadlineNotif(t);
    return { ok: true };
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

    let pointsSessionType = current.points_session_type ?? current.session_type;

      // если задача еще активная — меняем “категорию очков” вместе с колонкой
    const doneNow = status === "finish" || status === "dnf";
    if (!doneNow && payload?.session_type !== undefined) {
        pointsSessionType = session_type;
    }

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
         SET title = ?, session_type = ?, status = ?, laps_total = ?, laps_done = ?, deadline = ?,
             points_session_type = ?
         WHERE id = ?`
      ).run(title, session_type, status, laps_total, laps_done, deadline, pointsSessionType, id);
    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(payload.id);
scheduleDeadlineNotif(updated);

    return { ok: true };
  });

  registerHandle("tasks:finish", async (_event, id: number) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!task) throw new Error("task not found");

    const finishedAt = toISO(new Date());

    const scoreType = String(task.points_session_type || task.session_type); // категория очков
    const base = basePoints(scoreType); // ✅ начисляем по категории очков, а не по session_type
    let penalty = 0;
    if (task.deadline) {
      const lateDays = isLateByDays(String(task.deadline), finishedAt);
      if (lateDays >= 3) penalty -= 5; // "авария" / сильное опоздание
    }

    const total = base + penalty;

    db.prepare(
      `UPDATE tasks
       SET status = 'finish',
           session_type = 'parc',
           finished_at = ?,
           points_base = ?,
           points_bonus = 0,
           points_penalty = ?,
           points_total = ?
       WHERE id = ?`
    ).run(finishedAt, base, penalty, total, id);
    clearNotif(id);

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
           session_type = 'parc',
           finished_at = ?,
           points_base = 0,
           points_bonus = 0,
           points_penalty = ?,
           points_total = ?
       WHERE id = ?`
    ).run(finishedAt, penalty, penalty, id);
    clearNotif(id);

    return { ok: true };
  });

  registerHandle("tasks:delete", async (_event, id: number) => {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    clearNotif(id);
    return { ok: true };

  });

  registerHandle("calendar:list", async () => {
    return db.prepare("SELECT * FROM calendar_events ORDER BY start_date DESC, start_time DESC, id DESC").all();
  });
  
  registerHandle("calendar:create", async (_e, payload: any) => {
    const now = new Date().toISOString();
  
    const info = db
      .prepare(
        `INSERT INTO calendar_events
          (title, start_date, start_time, end_time, location, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.title,
        payload.start_date,
        payload.start_time ?? null,
        payload.end_time ?? null,
        payload.location ?? null,
        payload.notes ?? null,
        now
      );
  
    return db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(info.lastInsertRowid);
  });
  
  registerHandle("calendar:delete", async (_e, id: number) => {
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
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

  type F1Race = {
    round: number;
    raceName: string;
    circuitName: string;
    locality: string;
    country: string;
    date: string;        // YYYY-MM-DD
    dateTimeISO: string; // YYYY-MM-DDTHH:MM:SSZ
  };
  
  registerHandle("f1:schedule", async (_event, season: string | number = "current") => {
    const url = `https://api.jolpi.ca/ergast/f1/${season}.json`;
  
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  
    const data = await res.json();
    const races = data?.MRData?.RaceTable?.Races ?? [];
  
    const out: F1Race[] = races.map((r: any) => {
      const date = String(r.date);
      const time = r.time ? String(r.time) : "00:00:00Z";
      return {
        round: Number(r.round),
        raceName: String(r.raceName || "Grand Prix"),
        circuitName: String(r?.Circuit?.circuitName || ""),
        locality: String(r?.Circuit?.Location?.locality || ""),
        country: String(r?.Circuit?.Location?.country || ""),
        date,
        dateTimeISO: `${date}T${time}`,
      };
    });
  
    return out;
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
