/* ═══════════════════════════════════════════════════════════
   Pomodoro.Flow — application logic
   ═══════════════════════════════════════════════════════════ */
"use strict";

/* ───────────────── Константы и ключи хранилища ───────────────── */
const LS_STATE = "pomodoroFlow.state.v1"; // задачи, настройки, счётчик
const LS_SOUNDS = "pomodoroFlow.sounds.v1"; // аудио data-URL (отдельно: тяжёлые)
const MAX_SOUND_BYTES = 2 * 1024 * 1024; // 2 МБ на файл

const MODES = {
  work: {
    key: "work",
    label: "Работа",
    icon: "bi-briefcase",
    def: 25,
    tone: "work",
  },
  break: {
    key: "break",
    label: "Перерыв",
    icon: "bi-cup-hot",
    def: 5,
    tone: "break",
  },
  rest: {
    key: "rest",
    label: "Отдых",
    icon: "bi-moon-stars",
    def: 45,
    tone: "rest",
  },
};
const MODE_ORDER = ["work", "break", "rest"];
const PRIO = {
  low: { label: "Низкий", cls: "low" },
  med: { label: "Средний", cls: "med" },
  high: { label: "Высокий", cls: "high" },
};

/* ───────────────── Состояние по умолчанию ───────────────── */
const defaultState = () => ({
  durations: { work: 25, break: 5, rest: 45 },
  mode: "work",
  tasks: [],
  focusTaskId: null,
  filter: "all",
  longRest: false,
  longRestEvery: 4,
  titleTimer: true,
  workStreak: 0,
  sessionsLog: {}, // { 'YYYY-MM-DD': { iterations: N, duration: N } } — статистика итераций и фокуса по дням
});

let state = defaultState();
let sounds = { work: null, break: null, rest: null }; // { name, dataUrl } | null

/* Рантайм-состояние таймера (не сохраняется) */
const timer = {
  running: false,
  remainMs: 0, // остаток в мс
  totalMs: 0, // полная длительность текущего цикла
  endAt: 0, // абсолютная метка окончания (устойчиво к троттлингу вкладки)
  tickId: null,
};

let audioCtx = null;
let currentAudio = null;
let taskModal, helpModal, focusStatsModal;
let focusPeriod = "month";
let draggedTaskId = null;

/* ───────────────── Утилиты ───────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const todayKey = () => new Date().toISOString().slice(0, 10);

function fmtTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(str = "") {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function toast(msg, type = "ok", ms = 3200) {
  const icons = {
    ok: "bi-check-circle-fill",
    err: "bi-exclamation-triangle-fill",
    info: "bi-info-circle-fill",
  };
  const el = document.createElement("div");
  el.className = `toast-item ${type}`;
  el.innerHTML = `<i class="bi ${
    icons[type] || icons.ok
  }"></i><div>${escapeHtml(msg)}</div>`;
  $("#toastWrap").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, ms);
}

/* ───────────────── Хранилище ───────────────── */
function saveState() {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
  } catch (e) {
    console.error(e);
    toast("Не удалось сохранить данные: хранилище переполнено.", "err", 5000);
  }
}

function saveSounds() {
  try {
    localStorage.setItem(LS_SOUNDS, JSON.stringify(sounds));
    return true;
  } catch (e) {
    console.error(e);
    toast(
      "Звук не сохранён: не хватает места в localStorage. Попробуйте файл поменьше.",
      "err",
      5200,
    );
    return false;
  }
}

function loadAll() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (raw) state = normalizeState(JSON.parse(raw));
  } catch (e) {
    console.error("Не удалось прочитать состояние", e);
    toast(
      "Сохранённые данные повреждены — загружены значения по умолчанию.",
      "err",
      5000,
    );
  }
  try {
    const raw = localStorage.getItem(LS_SOUNDS);
    if (raw) {
      const s = JSON.parse(raw) || {};
      MODE_ORDER.forEach((m) => {
        sounds[m] =
          s[m] && typeof s[m].dataUrl === "string"
            ? { name: String(s[m].name || "custom"), dataUrl: s[m].dataUrl }
            : null;
      });
    }
  } catch (e) {
    console.error("Не удалось прочитать звуки", e);
  }
}

/** Приводит любые входные данные (в т.ч. импорт) к валидной форме. */
function normalizeState(raw) {
  const d = defaultState();
  if (!raw || typeof raw !== "object") return d;

  const s = { ...d, ...raw };
  s.durations = {
    work: clamp(parseInt(raw?.durations?.work, 10) || d.durations.work, 1, 180),
    break: clamp(
      parseInt(raw?.durations?.break, 10) || d.durations.break,
      1,
      180,
    ),
    rest: clamp(parseInt(raw?.durations?.rest, 10) || d.durations.rest, 1, 180),
  };
  s.mode = MODES[raw.mode] ? raw.mode : "work";
  s.filter = ["all", "active", "done"].includes(raw.filter)
    ? raw.filter
    : "all";
  s.longRest = !!raw.longRest;
  s.longRestEvery = clamp(parseInt(raw.longRestEvery, 10) || 4, 2, 12);
  s.titleTimer = raw.titleTimer !== false;
  s.workStreak = clamp(parseInt(raw.workStreak, 10) || 0, 0, 9999);
  s.sessionsLog = {};
  if (raw.sessionsLog && typeof raw.sessionsLog === "object") {
    Object.entries(raw.sessionsLog).forEach(([date, val]) => {
      if (typeof val === "number") {
        // Если раньше было просто число итераций, конвертируем в объект
        s.sessionsLog[date] = {
          iterations: val,
          duration: val * s.durations.work,
        };
      } else if (val && typeof val === "object") {
        s.sessionsLog[date] = {
          iterations: clamp(parseInt(val.iterations, 10) || 0, 0, 9999),
          duration: clamp(parseInt(val.duration, 10) || 0, 0, 999999),
        };
      }
    });
  }

  s.tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((t) => ({
        id: String(t?.id || uid()),
        title: String(t?.title ?? "").slice(0, 200) || "Без названия",
        desc: String(t?.desc ?? "").slice(0, 20000),
        prio: PRIO[t?.prio] ? t.prio : "med",
        pomos: clamp(parseInt(t?.pomos, 10) || 0, 0, 999),
        done: !!t?.done,
        createdAt: Number(t?.createdAt) || Date.now(),
        completedAt: typeof t?.completedAt === "string" ? t.completedAt : null,
        expanded: !!t?.expanded,
      }))
    : [];

  s.focusTaskId = s.tasks.some((t) => t.id === raw.focusTaskId)
    ? raw.focusTaskId
    : null;
  return s;
}

/* ───────────────── Web Audio: встроенные сигналы ───────────────── */
function getCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

/** Мягкий колокольчик: синус + мажорная терция с экспоненциальным затуханием. */
function playChime(mode) {
  const ctx = getCtx();
  if (!ctx) return;

  // Разные аккорды для разных режимов — сигнал узнаётся на слух
  const presets = {
    work: { freqs: [880.0, 1108.73, 1318.51], dur: 1.5, type: "sine" }, // A5 · C#6 · E6 — бодрый
    break: { freqs: [659.25, 830.61, 987.77], dur: 1.8, type: "sine" }, // E5 · G#5 · B5 — мягкий
    rest: { freqs: [523.25, 659.25, 783.99], dur: 2.4, type: "triangle" }, // C5 · E5 · G5 — тёплый
  };
  const p = presets[mode] || presets.work;
  const now = ctx.currentTime;

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  // Лёгкая «дымка» вместо реверба
  const shimmer = ctx.createBiquadFilter();
  shimmer.type = "lowpass";
  shimmer.frequency.setValueAtTime(5200, now);
  shimmer.frequency.exponentialRampToValueAtTime(1400, now + p.dur);
  shimmer.connect(master);

  p.freqs.forEach((f, i) => {
    // Арпеджио: ноты входят по очереди
    const t0 = now + i * 0.11;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = p.type;
    osc.frequency.setValueAtTime(f, t0);

    const peak = 0.26 / (i * 0.45 + 1);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);

    osc.connect(gain).connect(shimmer);
    osc.start(t0);
    osc.stop(t0 + p.dur + 0.05);
  });

  // Тихий низкий «удар» для объёма
  const sub = ctx.createOscillator();
  const subGain = ctx.createGain();
  sub.type = "sine";
  sub.frequency.setValueAtTime(p.freqs[0] / 4, now);
  subGain.gain.setValueAtTime(0.0001, now);
  subGain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
  subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  sub.connect(subGain).connect(master);
  sub.start(now);
  sub.stop(now + 1);
}

/** Проигрывает пользовательский звук либо встроенный сигнал. */
function playAlarm(mode) {
  const custom = sounds[mode];
  if (custom?.dataUrl) {
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      }
      currentAudio = new Audio(custom.dataUrl);
      currentAudio.volume = 0.9;
      currentAudio.play().catch((err) => {
        console.warn("Не удалось воспроизвести пользовательский звук", err);
        playChime(mode);
      });
      return;
    } catch (e) {
      console.warn(e);
    }
  }
  playChime(mode);
}

/* ───────────────── Таймер ───────────────── */
function modeDurationMs(mode) {
  return state.durations[mode] * 60 * 1000;
}

function resetTimer(silent = false) {
  stopTick();
  timer.running = false;
  timer.totalMs = modeDurationMs(state.mode);
  timer.remainMs = timer.totalMs;
  timer.endAt = 0;
  renderTimer();
  if (!silent) updateStatus("Готов", "");
}

function startTimer() {
  if (timer.running) return;
  if (timer.remainMs <= 0) timer.remainMs = modeDurationMs(state.mode);
  getCtx(); // «прогреваем» аудио по жесту пользователя
  timer.running = true;
  timer.endAt = Date.now() + timer.remainMs;
  startTick();
  updateStatus(MODES[state.mode].label + " идёт", "run");
  renderTimer();
}

function pauseTimer() {
  if (!timer.running) return;
  timer.remainMs = Math.max(0, timer.endAt - Date.now());
  timer.running = false;
  stopTick();
  updateStatus("Пауза", "pause");
  renderTimer();
}

function startTick() {
  stopTick();
  timer.tickId = setInterval(() => {
    timer.remainMs = Math.max(0, timer.endAt - Date.now());
    renderTimer();
    if (timer.remainMs <= 0) finishTimer();
  }, 250);
}

function stopTick() {
  if (timer.tickId) {
    clearInterval(timer.tickId);
    timer.tickId = null;
  }
}

function finishTimer() {
  stopTick();
  const finishedMode = state.mode;
  timer.running = false;
  timer.remainMs = 0;

  playAlarm(finishedMode);

  // Учёт завершённой «Работы»
  if (finishedMode === "work") {
    state.workStreak++;
    const k = todayKey();
    // Инициализируем объект для сегодняшнего дня, если его еще нет
    if (!state.sessionsLog[k]) {
      state.sessionsLog[k] = { iterations: 0, duration: 0 };
    }
    state.sessionsLog[k].iterations += 1;
    state.sessionsLog[k].duration += state.durations.work;

    const task = state.tasks.find((t) => t.id === state.focusTaskId);
    if (task) task.pomos = clamp(task.pomos + 1, 0, 999);
  }

  // Автопереключение режима — БЕЗ автостарта
  const next = nextMode(finishedMode);
  state.mode = next;
  saveState();

  resetTimer(true);
  renderAll();

  $("#dial").classList.add("finished");
  setTimeout(() => $("#dial")?.classList.remove("finished"), 3200);

  const msg = `«${MODES[finishedMode].label}» завершён → ${MODES[next].label}. Нажмите «Старт».`;
  updateStatus(`${MODES[next].label}: ждёт старта`, "");
  toast(msg, "info", 5000);
  notify(
    `${MODES[finishedMode].label} завершён`,
    `Следующий режим: ${MODES[next].label}`,
  );
  flashTitle(`✅ ${MODES[finishedMode].label} завершён`);
}

/** Работа → Перерыв (или Отдых по стрику) · Перерыв/Отдых → Работа. */
function nextMode(from) {
  if (from === "work") {
    if (
      state.longRest &&
      state.workStreak > 0 &&
      state.workStreak % state.longRestEvery === 0
    )
      return "rest";
    return "break";
  }
  return "work";
}

function switchMode(mode, { force = false } = {}) {
  if (!MODES[mode] || mode === state.mode) return;
  if (timer.running && !force) {
    if (
      !confirm(
        `Таймер «${MODES[state.mode].label}» ещё идёт. Переключиться на «${
          MODES[mode].label
        }» и сбросить отсчёт?`,
      )
    )
      return;
  }
  state.mode = mode;
  saveState();
  resetTimer();
  renderAll();
}

/* ───────────────── Уведомления браузера ───────────────── */
function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  try {
    new Notification(title, { body, icon: "", silent: true });
  } catch (e) {
    /* no-op */
  }
}

function requestNotify() {
  if (!("Notification" in window))
    return toast("Браузер не поддерживает уведомления.", "err");
  if (Notification.permission === "granted")
    return toast("Уведомления уже разрешены.", "info");
  Notification.requestPermission().then((p) => {
    toast(
      p === "granted" ? "Уведомления включены." : "Уведомления не разрешены.",
      p === "granted" ? "ok" : "info",
    );
    updateNotifyBtn();
  });
}

function updateNotifyBtn() {
  const btn = $("#btnNotify");
  if (!btn || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    btn.innerHTML =
      '<i class="bi bi-bell-fill"></i><span class="d-none d-sm-inline ms-1">Уведомления</span>';
    btn.classList.add("on");
  }
}

/* ───────────────── Заголовок вкладки ───────────────── */
let titleFlashId = null;

function updateTitle() {
  if (titleFlashId) return; // не перебиваем «вспышку» о завершении
  if (!state.titleTimer) {
    document.title = "Pomodoro.Flow";
    return;
  }
  const icon = timer.running ? "▶" : timer.remainMs < timer.totalMs ? "⏸" : "⏱";
  document.title = `${icon} ${fmtTime(timer.remainMs)} · ${
    MODES[state.mode].label
  } — Pomodoro.Flow`;
}

function flashTitle(text) {
  clearTimeout(titleFlashId);
  document.title = text;
  titleFlashId = setTimeout(() => {
    titleFlashId = null;
    updateTitle();
  }, 4000);
}

/* ───────────────── Рендер: таймер ───────────────── */
function renderTimer() {
  const m = MODES[state.mode];
  const progress = timer.totalMs ? 1 - timer.remainMs / timer.totalMs : 0;

  $("#dialTime").textContent = fmtTime(timer.remainMs);
  $("#dialLabel").textContent = m.label;
  $("#dialSub").textContent = `${state.durations[state.mode]} мин`;
  $("#dial").style.setProperty("--p", clamp(progress, 0, 1).toFixed(4));
  $("#dial").classList.toggle("running", timer.running);

  $("#btnStart").disabled = timer.running;
  $("#btnPause").disabled = !timer.running;
  $("#btnStart").innerHTML =
    !timer.running && timer.remainMs < timer.totalMs
      ? '<i class="bi bi-play-fill"></i> Продолжить'
      : '<i class="bi bi-play-fill"></i> Старт';

  updateTitle();
}

function updateStatus(text, cls) {
  $("#statusText").textContent = text;
  $("#statusBadge").className = "badge-soft " + (cls || "");
  $("#statusBadge").innerHTML =
    `<i class="bi bi-circle-fill me-1 tiny"></i><span id="statusText">${escapeHtml(
      text,
    )}</span>`;
}

/* ───────────────── Рендер: настройки таймеров ───────────────── */
function renderSettings() {
  const html = MODE_ORDER.map((key) => {
    const m = MODES[key];
    const snd = sounds[key];
    const custom = !!snd?.dataUrl;
    return `
      <div class="setting-row ${
        state.mode === key ? "active" : ""
      }" data-srow="${key}">
        <div class="setting-name"><i class="bi ${m.icon}"></i>${m.label}</div>
        <input type="number" class="min-input" data-dur="${key}" min="1" max="180"
               value="${state.durations[key]}" aria-label="Минуты: ${m.label}">
        <span class="min-unit">мин</span>
        <div class="sound-zone">
          <span class="sound-name ${
            custom ? "custom" : ""
          }" title="${escapeHtml(custom ? snd.name : "Встроенный сигнал")}">
            <i class="bi ${
              custom ? "bi-music-note-beamed" : "bi-soundwave"
            }"></i>
            ${escapeHtml(custom ? snd.name : "Встроенный")}
          </span>
          <button class="btn-icon" data-play="${key}" title="Прослушать"><i class="bi bi-play-circle"></i></button>
          <button class="btn-icon" data-upload="${key}" title="Загрузить свой MP3/WAV"><i class="bi bi-upload"></i></button>
          ${
            custom
              ? `<button class="btn-icon danger" data-delsound="${key}" title="Вернуть встроенный"><i class="bi bi-x-lg"></i></button>`
              : ""
          }
          <input type="file" accept="audio/mpeg,audio/wav,audio/*,.mp3,.wav" data-file="${key}" hidden>
        </div>
      </div>`;
  }).join("");
  $("#settingsList").innerHTML = html;
}

/* ───────────────── Звуки: загрузка ───────────────── */
function handleSoundFile(mode, file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|m4a)$/i.test(file.name)) {
    return toast("Нужен аудиофайл (MP3 / WAV).", "err");
  }
  if (file.size > MAX_SOUND_BYTES) {
    return toast(
      `Файл больше 2 МБ (${(file.size / 1048576).toFixed(
        1,
      )} МБ). Выберите короткий сигнал.`,
      "err",
      5000,
    );
  }

  const reader = new FileReader();

  reader.onload = () => {
    const prev = sounds[mode];
    sounds[mode] = { name: file.name, dataUrl: reader.result };
    if (saveSounds()) {
      renderSettings();
      toast(`Звук для «${MODES[mode].label}» сохранён.`, "ok");
      playAlarm(mode);
    } else {
      sounds[mode] = prev; // откат при переполнении хранилища
    }
  };
  reader.onerror = () => toast("Не удалось прочитать файл.", "err");
  reader.readAsDataURL(file);
}

/* ───────────────── Рендер: счётчик и статистика ───────────────── */
function renderCounter(bump = false) {
  const total = state.tasks.length;
  const done = state.tasks.filter((t) => t.done).length;
  const remaining = total - done;
  const pomos = state.tasks.reduce((a, t) => a + t.pomos, 0);

  const todayEntry = state.sessionsLog[todayKey()] || {
    iterations: 0,
    duration: 0,
  };
  const todayIters = todayEntry.iterations;

  // Время фокуса за текущий день
  const focusMin = todayEntry.duration;

  $("#statsRow").innerHTML = `
    <div class="stat-chip"><i class="bi bi-calendar-check stat-icon"></i><b>${todayIters}</b><span>сегодня</span></div>
    <div class="stat-chip"><i class="bi bi-check2-square stat-icon"></i><b>${done}/${total}</b><span>задач</span></div>
    <div class="stat-chip"><i class="bi bi-stopwatch stat-icon"></i><b>${pomos}</b><span>на задачах</span></div>
    <div class="stat-chip"><i class="bi bi-hourglass-split stat-icon"></i><b>${Math.floor(focusMin / 60)}ч ${
      focusMin % 60
    }м</b><span>фокуса</span></div>`;
  const remainingBadge = $("#taskRemaining");
  remainingBadge.textContent = `${remaining} осталось`;
  remainingBadge.classList.toggle("is-complete", remaining === 0 && total > 0);
}

/* ───────────────── Статистика времени фокуса ───────────────── */
function renderFocusStats() {
  const days = focusPeriod === "week" ? 7 : focusPeriod === "year" ? 365 : 30;
  const today = new Date();
  const points = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - offset,
      ),
    );
    const key = date.toISOString().slice(0, 10);
    const entry = state.sessionsLog[key];
    points.push({
      date,
      key,
      minutes: Math.max(0, Number(entry?.duration) || 0),
    });
  }
  const total = points.reduce((sum, point) => sum + point.minutes, 0);
  const max = Math.max(1, ...points.map((point) => point.minutes));
  const width = 900;
  const height = 270;
  const left = 42;
  const right = 12;
  const top = 16;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const gap = points.length > 60 ? 1 : 5;
  const barWidth = Math.max(
    1,
    (plotWidth - gap * (points.length - 1)) / points.length,
  );
  const bars = points
    .map((point, index) => {
      const barHeight = point.minutes
        ? Math.max(3, (point.minutes / max) * plotHeight)
        : 0;
      const x = left + index * (barWidth + gap);
      const y = top + plotHeight - barHeight;
      const label = point.date.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
      return `<rect class="focus-bar" data-date="${point.key}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="${Math.min(4, barWidth / 2)}"></rect>`;
    })
    .join("");
  const labelIndexes =
    focusPeriod === "week"
      ? [0, 3, 6]
      : focusPeriod === "month"
        ? [0, 7, 14, 21, 29]
        : [0, 90, 180, 270, 364];
  const labels = labelIndexes
    .map((index) => {
      const point = points[index];
      const x = left + index * (barWidth + gap) + barWidth / 2;
      const text =
        focusPeriod === "year"
          ? point.date.toLocaleDateString("ru-RU", {
              month: "short",
              timeZone: "UTC",
            })
          : point.date.toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            });
      return `<text class="focus-axis-label" x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle">${text}</text>`;
    })
    .join("");
  const periodLabel =
    focusPeriod === "week"
      ? "за последние 7 дней"
      : focusPeriod === "year"
        ? "за последние 365 дней"
        : "за последние 30 дней";
  const totalHours = Math.floor(total / 60);
  const totalMinutes = total % 60;
  $("#focusStatsSummary").textContent =
    `${periodLabel} · ${totalHours} ч ${totalMinutes} мин фокуса`;
  $("#focusChart").innerHTML = total
    ? `<svg class="focus-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="${periodLabel}"><line class="focus-gridline" x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}"/>${bars}${labels}</svg>`
    : '<div class="focus-chart-empty"><i class="bi bi-bar-chart-line"></i><span>За этот период записей пока нет</span></div>';
  $$("#focusPeriodSwitch .filter-btn").forEach((button) =>
    button.classList.toggle("active", button.dataset.period === focusPeriod),
  );
}

function showFocusTooltip(bar, event) {
  const date = bar.dataset.date;
  const entry = state.sessionsLog[date] || {};
  const created = state.tasks.filter((task) => {
    const createdAt = new Date(task.createdAt);
    return (
      `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}-${String(createdAt.getDate()).padStart(2, "0")}` ===
      date
    );
  }).length;
  const completed = state.tasks.filter(
    (task) => task.done && task.completedAt === date,
  ).length;
  let tooltip = $("#focusChartTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "focusChartTooltip";
    tooltip.className = "focus-chart-tooltip";
    document.body.appendChild(tooltip);
  }
  tooltip.innerHTML = `
    <div class="focus-tooltip-date"><i class="bi bi-calendar3"></i>${new Date(`${date}T00:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</div>
    <div class="focus-tooltip-row"><i class="bi bi-clock-history"></i><span>Время фокуса</span><b>${Math.floor((entry.duration || 0) / 60)} ч ${(entry.duration || 0) % 60} мин</b></div>
    <div class="focus-tooltip-row"><i class="bi bi-record-circle"></i><span>Итераций Pomodoro</span><b>${entry.iterations || 0}</b></div>
    <div class="focus-tooltip-row"><i class="bi bi-check2-circle"></i><span>Задач выполнено</span><b>${completed}</b></div>
    <div class="focus-tooltip-row"><i class="bi bi-plus-circle"></i><span>Задач создано</span><b>${created}</b></div>`;
  tooltip.classList.add("visible");
  tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 12)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 14, window.innerHeight - tooltip.offsetHeight - 12)}px`;
}

function hideFocusTooltip() {
  $("#focusChartTooltip")?.classList.remove("visible");
}

/* ───────────────── Рендер: задачи ───────────────── */
function renderMarkdown(src) {
  if (!src) return "";
  try {
    if (window.marked) {
      const html = window.marked.parse(src, { breaks: true, gfm: true });
      return sanitize(html);
    }
  } catch (e) {
    console.warn("Ошибка разбора Markdown", e);
  }
  return `<p>${escapeHtml(src).replace(/\n/g, "<br>")}</p>`;
}

/** Базовая очистка: убираем скрипты, iframe и обработчики событий. */
function sanitize(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content
    .querySelectorAll("script,iframe,object,embed,style,link,meta,form")
    .forEach((n) => n.remove());
  tpl.content.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && val.startsWith("javascript:"))
        node.removeAttribute(attr.name);
    });
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.tagName === "IMG") {
      node.setAttribute("loading", "lazy");
      node.addEventListener?.("error", () => {});
    }
  });
  return tpl.innerHTML;
}

function visibleTasks() {
  const f = state.filter;
  return state.tasks.filter((t) =>
    f === "all" ? true : f === "done" ? t.done : !t.done,
  );
}

function renderTasks() {
  const list = $("#taskList");
  const items = visibleTasks();

  $("#emptyState").classList.toggle("d-none", items.length > 0);
  $("#emptyState").querySelector("div").textContent =
    state.tasks.length === 0
      ? "Задач пока нет. Добавьте первую — и запускайте таймер."
      : "В этом фильтре задач нет.";

  let previousDate = null;
  list.innerHTML = items
    .map((t) => {
      const p = PRIO[t.prio];
      const isFocus = t.id === state.focusTaskId;
      const hasDesc = !!t.desc.trim();
      const createdDate = new Date(t.createdAt)
        .toLocaleDateString("ru-RU", { day: "numeric", month: "short" })
        .replace(/ г\.?$/, "");
      const divider =
        createdDate !== previousDate
          ? `<div class="task-date-divider">${createdDate}</div>`
          : "";
      previousDate = createdDate;
      return `${divider}
    <article class="task-card ${t.done ? "done" : ""} ${
      isFocus ? "focused" : ""
    }" data-prio="${t.prio}" data-id="${t.id}">
      
      <div class="task-head" draggable="true">
      <span class="task-drag-handle" title="Перетащить задачу" aria-label="Перетащить задачу"><i class="bi bi-grip-vertical"></i></span>
        <button class="task-check ${t.done ? "checked" : ""}" data-act="toggle"
                title="${t.done ? "Вернуть в работу" : "Отметить выполненной"}"
                aria-pressed="${t.done}"><i class="bi bi-check-lg"></i></button>

        <div class="task-main">
          <h3 class="task-title">${escapeHtml(t.title)}</h3>
          <div class="task-meta">
            <span class="prio-tag ${p.cls}">${p.label}</span>
            <span class="pomo-counter" title="Итерации помодоро по задаче">
              <button class="btn-round sm" data-act="pomo-" aria-label="Минус итерация"><i class="bi bi-dash-lg"></i></button>
              <span class="pomo-val"><i class="bi bi-record-circle"></i>${
                t.pomos
              }</span>
              <button class="btn-round sm" data-act="pomo+" aria-label="Плюс итерация"><i class="bi bi-plus-lg"></i></button>
            </span>
            ${
              hasDesc
                ? `<button class="desc-toggle ms-1" data-act="expand">
                <i class="bi bi-chevron-${t.expanded ? "up" : "down"}"></i>
                ${t.expanded ? "Свернуть" : "Описание"}
              </button>`
                : ""
            }
          </div>
        </div>

        <div class="task-actions">
          
          <button class="btn-icon ${isFocus ? "on" : ""}" data-act="focus"
                  title="${
                    isFocus ? "Снять фокус" : "Считать помодоро на эту задачу"
                  }"><i class="bi bi-crosshair"></i></button>
          <button class="btn-icon" data-act="edit" title="Редактировать"><i class="bi bi-pencil"></i></button>
          <button class="btn-icon danger" data-act="del" title="Удалить"><i class="bi bi-trash3"></i></button>
        </div>
      </div>
      ${
        hasDesc && t.expanded
          ? `<div class="task-desc markdown-body">${renderMarkdown(
              t.desc,
            )}</div>`
          : ""
      }
    </article>`;
    })
    .join("");
}

function renderAll() {
  renderSettings();
  renderCounter();
  renderTasks();
  renderTimer();
  $$(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode),
  );
  $$(".filter-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.filter === state.filter),
  );
}

/* ───────────────── CRUD задач ───────────────── */
function addTask(data) {
  state.tasks.unshift({
    id: uid(),
    title: data.title.slice(0, 200),
    desc: data.desc || "",
    prio: PRIO[data.prio] ? data.prio : "med",
    pomos: clamp(parseInt(data.pomos, 10) || 0, 0, 999),
    done: false,
    createdAt: Date.now(),
    completedAt: null,
    expanded: false,
  });
  saveState();
  renderTasks();
  renderCounter();
}

function updateTask(id, patch, { rerender = true } = {}) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (Object.prototype.hasOwnProperty.call(patch, "done")) {
    patch.completedAt = patch.done
      ? new Date().toISOString().slice(0, 10)
      : null;
  }
  Object.assign(t, patch);
  saveState();
  if (rerender) renderTasks();
  renderCounter();
}

/** Точечно меняет счётчик помодоро в карточке — без перерисовки всего списка,
 *  чтобы не терялся фокус и не «прыгал» скролл при частых кликах. */
function bumpTaskPomos(id, delta) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const next = clamp(t.pomos + delta, 0, 999);
  if (next === t.pomos) return;
  t.pomos = next;
  saveState();
  const val = $(`.task-card[data-id="${id}"] .pomo-val`);
  if (val) val.innerHTML = `<i class="bi bi-record-circle"></i>${next}`;
  else renderTasks();
  renderCounter();
}

function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`Удалить задачу «${t.title}»?`)) return;
  state.tasks = state.tasks.filter((x) => x.id !== id);
  if (state.focusTaskId === id) state.focusTaskId = null;
  saveState();
  renderTasks();
  renderCounter();
  toast("Задача удалена.", "ok");
}

/* ───────────────── Модалка задачи ───────────────── */
function openTaskModal(id = null) {
  const isEdit = !!id;
  const t = isEdit ? state.tasks.find((x) => x.id === id) : null;
  if (isEdit && !t) return;

  $("#taskModalTitle").textContent = isEdit
    ? "Редактирование задачи"
    : "Новая задача";
  $("#taskId").value = isEdit ? t.id : "";
  $("#taskTitle").value = isEdit ? t.title : "";
  $("#taskDesc").value = isEdit ? t.desc : "";
  $("#taskPrio").value = isEdit ? t.prio : "med";
  $("#taskPomos").value = isEdit ? t.pomos : 0;
  $("#taskCreatedAtGroup").classList.toggle("d-none", !isEdit);
  $("#taskCreatedAt").value = isEdit
    ? new Date(t.createdAt).toLocaleString("ru-RU")
    : "";
  $("#taskCompletedAtGroup").classList.toggle("d-none", !isEdit || !t.done);
  $("#taskCompletedAt").value =
    isEdit && t.done && t.completedAt
      ? new Date(t.completedAt).toLocaleDateString("ru-RU")
      : "";

  setMdTab("edit");
  taskModal.show();
  setTimeout(() => $("#taskTitle").focus(), 300);
}

function setMdTab(tab) {
  const isEdit = tab === "edit";
  $("#taskDesc").classList.toggle("d-none", !isEdit);
  $("#taskDescPreview").classList.toggle("d-none", isEdit);
  $$(".md-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.mdtab === tab),
  );
  if (!isEdit) {
    const src = $("#taskDesc").value.trim();
    $("#taskDescPreview").innerHTML = src
      ? renderMarkdown(src)
      : '<div class="text-muted-soft small">Описание пусто. Markdown поддерживает заголовки, списки, ссылки, картинки, код и таблицы.</div>';
  }
}

/* ───────────────── Экспорт / импорт ───────────────── */
function exportData() {
  const payload = {
    app: "Pomodoro.Flow",
    version: 1,
    exportedAt: new Date().toISOString(),
    durations: state.durations,
    counter: state.counter,
    mode: state.mode,
    longRest: state.longRest,
    longRestEvery: state.longRestEvery,
    titleTimer: state.titleTimer,
    workStreak: state.workStreak,
    sessionsLog: state.sessionsLog,
    focusTaskId: state.focusTaskId,
    tasks: state.tasks,
    // Имена файлов звуков — сами данные не выгружаем, чтобы не раздувать JSON
    soundNames: {
      work: sounds.work?.name || null,
      break: sounds.break?.name || null,
      rest: sounds.rest?.name || null,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pomodoro-flow-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Данные выгружены в JSON.", "ok");
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (e) {
      return toast("Файл не является корректным JSON.", "err", 5000);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
      return toast(
        "Структура файла не подходит: нет списка задач.",
        "err",
        5000,
      );
    }
    const cnt = parsed.tasks.length;
    if (
      !confirm(
        `Импортировать данные? Текущие задачи (${state.tasks.length}) и настройки будут заменены на ${cnt} задач(и) из файла.`,
      )
    )
      return;

    state = normalizeState(parsed);
    saveState();
    resetTimer();
    renderAll();
    toast(`Импортировано задач: ${cnt}.`, "ok");
  };
  reader.onerror = () => toast("Не удалось прочитать файл.", "err");
  reader.readAsText(file);
}

function clearAll() {
  if (
    !confirm(
      "Очистить всё?\n\nБудут удалены все задачи, обнулён счётчик итераций и сброшены настройки времени. Загруженные звуки сохранятся.\n\nДействие необратимо.",
    )
  )
    return;
  state = defaultState();
  saveState();
  resetTimer();
  renderAll();
  toast("Все данные очищены.", "ok");
}

/* ───────────────── Обработчики событий ───────────────── */
function bindEvents() {
  /* --- Режимы --- */
  $$(".mode-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchMode(btn.dataset.mode)),
  );

  /* --- Управление таймером --- */
  $("#btnStart").addEventListener("click", startTimer);
  $("#btnPause").addEventListener("click", pauseTimer);
  $("#btnReset").addEventListener("click", () => {
    if (timer.running && !confirm("Сбросить текущий отсчёт?")) return;
    resetTimer();
    toast("Таймер сброшен.", "info", 1800);
  });
  $("#btnTestSound").addEventListener("click", () => playAlarm(state.mode));

  /* --- Настройки таймеров (делегирование) --- */
  const sl = $("#settingsList");
  sl.addEventListener("change", (e) => {
    const durInput = e.target.closest("[data-dur]");
    if (durInput) {
      const mode = durInput.dataset.dur;
      const val = clamp(
        parseInt(durInput.value, 10) || MODES[mode].def,
        1,
        180,
      );
      durInput.value = val;
      state.durations[mode] = val;
      saveState();
      if (mode === state.mode) {
        if (timer.running) {
          if (
            confirm(
              "Таймер идёт. Применить новую длительность и перезапустить отсчёт?",
            )
          )
            resetTimer();
        } else {
          resetTimer();
        }
      }
      renderTimer();
      return;
    }
    const fileInput = e.target.closest("[data-file]");
    if (fileInput) {
      handleSoundFile(fileInput.dataset.file, fileInput.files[0]);
      fileInput.value = "";
    }
  });

  sl.addEventListener("click", (e) => {
    const up = e.target.closest("[data-upload]");
    if (up) return $(`[data-file="${up.dataset.upload}"]`, sl).click();

    const play = e.target.closest("[data-play]");
    if (play) return playAlarm(play.dataset.play);

    const del = e.target.closest("[data-delsound]");
    if (del) {
      const mode = del.dataset.delsound;
      if (
        !confirm(
          `Удалить свой звук для «${MODES[mode].label}» и вернуть встроенный сигнал?`,
        )
      )
        return;
      sounds[mode] = null;
      saveSounds();
      renderSettings();
      toast("Возвращён встроенный сигнал.", "ok");
    }
  });

  /* --- Дополнительные переключатели --- */
  $("#chkLongRest").addEventListener("change", (e) => {
    state.longRest = e.target.checked;
    saveState();
  });
  $("#numLongEvery").addEventListener("change", (e) => {
    state.longRestEvery = clamp(parseInt(e.target.value, 10) || 4, 2, 12);
    e.target.value = state.longRestEvery;
    saveState();
  });
  $("#numLongEvery").addEventListener("click", (e) => e.stopPropagation());
  $("#chkTitleTimer").addEventListener("change", (e) => {
    state.titleTimer = e.target.checked;
    saveState();
    updateTitle();
    if (!state.titleTimer) document.title = "Pomodoro.Flow";
  });

  /* --- График времени фокуса --- */
  $("#btnFocusStats").addEventListener("click", () => {
    renderFocusStats();
    focusStatsModal.show();
  });
  $("#focusChart").addEventListener("pointermove", (e) => {
    const bar = e.target.closest(".focus-bar");
    if (bar) showFocusTooltip(bar, e);
    else hideFocusTooltip();
  });
  $("#focusChart").addEventListener("pointerleave", hideFocusTooltip);
  $("#focusPeriodSwitch").addEventListener("click", (e) => {
    const button = e.target.closest("[data-period]");
    if (!button) return;
    focusPeriod = button.dataset.period;
    renderFocusStats();
  });

  /* --- Экспорт / импорт / очистка --- */
  $("#btnExport").addEventListener("click", exportData);
  $("#btnImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => {
    importData(e.target.files[0]);
    e.target.value = "";
  });
  $("#btnClearAll").addEventListener("click", clearAll);

  /* --- Фильтры --- */
  $("#filterSwitch").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    state.filter = btn.dataset.filter;
    saveState();
    $$(".filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderTasks();
  });

  /* --- Быстрое добавление --- */
  $("#quickAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#quickAddInput");
    const title = input.value.trim();
    if (!title) return;
    addTask({ title, desc: "", prio: $("#quickAddPrio").value, pomos: 0 });
    input.value = "";
    input.focus();
  });

  /* --- Кнопка «Задача» --- */
  $("#btnAddTask").addEventListener("click", (e) => {
    e.preventDefault();
    openTaskModal();
  });

  /* --- Drag and drop задач --- */
  const taskList = $("#taskList");
  taskList.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".task-card");
    if (!card) return;
    draggedTaskId = card.dataset.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedTaskId);
  });
  
  taskList.addEventListener("dragover", (e) => {
    if (!draggedTaskId) return;
    e.preventDefault();
    const target = e.target.closest(".task-card");
    if (!target || target.dataset.id === draggedTaskId) return;
    e.dataTransfer.dropEffect = "move";
    const rect = target.getBoundingClientRect();
    target.classList.toggle(
      "drop-before",
      e.clientY < rect.top + rect.height / 2,
    );
    target.classList.toggle(
      "drop-after",
      e.clientY >= rect.top + rect.height / 2,
    );
  });
  
  taskList.addEventListener("drop", (e) => {
    if (!draggedTaskId) return;
    e.preventDefault();
    const target = e.target.closest(".task-card");
    if (!target || target.dataset.id === draggedTaskId) return;
    const visible = visibleTasks();
    const fromIndex = visible.findIndex((task) => task.id === draggedTaskId);
    let toIndex = visible.findIndex((task) => task.id === target.dataset.id);
    const rect = target.getBoundingClientRect();
    if (e.clientY >= rect.top + rect.height / 2) toIndex++;
    const [moved] = visible.splice(fromIndex, 1);
    if (fromIndex < toIndex) toIndex--;
    visible.splice(toIndex, 0, moved);
    const visibleIds = new Set(visible.map((task) => task.id));
    let visibleIndex = 0;
    state.tasks = state.tasks.map((task) =>
      visibleIds.has(task.id) ? visible[visibleIndex++] : task,
    );
    saveState();
    renderTasks();
  });
  taskList.addEventListener("dragend", () => {
    draggedTaskId = null;
    $$(".task-card", taskList).forEach((card) =>
      card.classList.remove("dragging", "drop-before", "drop-after"),
    );
  });

  /* --- Действия в карточках (делегирование) --- */
  taskList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = e.target.closest(".task-card");
    if (!card) return;
    const id = card.dataset.id;
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;

    switch (btn.dataset.act) {
      case "toggle":
        updateTask(id, { done: !t.done });
        break;
      case "pomo+":
        bumpTaskPomos(id, +1);
        break;
      case "pomo-":
        bumpTaskPomos(id, -1);
        break;
      case "expand":
        updateTask(id, { expanded: !t.expanded });
        break;
      case "focus":
        state.focusTaskId = state.focusTaskId === id ? null : id;
        saveState();
        renderTasks();
        toast(
          state.focusTaskId
            ? `Помодоро будут засчитываться задаче «${t.title}».`
            : "Фокус снят.",
          "info",
          2600,
        );
        break;
      case "edit":
        openTaskModal(id);
        break;
      case "del":
        deleteTask(id);
        break;
    }
  });

  /* --- Форма задачи --- */
  $("#taskModal").addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      $("#taskForm").requestSubmit();
    }
  });
  $("#taskForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#taskId").value;
    const title = $("#taskTitle").value.trim();
    if (!title) return;
    const data = {
      title,
      desc: $("#taskDesc").value,
      prio: $("#taskPrio").value,
      pomos: clamp(parseInt($("#taskPomos").value, 10) || 0, 0, 999),
    };
    if (id) {
      updateTask(id, data);
      toast("Задача обновлена.", "ok", 2000);
    } else {
      addTask(data);
      toast("Задача добавлена.", "ok", 2000);
    }
    taskModal.hide();
  });

  $("#taskPomoPlus").addEventListener("click", () => {
    $("#taskPomos").value = clamp(
      (parseInt($("#taskPomos").value, 10) || 0) + 1,
      0,
      999,
    );
  });
  $("#taskPomoMinus").addEventListener("click", () => {
    $("#taskPomos").value = clamp(
      (parseInt($("#taskPomos").value, 10) || 0) - 1,
      0,
      999,
    );
  });
  $$(".md-tab").forEach((b) =>
    b.addEventListener("click", () => setMdTab(b.dataset.mdtab)),
  );

  /* --- Прочее --- */
  $("#btnNotify").addEventListener("click", requestNotify);
  $("#btnHelp").addEventListener("click", () => helpModal.show());

  /* --- Горячие клавиши --- */
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing =
      ["input", "textarea", "select"].includes(tag) ||
      e.target.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector(".modal.show")) return;

    switch (e.key.toLowerCase()) {
      case " ":
        e.preventDefault();
        timer.running ? pauseTimer() : startTimer();
        break;
      case "r":
        resetTimer();
        break;
      case "1":
        switchMode("work");
        break;
      case "2":
        switchMode("break");
        break;
      case "3":
        switchMode("rest");
        break;
      case "n":
        e.preventDefault();
        openTaskModal();
        break;
    }
  });

  /* --- Возврат на вкладку: пересчитываем остаток --- */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !timer.running) return;
    timer.remainMs = Math.max(0, timer.endAt - Date.now());
    renderTimer();
    if (timer.remainMs <= 0) finishTimer();
  });

  /* --- Предупреждение при закрытии во время отсчёта --- */
  window.addEventListener("beforeunload", (e) => {
    if (timer.running) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* --- Синхронизация между вкладками --- */
  window.addEventListener("storage", (e) => {
    if (e.key === LS_STATE && e.newValue) {
      try {
        state = normalizeState(JSON.parse(e.newValue));
        renderCounter();
        renderTasks();
      } catch (err) {
        /* no-op */
      }
    }
  });
}

/* ───────────────── Инициализация ───────────────── */
function init() {
  loadAll();

  taskModal = new bootstrap.Modal($("#taskModal"));
  helpModal = new bootstrap.Modal($("#helpModal"));
  focusStatsModal = new bootstrap.Modal($("#focusStatsModal"));

  $("#chkLongRest").checked = state.longRest;
  $("#numLongEvery").value = state.longRestEvery;
  $("#chkTitleTimer").checked = state.titleTimer;

  bindEvents();
  updateNotifyBtn();
  resetTimer();
  renderAll();
  updateStatus("Готов", "");
}

document.addEventListener("DOMContentLoaded", init);
