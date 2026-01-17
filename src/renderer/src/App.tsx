import React, { useEffect, useMemo, useRef, useState } from "react";

type SessionType = "practice" | "qualifying" | "sprint" | "race" | "pit" | "parc";
type Status = "start" | "progress" | "finish" | "dnf";

type Task = {
  id: number;
  title: string;
  session_type: SessionType;
  status: Status;
  laps_total: number;
  laps_done: number;
  deadline?: string | null; // YYYY-MM-DD
  points_total?: number | null;
};

type NextGp = {
  name: string;
  location: string;
  dateTimeISO: string;
};

type F1Race = {
  round: number;
  raceName: string;
  circuitName: string;
  locality: string;
  country: string;
  date: string; // YYYY-MM-DD
  dateTimeISO: string; // YYYY-MM-DDTHH:MM:SSZ
};

type CalendarEvent = {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  startTime?: string;
  endTime?: string;
  location?: string;
  notes?: string;
  createdAt: string;
};

// ---- window.api typing (минимально) ----
declare global {
  interface Window {
    api: {
      listTasks: () => Promise<Task[]>;
      createTask: (payload: any) => Promise<any>;
      updateTask: (payload: any) => Promise<any>;
      deleteTask: (id: number) => Promise<any>;
      finishTask: (id: number) => Promise<any>;
      dnfTask: (id: number) => Promise<any>;
      getNextGp: () => Promise<NextGp>;
      getF1Schedule: (season?: string | number) => Promise<F1Race[]>;
    };
  }
}

function clampInt(v: any, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function toYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function fmtRuDate(ymd: string) {
  const [y, m, d] = ymd.split("-");
  return `${d}.${m}.${y}`;
}

function formatCountdown(targetISO: string) {
  const target = new Date(targetISO).getTime();
  const now = Date.now();
  const diff = Math.max(0, target - now);

  const sec = Math.floor(diff / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  return `${days}д ${hours}ч ${mins}м ${s}с`;
}

function sessionLabel(s: SessionType) {
  switch (s) {
    case "practice":
      return "Practice";
    case "qualifying":
      return "Qualifying";
    case "sprint":
      return "Sprint";
    case "race":
      return "Race Day";
    case "pit":
      return "Pit Stop";
    case "parc":
      return "Parc Fermé";
  }
}

function sessionHint(s: SessionType) {
  switch (s) {
    case "practice":
      return "Несрочно, подготовка";
    case "qualifying":
      return "Важно для результата завтра";
    case "sprint":
      return "Срочно, сделать сегодня";
    case "race":
      return "Главные и сложные задачи";
    case "pit":
      return "Мелкие быстрые дела";
    case "parc":
      return "Завершённое / ретро / обслуживание";
  }
}

function sessionDot(s: SessionType) {
  switch (s) {
    case "practice":
      return "🟢";
    case "qualifying":
      return "🟡";
    case "sprint":
      return "🔴";
    case "race":
      return "🏁";
    case "pit":
      return "⬛";
    case "parc":
      return "🔧";
  }
}

function statusText(st: Status) {
  if (st === "finish") return "FINISH";
  if (st === "dnf") return "DNF";
  if (st === "progress") return "PROG";
  return "START";
}

// localStorage keys
const LS_PAGE = "f1_page";
const LS_EVENTS = "f1_calendar_events";
const LS_GP_CACHE = "f1_next_gp_cache_v2";
const LS_SHOW_PARC = "f1_show_parc";
const LS_F1_SCHEDULE_CACHE = "f1_schedule_cache_v1";

type Page = "tracker" | "calendar";

export default function App() {
  // -------- navigation --------
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem(LS_PAGE);
    return saved === "calendar" ? "calendar" : "tracker";
  });
  useEffect(() => {
    localStorage.setItem(LS_PAGE, page);
  }, [page]);

  // -------- tasks (SQLite) --------
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const [showParc, setShowParc] = useState<boolean>(() => {
    const raw = localStorage.getItem(LS_SHOW_PARC);
    if (raw === "0") return false;
    return true;
  });
  useEffect(() => {
    localStorage.setItem(LS_SHOW_PARC, showParc ? "1" : "0");
  }, [showParc]);

  async function reloadTasks() {
    setLoadingTasks(true);
    try {
      const rows = await window.api.listTasks();
      setTasks(rows || []);
    } finally {
      setLoadingTasks(false);
    }
  }

  useEffect(() => {
    reloadTasks();
  }, []);

  // -------- next GP via IPC --------
  const [nextGp, setNextGp] = useState<NextGp | null>(null);
  const [gpError, setGpError] = useState<string | null>(null);
  const [gpTick, setGpTick] = useState(0);

  function loadF1Cache(): NextGp | null {
    try {
      const raw = localStorage.getItem(LS_GP_CACHE);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj?.data) return null;
      const age = Date.now() - Number(obj.ts || 0);
      if (age > 24 * 3600 * 1000) return null;
      return obj.data as NextGp;
    } catch {
      return null;
    }
  }

  function saveF1Cache(data: NextGp) {
    try {
      localStorage.setItem(LS_GP_CACHE, JSON.stringify({ ts: Date.now(), data }));
    } catch {
      // ignore
    }
  }

  async function fetchNextGp() {
    try {
      setGpError(null);

      const next = await window.api.getNextGp();
      setNextGp(next);
      saveF1Cache(next);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "Failed to fetch";
      setGpError(msg);
    }
  }

  useEffect(() => {
    const cached = loadF1Cache();
    if (cached) setNextGp(cached);
    else fetchNextGp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live countdown tick
  useEffect(() => {
    const t = setInterval(() => setGpTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // -------- tracker add form --------
  const [title, setTitle] = useState("");
  const [session, setSession] = useState<SessionType>("sprint");
  const [lapsTotal, setLapsTotal] = useState<number>(1);

  async function addTask() {
    const t = title.trim();
    if (!t) return;

    const lt = clampInt(lapsTotal || 1, 1, 999);

    await window.api.createTask({
      title: t,
      session_type: session,
      status: "start",
      laps_total: lt,
      laps_done: 0,
      deadline: null,
    });

    setTitle("");
    setLapsTotal(1);
    await reloadTasks();
  }

  async function finishTask(id: number) {
    await window.api.finishTask(id);
    await reloadTasks();
  }

  async function dnfTask(id: number) {
    await window.api.dnfTask(id);
    await reloadTasks();
  }

  async function deleteTask(id: number) {
    await window.api.deleteTask(id);
    await reloadTasks();
  }

  async function incLap(task: Task) {
    const nextDone = clampInt(task.laps_done + 1, 0, task.laps_total);
    const nextStatus: Status = "progress";

    // локально (быстро)
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, laps_done: nextDone, status: nextStatus } : t))
    );

    // в БД
    await window.api.updateTask({
      id: task.id,
      laps_done: nextDone,
      status: nextStatus,
    });
  }

  // -------- title editing (fix 1-char bug) --------
  const [draftTitle, setDraftTitle] = useState<Record<number, string>>({});

  function getTitleValue(t: Task) {
    return draftTitle[t.id] ?? t.title;
  }

  async function saveTitleToDb(id: number) {
    const v = (draftTitle[id] ?? "").trim();
    if (!v) {
      setDraftTitle((p) => {
        const copy = { ...p };
        delete copy[id];
        return copy;
      });
      return;
    }

    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, title: v } : x)));
    await window.api.updateTask({ id, title: v });

    setDraftTitle((p) => {
      const copy = { ...p };
      delete copy[id];
      return copy;
    });
  }

  // -------- points chips --------
  const points = useMemo(() => {
    const total = tasks.reduce((sum, t) => sum + Number(t.points_total ?? 0), 0);

    const bySession: Record<SessionType, number> = {
      practice: 0,
      qualifying: 0,
      sprint: 0,
      race: 0,
      pit: 0,
      parc: 0,
    };

    for (const t of tasks) {
      const k = t.session_type;
      bySession[k] = (bySession[k] ?? 0) + Number(t.points_total ?? 0);
    }
    return { total, bySession };
  }, [tasks]);

  // -------- grouped tasks for columns --------
  const grouped = useMemo(() => {
    const map: Record<SessionType, Task[]> = {
      practice: [],
      qualifying: [],
      sprint: [],
      race: [],
      pit: [],
      parc: [],
    };

    for (const t of tasks) {
      const done = t.status === "finish" || t.status === "dnf";
      if (done) {
        map.parc.push(t);
        continue;
      }
      (map[t.session_type] ?? map.practice).push(t);
    }

    return map;
  }, [tasks]);

  // -------- calendar state (localStorage) --------
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    try {
      const raw = localStorage.getItem(LS_EVENTS);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr as CalendarEvent[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(LS_EVENTS, JSON.stringify(events));
    } catch {
      // ignore
    }
  }, [events]);

  // -------- F1 schedule (Calendar only) --------
  const [f1Races, setF1Races] = useState<F1Race[]>(() => {
    try {
      const raw = localStorage.getItem(LS_F1_SCHEDULE_CACHE);
      if (!raw) return [];
      const obj = JSON.parse(raw);
      const age = Date.now() - Number(obj.ts || 0);
      if (age > 24 * 3600 * 1000) return [];
      return (obj.data || []) as F1Race[];
    } catch {
      return [];
    }
  });
  const [f1Err, setF1Err] = useState<string | null>(null);

  async function loadF1Schedule() {
    try {
      setF1Err(null);
      const races = await window.api.getF1Schedule("current");
      setF1Races(races || []);
      try {
        localStorage.setItem(LS_F1_SCHEDULE_CACHE, JSON.stringify({ ts: Date.now(), data: races || [] }));
      } catch {}
    } catch (e: any) {
      setF1Err(e?.message ? String(e.message) : "Failed to load F1 schedule");
    }
  }

  useEffect(() => {
    if (page === "calendar" && f1Races.length === 0) {
      loadF1Schedule();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const f1ByDate = useMemo(() => {
    const m = new Map<string, F1Race[]>();
    for (const r of f1Races) {
      const arr = m.get(r.date) ?? [];
      arr.push(r);
      m.set(r.date, arr);
    }
    return m;
  }, [f1Races]);

  // -------- calendar month & selection --------
  const [calMonth, setCalMonth] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string>(() => toYMD(new Date()));

  const monthTitle = useMemo(() => {
    const ru = [
      "Январь",
      "Февраль",
      "Март",
      "Апрель",
      "Май",
      "Июнь",
      "Июль",
      "Август",
      "Сентябрь",
      "Октябрь",
      "Ноябрь",
      "Декабрь",
    ];
    const m = calMonth.getMonth();
    const y = calMonth.getFullYear();
    return `${ru[m]} ${y} г.`;
  }, [calMonth]);

  const calendarGrid = useMemo(() => {
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    const startDow = (first.getDay() + 6) % 7; // Mon=0
    const start = new Date(first);
    start.setDate(first.getDate() - startDow);

    const days: {
      date: string;
      inMonth: boolean;
      isToday: boolean;
      hasEvents: boolean;
      hasF1: boolean;
    }[] = [];

    const today = toYMD(new Date());

    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const ymd = toYMD(d);

      const inMonth = d.getMonth() === calMonth.getMonth();
      const isToday = ymd === today;
      const hasEvents = events.some((ev) => ev.date === ymd);
      const hasF1 = (f1ByDate.get(ymd)?.length ?? 0) > 0;

      days.push({ date: ymd, inMonth, isToday, hasEvents, hasF1 });
    }
    return days;
  }, [calMonth, events, f1ByDate]);

  const dayEvents = useMemo(() => {
    return events
      .filter((e) => e.date === selectedDay)
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
  }, [events, selectedDay]);

  const dayF1 = useMemo(() => f1ByDate.get(selectedDay) ?? [], [f1ByDate, selectedDay]);

  // calendar form
  const [evTitle, setEvTitle] = useState("");
  const [evStart, setEvStart] = useState("");
  const [evEnd, setEvEnd] = useState("");
  const [evLoc, setEvLoc] = useState("");
  const [evNotes, setEvNotes] = useState("");

  function addEvent() {
    const t = evTitle.trim();
    if (!t) return;

    const newEv: CalendarEvent = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      title: t,
      date: selectedDay,
      startTime: evStart || undefined,
      endTime: evEnd || undefined,
      location: evLoc.trim() || undefined,
      notes: evNotes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    setEvents((prev) => [newEv, ...prev]);
    setEvTitle("");
    setEvStart("");
    setEvEnd("");
    setEvLoc("");
    setEvNotes("");
  }

  function deleteEvent(id: string) {
    setEvents((prev) => prev.filter((e) => e.id !== id));
  }

  function goPrevMonth() {
    setCalMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }
  function goNextMonth() {
    setCalMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }
  function goToday() {
    const d = new Date();
    setCalMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelectedDay(toYMD(d));
  }

  // ---------- UI ----------
  const isTracker = page === "tracker";

  return (
    <div style={styles.app}>
      {/* header */}
      <div style={styles.topBar}>
        <div>
          <div style={styles.h1}>F1 Personal Championship</div>
          <div style={styles.sub}>{isTracker ? "Race Weekend — твои задачи как гоночный уик-энд" : "Личный календарь"}</div>
        </div>

        <div style={styles.tabs}>
          <button
            style={page === "tracker" ? { ...styles.tab, ...styles.tabActive } : styles.tab}
            onClick={() => setPage("tracker")}
          >
            🏁 Tracker
          </button>
          <button
            style={page === "calendar" ? { ...styles.tab, ...styles.tabActive } : styles.tab}
            onClick={() => setPage("calendar")}
          >
            📅 Calendar
          </button>
        </div>
      </div>

      {/* TRACKER PAGE */}
      {isTracker && (
        <>
          {/* Next GP widget (tracker) */}
          <div style={styles.gpWrap}>
            <div style={styles.gpCard}>
              <div style={styles.gpTitle}>🗓️ Ближайший GP</div>

              {gpError ? (
                <div style={styles.gpErr}>Не удалось загрузить: {gpError}</div>
              ) : nextGp ? (
                <>
                  <div style={styles.gpName}>{nextGp.name}</div>
                  <div style={styles.gpLoc}>{nextGp.location}</div>
                  <div style={styles.gpCountdown}>
                    ⏱️ {formatCountdown(nextGp.dateTimeISO)} <span style={styles.gpCountdownSmall}>({gpTick})</span>
                  </div>
                </>
              ) : (
                <div style={styles.gpErr}>Загрузка…</div>
              )}

              <button style={styles.smallGhostBtn} onClick={fetchNextGp}>
                Обновить
              </button>
            </div>
          </div>

          {/* add task row */}
          <div style={styles.row}>
            <input
              style={styles.input}
              placeholder="Новая задача..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <select style={styles.select} value={session} onChange={(e) => setSession(e.target.value as SessionType)}>
              <option value="practice">🟢 Practice</option>
              <option value="qualifying">🟡 Qualifying</option>
              <option value="sprint">🔴 Sprint</option>
              <option value="race">🏁 Race Day</option>
              <option value="pit">⬛ Pit Stop</option>
              <option value="parc">🔧 Parc Fermé</option>
            </select>

            <input
              style={styles.lapsInput}
              type="number"
              min={1}
              max={999}
              value={lapsTotal}
              onChange={(e) => setLapsTotal(clampInt(e.target.value, 1, 999))}
            />

            <button style={styles.addBtn} onClick={addTask}>
              Add
            </button>
          </div>

          {/* points chips */}
          <div style={styles.chips}>
            <div style={styles.chip}>🏆 Total points: {points.total}</div>
            <div style={styles.chip}>🟢 Practice: {points.bySession.practice}</div>
            <div style={styles.chip}>🟡 Qualifying: {points.bySession.qualifying}</div>
            <div style={styles.chip}>🔴 Sprint: {points.bySession.sprint}</div>
            <div style={styles.chip}>🏁 Race Day: {points.bySession.race}</div>
            <div style={styles.chip}>⬛ Pit Stop: {points.bySession.pit}</div>
            <div style={styles.chip}>🔧 Parc Fermé: {points.bySession.parc}</div>
            {loadingTasks && <div style={styles.chipMuted}>loading…</div>}
          </div>

          {/* hide/show Parc Fermé */}
          <div style={{ marginBottom: 10 }}>
            <button style={styles.smallBtn} onClick={() => setShowParc((v) => !v)} type="button">
              {showParc ? "Скрыть Parc Fermé" : "Показать Parc Fermé"}
            </button>
          </div>

          {/* columns */}
          <div style={styles.grid}>
            <Column
              title="Practice"
              dot="🟢"
              hint={sessionHint("practice")}
              tasks={grouped.practice}
              render={(t) => (
                <TaskCard
                  t={t}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  getTitleValue={getTitleValue}
                  saveTitleToDb={saveTitleToDb}
                  setTasks={setTasks}
                  incLap={incLap}
                  finishTask={finishTask}
                  dnfTask={dnfTask}
                  deleteTask={deleteTask}
                />
              )}
            />

            <Column
              title="Qualifying"
              dot="🟡"
              hint={sessionHint("qualifying")}
              tasks={grouped.qualifying}
              render={(t) => (
                <TaskCard
                  t={t}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  getTitleValue={getTitleValue}
                  saveTitleToDb={saveTitleToDb}
                  setTasks={setTasks}
                  incLap={incLap}
                  finishTask={finishTask}
                  dnfTask={dnfTask}
                  deleteTask={deleteTask}
                />
              )}
            />

            <Column
              title="Sprint"
              dot="🔴"
              hint={sessionHint("sprint")}
              tasks={grouped.sprint}
              render={(t) => (
                <TaskCard
                  t={t}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  getTitleValue={getTitleValue}
                  saveTitleToDb={saveTitleToDb}
                  setTasks={setTasks}
                  incLap={incLap}
                  finishTask={finishTask}
                  dnfTask={dnfTask}
                  deleteTask={deleteTask}
                />
              )}
            />

            <Column
              title="Race Day"
              dot="🏁"
              hint={sessionHint("race")}
              tasks={grouped.race}
              render={(t) => (
                <TaskCard
                  t={t}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  getTitleValue={getTitleValue}
                  saveTitleToDb={saveTitleToDb}
                  setTasks={setTasks}
                  incLap={incLap}
                  finishTask={finishTask}
                  dnfTask={dnfTask}
                  deleteTask={deleteTask}
                />
              )}
            />

            <Column
              title="Pit Stop"
              dot="⬛"
              hint={sessionHint("pit")}
              tasks={grouped.pit}
              render={(t) => (
                <TaskCard
                  t={t}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  getTitleValue={getTitleValue}
                  saveTitleToDb={saveTitleToDb}
                  setTasks={setTasks}
                  incLap={incLap}
                  finishTask={finishTask}
                  dnfTask={dnfTask}
                  deleteTask={deleteTask}
                />
              )}
            />

            {showParc && (
              <Column
                title="Parc Fermé"
                dot="🔧"
                hint={sessionHint("parc")}
                tasks={grouped.parc}
                render={(t) => (
                  <TaskCard
                    t={t}
                    draftTitle={draftTitle}
                    setDraftTitle={setDraftTitle}
                    getTitleValue={getTitleValue}
                    saveTitleToDb={saveTitleToDb}
                    setTasks={setTasks}
                    incLap={incLap}
                    finishTask={finishTask}
                    dnfTask={dnfTask}
                    deleteTask={deleteTask}
                  />
                )}
              />
            )}
          </div>

          <div style={styles.footer}>Подсказка: заголовок задачи сохраняется в SQLite при уходе с поля.</div>
        </>
      )}

      {/* CALENDAR PAGE */}
      {!isTracker && (
        <>
          <div style={styles.calendarLayout}>
            {/* left calendar */}
            <div style={styles.calendarLeft}>
              <div style={styles.calendarHeader}>
                <div style={styles.calTitle}>🗓️ {monthTitle}</div>
                <div style={styles.calNav}>
                  <button style={styles.navBtn} onClick={goPrevMonth}>
                    ←
                  </button>
                  <button style={styles.navBtn} onClick={goToday}>
                    Сегодня
                  </button>
                  <button style={styles.navBtn} onClick={goNextMonth}>
                    →
                  </button>
                </div>
              </div>

              <div style={styles.dowRow}>
                {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
                  <div key={d} style={styles.dow}>
                    {d}
                  </div>
                ))}
              </div>

              <div style={styles.calendarGrid}>
                {calendarGrid.map((cell) => (
                  <button
                    key={cell.date}
                    style={{
                      ...styles.dayCell,
                      ...(cell.inMonth ? {} : styles.dayCellOut),
                      ...(cell.date === selectedDay ? styles.dayCellSelected : {}),
                    }}
                    onClick={() => setSelectedDay(cell.date)}
                    title={fmtRuDate(cell.date)}
                  >
                    <div style={styles.dayNumRow}>
                      <div style={styles.dayNum}>{Number(cell.date.split("-")[2])}</div>
                      {cell.isToday && <div style={styles.todayPill}>today</div>}
                    </div>

                    {cell.hasEvents && <div style={styles.eventDot} title="Личные события" />}
                    {cell.hasF1 && <div style={styles.f1Dot} title="F1 GP" />}
                  </button>
                ))}
              </div>

              <div style={styles.noteSmall}>
                ● жёлтая точка = твои события, ● красная точка = F1 GP
              </div>
            </div>

            {/* right panel */}
            <div style={styles.calendarRight}>
              <div style={styles.panelCard}>
                <div style={styles.panelTitle}>📌 Событие на {selectedDay}</div>

                <input
                  style={styles.input}
                  placeholder="Название события..."
                  value={evTitle}
                  onChange={(e) => setEvTitle(e.target.value)}
                />

                <div style={styles.row2}>
                  <input style={styles.timeInput} type="time" value={evStart} onChange={(e) => setEvStart(e.target.value)} />
                  <input style={styles.timeInput} type="time" value={evEnd} onChange={(e) => setEvEnd(e.target.value)} />
                  <button style={styles.addBtn} onClick={addEvent}>
                    Добавить
                  </button>
                </div>

                <input
                  style={styles.input}
                  placeholder="Локация (опционально)..."
                  value={evLoc}
                  onChange={(e) => setEvLoc(e.target.value)}
                />

                <textarea
                  style={styles.notesArea}
                  placeholder="Заметки (опционально)…"
                  value={evNotes}
                  onChange={(e) => setEvNotes(e.target.value)}
                  rows={4}
                />

                {/* F1 today */}
                <div style={styles.panelSubTitleRow}>
                  <div style={styles.panelSubTitle}>🏎️ F1 в этот день</div>
                  <button style={styles.smallGhostBtn} onClick={loadF1Schedule} type="button">
                    Обновить F1
                  </button>
                </div>

                {f1Err ? (
                  <div style={styles.gpErr}>F1: {f1Err}</div>
                ) : dayF1.length === 0 ? (
                  <div style={styles.empty}>Нет гонки</div>
                ) : (
                  <div style={styles.eventList}>
                    {dayF1.map((r) => (
                      <div key={`${r.round}_${r.date}`} style={styles.eventItem}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={styles.eventTitle}>🏁 #{r.round} {r.raceName}</div>
                          <div style={styles.eventMeta}>
                            {r.locality}{r.country ? `, ${r.country}` : ""} · {r.circuitName}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* personal events */}
                <div style={styles.panelSubTitle}>События дня</div>

                {dayEvents.length === 0 ? (
                  <div style={styles.empty}>Нет событий</div>
                ) : (
                  <div style={styles.eventList}>
                    {dayEvents.map((ev) => (
                      <div key={ev.id} style={styles.eventItem}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={styles.eventTitle}>{ev.title}</div>
                          <div style={styles.eventMeta}>
                            {ev.startTime || ev.endTime ? (
                              <span>
                                {ev.startTime || "--:--"}–{ev.endTime || "--:--"}
                              </span>
                            ) : (
                              <span>--:--</span>
                            )}
                            {ev.location ? <span> · {ev.location}</span> : null}
                          </div>
                        </div>
                        <button style={styles.eventDelBtn} onClick={() => deleteEvent(ev.id)}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={styles.noteSmall}>Личные события сохраняются локально (localStorage).</div>
              </div>

              {/* Next GP widget (calendar) */}
              <div style={styles.gpCardSmall}>
                <div style={styles.gpTitleSmall}>🗓️ Ближайший GP</div>

                {gpError ? (
                  <div style={styles.gpErr}>Не удалось загрузить: {gpError}</div>
                ) : nextGp ? (
                  <>
                    <div style={styles.gpNameSmall}>{nextGp.name}</div>
                    <div style={styles.gpLocSmall}>{nextGp.location}</div>
                    <div style={styles.gpCountdownSmallRow}>⏱️ {formatCountdown(nextGp.dateTimeISO)}</div>
                  </>
                ) : (
                  <div style={styles.gpErr}>Загрузка…</div>
                )}

                <button style={styles.smallGhostBtn} onClick={fetchNextGp}>
                  Обновить
                </button>
              </div>
            </div>
          </div>

          <div style={styles.footer}>
            Примечание: F1 расписание грузится только на вкладке Calendar (через IPC), точки отмечают дни GP.
          </div>
        </>
      )}
    </div>
  );
}

// ---------- components ----------
function Column(props: {
  title: string;
  dot: string;
  hint: string;
  tasks: Task[];
  render: (t: Task) => React.ReactNode;
}) {
  return (
    <div style={styles.column}>
      <div style={styles.columnHeader}>
        <div style={styles.columnTitle}>
          <span style={{ opacity: 0.95 }}>{props.dot}</span>
          <span>{props.title}</span>
        </div>
        <div style={styles.columnHint}>{props.hint}</div>
      </div>

      <div style={styles.cards}>
        {props.tasks.length === 0 ? <div style={styles.empty}>Пусто</div> : props.tasks.map((t) => props.render(t))}
      </div>
    </div>
  );
}

function TaskCard(props: {
  t: Task;
  draftTitle: Record<number, string>;
  setDraftTitle: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  getTitleValue: (t: Task) => string;
  saveTitleToDb: (id: number) => Promise<void>;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  incLap: (t: Task) => Promise<void>;
  finishTask: (id: number) => Promise<void>;
  dnfTask: (id: number) => Promise<void>;
  deleteTask: (id: number) => Promise<void>;
}) {
  const t = props.t;
  const val = props.getTitleValue(t);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [val]);

  return (
    <div style={styles.card}>
      <div style={styles.cardTop}>
        <textarea
          ref={areaRef}
          style={styles.titleArea}
          value={val}
          rows={1}
          onChange={(e) => {
            const v = e.target.value;
            props.setDraftTitle((p) => ({ ...p, [t.id]: v }));
          }}
          onBlur={() => props.saveTitleToDb(t.id)}
        />

        <div style={styles.badge(t.status)}>
          {statusText(t.status)} · Pts: {Number(t.points_total ?? 0)}
        </div>
      </div>

      <div style={styles.meta}>Laps {t.laps_done}/{t.laps_total}</div>

      <div style={styles.metaRow}>
        <div style={styles.metaLabel}>
          Deadline:
          <input
            style={styles.metaInput}
            type="date"
            value={t.deadline ? String(t.deadline) : ""}
            onChange={async (e) => {
              const v = e.target.value || null;
              props.setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, deadline: v } : x)));
              await window.api.updateTask({ id: t.id, deadline: v });
            }}
          />
        </div>
      </div>

      <div style={styles.actions}>
        <button onClick={() => props.incLap(t)} style={styles.smallBtn}>
          + Lap
        </button>

        <button
          onClick={() => props.finishTask(t.id)}
          style={styles.finishBtn}
          disabled={t.status === "finish" || t.status === "dnf"}
          title="Финишировать и начислить очки"
        >
          Finish
        </button>

        <button
          onClick={() => props.dnfTask(t.id)}
          style={styles.dnfBtn}
          disabled={t.status === "finish" || t.status === "dnf"}
          title="DNF"
        >
          DNF
        </button>

        <button onClick={() => props.deleteTask(t.id)} style={styles.dangerBtn} title="Удалить задачу">
          ×
        </button>
      </div>

      <div style={styles.actions}>
        <select
          style={styles.smallSelect}
          value={t.session_type}
          onChange={async (e) => {
            const v = e.target.value as SessionType;
            props.setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, session_type: v } : x)));
            await window.api.updateTask({ id: t.id, session_type: v });
          }}
        >
          <option value="practice">{sessionDot("practice")} {sessionLabel("practice")}</option>
          <option value="qualifying">{sessionDot("qualifying")} {sessionLabel("qualifying")}</option>
          <option value="sprint">{sessionDot("sprint")} {sessionLabel("sprint")}</option>
          <option value="race">{sessionDot("race")} {sessionLabel("race")}</option>
          <option value="pit">{sessionDot("pit")} {sessionLabel("pit")}</option>
          <option value="parc">{sessionDot("parc")} {sessionLabel("parc")}</option>
        </select>
      </div>
    </div>
  );
}

// ---------- styles ----------
const styles: Record<string, any> = {
  app: {
    height: "100vh",
    overflowY: "auto",
    padding: 18,
    boxSizing: "border-box",
    color: "#e8eefc",
  },

  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 12,
  },

  h1: { fontSize: 48, fontWeight: 900, letterSpacing: -1 },
  sub: { marginTop: 6, opacity: 0.8, fontSize: 18 },

  tabs: { display: "flex", gap: 10, alignItems: "center" },
  tab: {
    padding: "8px 12px",
    borderRadius: 12,
    fontWeight: 800,
    fontSize: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    cursor: "pointer",
  },
  tabActive: {
    border: "2px solid #f7c948",
    boxShadow: "0 0 0 4px rgba(247,201,72,0.12)",
  },

  gpWrap: { marginBottom: 10 },
  gpCard: {
    borderRadius: 18,
    padding: 12,
    border: "1px solid rgba(42,53,80,0.78)",
    background: "rgba(14,20,34,0.75)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
    maxWidth: 320,
  },
  gpTitle: { fontSize: 16, fontWeight: 900, opacity: 0.95 },
  gpName: { marginTop: 8, fontSize: 18, fontWeight: 900 },
  gpLoc: { marginTop: 4, opacity: 0.8, fontSize: 13 },
  gpCountdown: { marginTop: 8, fontSize: 15, display: "flex", gap: 8, alignItems: "center" },
  gpCountdownSmall: { opacity: 0.45, fontSize: 11 },
  gpErr: { marginTop: 8, opacity: 0.85, fontSize: 13, color: "#ffd6d6" },
  smallGhostBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#e8eefc",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 13,
  },

  row: { display: "flex", gap: 10, alignItems: "center", marginTop: 6, marginBottom: 10 },
  row2: { display: "flex", gap: 10, alignItems: "center", marginTop: 10, marginBottom: 10 },

  input: {
    flex: 1,
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 15,
    outline: "none",
  },

  select: {
    width: 220,
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 15,
  },

  lapsInput: {
    width: 90,
    padding: "12px 12px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 15,
  },

  addBtn: {
    padding: "12px 18px",
    borderRadius: 18,
    border: "2px solid #f7c948",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 16,
    minWidth: 120,
  },

  chips: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  chip: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(42,53,80,0.78)",
    background: "rgba(14,20,34,0.75)",
    fontWeight: 900,
    fontSize: 13,
  },
  chipMuted: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.20)",
    fontWeight: 700,
    fontSize: 13,
    opacity: 0.7,
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 12,
  },

  column: {
    borderRadius: 16,
    padding: 12,
    border: "1px solid rgba(42,53,80,0.78)",
    background: "rgba(14,20,34,0.72)",
    minHeight: 220,
  },
  columnHeader: { marginBottom: 10 },
  columnTitle: { display: "flex", gap: 10, fontWeight: 900, fontSize: 22, alignItems: "center" },
  columnHint: { marginTop: 6, opacity: 0.75, fontSize: 12 },

  cards: { display: "flex", flexDirection: "column", gap: 10 },
  empty: { opacity: 0.6, fontSize: 13, padding: 6 },

  card: {
    background: "rgba(6,8,14,0.85)",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 16,
    padding: 12,
  },
  cardTop: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" },

  titleArea: {
    flex: 1,
    minWidth: 0,
    fontWeight: 900,
    fontSize: 20,
    lineHeight: 1.15,
    border: "1px solid transparent",
    background: "transparent",
    color: "#e8eefc",
    outline: "none",
    padding: 0,
    resize: "none",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },

  meta: { marginTop: 8, opacity: 0.8, fontSize: 13 },

  metaRow: { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" },
  metaLabel: { fontSize: 13, opacity: 0.9, display: "flex", alignItems: "center", gap: 8 },
  metaInput: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 14,
  },

  badge: (status: string) => ({
    flexShrink: 0,
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.14)",
    background:
      status === "finish"
        ? "rgba(15, 42, 26, 0.65)"
        : status === "dnf"
        ? "rgba(42, 15, 15, 0.65)"
        : "rgba(26, 33, 54, 0.55)",
    opacity: 0.95,
    whiteSpace: "nowrap",
  }),

  actions: { display: "flex", gap: 10, marginTop: 10, alignItems: "center", flexWrap: "wrap" },

  smallBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 14,
  },

  finishBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(15, 42, 26, 0.65)",
    color: "#d6ffe1",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 14,
  },

  dnfBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(42, 15, 15, 0.65)",
    color: "#ffd6d6",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 14,
  },

  smallSelect: {
    flex: 1,
    minWidth: 200,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 14,
  },

  dangerBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(42, 15, 15, 0.65)",
    color: "#ffd6d6",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 16,
  },

  // calendar layout (stable, not shrinking on month changes)
  calendarLayout: {
    display: "grid",
    gridTemplateColumns: "minmax(620px, 1fr) minmax(360px, 520px)",
    gap: 14,
    alignItems: "start",
  },
  calendarLeft: {
    minWidth: 0,
    borderRadius: 18,
    padding: 12,
    width: "100%",
    justifySelf: "stretch",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.25)",
  },
  calendarRight: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },

  calendarHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    width: "100%",
    minWidth: 0,
  },
  calTitle: {
    fontSize: 22,
    fontWeight: 900,
    display: "flex",
    gap: 10,
    alignItems: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  calNav: { display: "flex", gap: 10, alignItems: "center", flexShrink: 0 },
  navBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 14,
  },

  dowRow: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10, marginBottom: 10 },
  dow: { opacity: 0.75, fontWeight: 800, fontSize: 13, textAlign: "center" },

  calendarGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10 },
  dayCell: {
    height: 74,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.18)",
    color: "#e8eefc",
    cursor: "pointer",
    textAlign: "left",
    padding: 10,
    position: "relative",
  },
  dayCellOut: { opacity: 0.35 },
  dayCellSelected: {
    border: "2px solid #f7c948",
    boxShadow: "0 0 0 4px rgba(247,201,72,0.10)",
  },
  dayNumRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  dayNum: { fontWeight: 900, fontSize: 14 },
  todayPill: {
    padding: "3px 8px",
    borderRadius: 999,
    fontSize: 11,
    opacity: 0.9,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
  },
  eventDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "#f7c948",
    position: "absolute",
    left: 10,
    bottom: 10,
  },
  f1Dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: "#ff4d4d",
    position: "absolute",
    right: 10,
    bottom: 10,
  },

  panelCard: {
    borderRadius: 18,
    padding: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.25)",
  },
  panelTitle: { fontSize: 22, fontWeight: 900, marginBottom: 10 },
  panelSubTitleRow: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginTop: 10 },
  panelSubTitle: { fontSize: 18, fontWeight: 900, opacity: 0.95 },

  timeInput: {
    flex: 1,
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 15,
    outline: "none",
  },

  notesArea: {
    width: "100%",
    marginTop: 10,
    padding: "12px 14px",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.35)",
    color: "#e8eefc",
    fontSize: 14,
    outline: "none",
    resize: "vertical",
  },

  eventList: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 },
  eventItem: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(0,0,0,0.18)",
    padding: 10,
  },
  eventTitle: { fontWeight: 900, fontSize: 16 },
  eventMeta: { marginTop: 4, opacity: 0.8, fontSize: 13 },
  eventDelBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(42, 15, 15, 0.65)",
    color: "#ffd6d6",
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 20,
  },

  noteSmall: { marginTop: 10, opacity: 0.65, fontSize: 12 },

  // small GP card on calendar page
  gpCardSmall: {
    borderRadius: 18,
    padding: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(10,14,24,0.25)",
  },
  gpTitleSmall: { fontSize: 15, fontWeight: 900, opacity: 0.95 },
  gpNameSmall: { marginTop: 8, fontSize: 16, fontWeight: 900 },
  gpLocSmall: { marginTop: 4, opacity: 0.8, fontSize: 12 },
  gpCountdownSmallRow: { marginTop: 8, fontSize: 14, opacity: 0.95 },

  footer: { marginTop: 14, opacity: 0.6, fontSize: 12 },
};