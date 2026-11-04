const GREEN_CODES = new Set(["M", "X", "O"]);
const RED_CODES = new Set(["F", "V", "E"]);
const VALID_ATTENDANCE_CODES = new Set([...GREEN_CODES, ...RED_CODES]);

const DASHBOARD_HASHES = new Set(["#/", "#", "", "#/Home", "#/Dashboard", "#/Timetable", "#/Schedule"]);
const ATTENDANCE_HASH = "#/AttendanceOverview";
const ATTENDANCE_PAGE_BASE = "https://nam.inna.is/Components/Students/Students.html";
// FullCalendar weekday columns are identified by their data-date values.

const MAX_AUTO_RETRIES = 4;
const AUTO_RETRY_DELAY = 1600;
const RUN_DEBOUNCE_MS = 600;
const UI_SYNC_DEBOUNCE_MS = 180;
const SNAPSHOT_ATTEMPTS = 24;
const SNAPSHOT_POLL_MS = 350;
const MIN_FREE_GAP_MINUTES = 50;
const LUNCH_GAP_START_MINUTES = 12 * 60 + 20;
const LUNCH_GAP_END_MINUTES = 12 * 60 + 55;

const LOG_ENABLED = true;

const THEME_DEFAULT = "default";
const THEME_NEW = "new";
const LUNCH_ROW_REDUCTION_MIN = 0;
const LUNCH_ROW_REDUCTION_MAX = 30;
const LUNCH_ROW_REDUCTION_DEFAULT = 0;
const NEW_THEME_STYLE_ID = "inna-attendance-theme-style";
const NEW_THEME_CSS_PATH = "new_theme.css";

const DEFAULT_SETTINGS = {
  language: "en",
  theme: THEME_DEFAULT,
  lunchRowReductionPercent: LUNCH_ROW_REDUCTION_DEFAULT,
  presentColor: "#22c55e",
  absentColor: "#ef4444"
};

const I18N = {
  en: {
    panelTitle: "Attendance sync",
    refreshButton: "Refresh attendance",
    refreshingButton: "Refreshing...",
    waitingStatus: "Waiting for sync",
    waitingTimetableStatus: "Attendance: waiting for timetable",
    noRowsStatus: "Attendance: no timetable rows",
    loadingStatus: "Attendance: loading...",
    manualRefreshStatus: "Attendance: manual refresh...",
    retryingStatus: "Attendance: retrying ({current}/{max})",
    notReadyStatus: "Attendance: not ready, use Refresh attendance",
    parseFailedStatus: "Attendance: parse failed, use Refresh attendance",
    freeGapLabel: "Free time",
    lunchGapLabel: "Lunch time",
    readyDetailedStatus: "Attendance: ready ({matched}/{total} matched)",
    updatedStatus: "Attendance: updated ({matched}/{total} matched)",
    restoredStatus: "Attendance: restored cached result ({matched}/{total} matched)",
    errorStatus: "Attendance: error"
  },
  is: {
    panelTitle: "M\u00E6tingarsamstilling",
    refreshButton: "Uppf\u00E6ra m\u00E6tingu",
    refreshingButton: "Uppf\u00E6ri...",
    waitingStatus: "B\u00ED\u00F0 eftir samstillingu",
    waitingTimetableStatus: "M\u00E6ting: b\u00ED\u00F0 eftir stundat\u00F6flu",
    noRowsStatus: "M\u00E6ting: engir t\u00EDmar fundust",
    loadingStatus: "M\u00E6ting: s\u00E6ki g\u00F6gn...",
    manualRefreshStatus: "M\u00E6ting: handvirk uppf\u00E6rsla...",
    retryingStatus: "M\u00E6ting: reyni aftur ({current}/{max})",
    notReadyStatus: "M\u00E6ting: g\u00F6gn ekki tilb\u00FAin, nota\u00F0u \"Uppf\u00E6ra m\u00E6tingu\"",
    parseFailedStatus: "M\u00E6ting: t\u00F3kst ekki a\u00F0 lesa g\u00F6gn, nota\u00F0u \"Uppf\u00E6ra m\u00E6tingu\"",
    freeGapLabel: "Laust bil",
    lunchGapLabel: "H\u00E1degishl\u00E9",
    readyDetailedStatus: "M\u00E6ting: tilb\u00FAin ({matched}/{total} p\u00F6ru\u00F0)",
    updatedStatus: "M\u00E6ting: uppf\u00E6rt ({matched}/{total} p\u00F6ru\u00F0)",
    restoredStatus: "M\u00E6ting: endurheimti skyndiminni ({matched}/{total} p\u00F6ru\u00F0)",
    errorStatus: "M\u00E6ting: villa"
  }
};

let settings = { ...DEFAULT_SETTINGS };

let booted = false;
let storageListenerBound = false;

let runTimer = null;
let uiSyncTimer = null;
let activeRun = null;

let autoParseLocked = false;
let autoRetryCount = 0;

let observer = null;
let observerRoot = null;
let attendanceIframe = null;

let refreshButtonBusy = false;
let statusState = { key: "waitingStatus", vars: {} };

let cachedAttendance = null;
// {
//   dayKey,
//   textHash,
//   fullText,
//   dayChunk,
//   lessons,
//   map
// }

void init();

function info(message, meta) {
  if (!LOG_ENABLED) return;
  if (meta !== undefined) {
    console.log("[IAC]", message, meta);
  } else {
    console.log("[IAC]", message);
  }
}

function warnLog(message, meta) {
  if (!LOG_ENABLED) return;
  if (meta !== undefined) {
    console.warn("[IAC]", message, meta);
  } else {
    console.warn("[IAC]", message);
  }
}

function errorLog(message, err) {
  console.error("[IAC]", message, err);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function init() {
  if (booted) return;
  booted = true;

  await loadSettings();

  injectBaseStyles();
  applySettingsToCss();
  applyThemeStyles();
  ensureRefreshPanel();
  refreshObserverRoot();
  bindStorageListener();

  scheduleRun("init", false, 800);

  window.addEventListener("popstate", () => {
    ensureRefreshPanel();
    refreshObserverRoot();
    scheduleRun("history-navigation", false, 700);
  });

  window.addEventListener("hashchange", () => {
    ensureRefreshPanel();
    refreshObserverRoot();

    if (!isOnDashboard()) return;

    unlockIfDisplayedDayChanged();
    if (cachedAttendance) {
      scheduleUiSync("hashchange-cache");
    }

    if (!autoParseLocked && !activeRun) {
      scheduleRun("hashchange", false, 700);
    }
  });

  window.addEventListener("focus", () => {
    ensureRefreshPanel();
    if (cachedAttendance) scheduleUiSync("focus-cache");
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      ensureRefreshPanel();
      if (cachedAttendance) scheduleUiSync("visibility-cache");
    }
  });
}

function bindStorageListener() {
  if (storageListenerBound) return;
  storageListenerBound = true;

  if (!chrome?.storage?.onChanged) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    let changed = false;
    const next = { ...settings };

    if (changes.language) {
      next.language = changes.language.newValue;
      changed = true;
    }

    if (changes.presentColor) {
      next.presentColor = changes.presentColor.newValue;
      changed = true;
    }

    if (changes.absentColor) {
      next.absentColor = changes.absentColor.newValue;
      changed = true;
    }

    if (changes.theme) {
      next.theme = changes.theme.newValue;
      changed = true;
    }

    if (changes.lunchRowReductionPercent) {
      next.lunchRowReductionPercent = changes.lunchRowReductionPercent.newValue;
      changed = true;
    }

    if (changes.lunchRowStyle) {
      next.lunchRowReductionPercent = normalizeLunchRowReductionPercent(changes.lunchRowStyle.newValue);
      changed = true;
    }

    if (!changed) return;

    settings = sanitizeSettings(next);
    applySettingsToCss();
    applyThemeStyles();
    updatePanelTexts();

    if (cachedAttendance) {
      applyCachedStateToCurrentLayout("settings-change");
    }
  });
}

function isOnDashboard() {
  const hash = (location.hash || "#/ ").trim();
  return DASHBOARD_HASHES.has(hash) || /#\/(?:home|dashboard|timetable|schedule)(?:[/?]|$)/i.test(hash);
}

function scheduleRun(reason, forceManual = false, delay = RUN_DEBOUNCE_MS) {
  clearTimeout(runTimer);
  runTimer = setTimeout(() => {
    void run(reason, forceManual);
  }, delay);
}

function scheduleUiSync(reason = "ui-sync") {
  clearTimeout(uiSyncTimer);
  uiSyncTimer = setTimeout(() => {
    applyCachedStateToCurrentLayout(reason);
  }, UI_SYNC_DEBOUNCE_MS);
}

async function run(reason = "manual", forceManual = false) {
  if (!forceManual && autoParseLocked) {
    applyCachedStateToCurrentLayout("locked-cache-sync");
    return;
  }

  if (activeRun) {
    return activeRun;
  }

  activeRun = (async () => {
    if (!isOnDashboard()) return;

    ensureRefreshPanel();
    refreshObserverRoot();

    const todayInfo = getDashboardDayInfo();
    if (!todayInfo) {
      setStatus("waitingTimetableStatus");
      return;
    }

    removeDashboardGapRows();
    const dashboardRows = getDashboardLessonRows();
    if (!dashboardRows.length) {
      setStatus("noRowsStatus");
      return;
    }

    syncDashboardGapRows(dashboardRows);

    if (!forceManual && canUseCachedAttendance(todayInfo)) {
      colorDashboardRows(todayInfo, dashboardRows, cachedAttendance.map);
      setStatus("readyDetailedStatus", {
        matched: cachedAttendance.map.size,
        total: dashboardRows.length
      });
      autoParseLocked = true;
      return;
    }

    setRowsLoading(dashboardRows);
    setRefreshButtonBusy(forceManual);
    setStatus(forceManual ? "manualRefreshStatus" : "loadingStatus");
    info("parse:start", { reason, manual: forceManual });

    const snapshot = await loadAttendanceSnapshot(todayInfo, forceManual);

    if (!snapshot.ready || (!snapshot.lessons && !snapshot.cached && !snapshot.text?.length)) {
      setRowsIdle(dashboardRows);

      if (!forceManual && cachedAttendance && canUseCachedAttendance(todayInfo)) {
        colorDashboardRows(todayInfo, dashboardRows, cachedAttendance.map);
        setStatus("restoredStatus", {
          matched: cachedAttendance.map.size,
          total: dashboardRows.length
        });
        autoParseLocked = true;
        return;
      }

      if (!forceManual && autoRetryCount < MAX_AUTO_RETRIES) {
        autoRetryCount += 1;
        setStatus("retryingStatus", {
          current: autoRetryCount,
          max: MAX_AUTO_RETRIES
        });
        warnLog("parse:retry", autoRetryCount);
        scheduleRun(`auto-retry-${autoRetryCount}`, false, AUTO_RETRY_DELAY);
      } else {
        setStatus("notReadyStatus");
        warnLog("parse:not-ready");
      }

      return;
    }

    const parsed = snapshot.cached || (snapshot.lessons
      ? buildAttendanceDataFromLessons(snapshot.lessons, todayInfo, dashboardRows, snapshot.text)
      : buildAttendanceDataFromText(snapshot.text, todayInfo, dashboardRows));

    if (!parsed.lessons.length) {
      setRowsIdle(dashboardRows);

      if (!forceManual && cachedAttendance && canUseCachedAttendance(todayInfo)) {
        colorDashboardRows(todayInfo, dashboardRows, cachedAttendance.map);
        setStatus("restoredStatus", {
          matched: cachedAttendance.map.size,
          total: dashboardRows.length
        });
        autoParseLocked = true;
        return;
      }

      if (!forceManual && autoRetryCount < MAX_AUTO_RETRIES) {
        autoRetryCount += 1;
        setStatus("retryingStatus", {
          current: autoRetryCount,
          max: MAX_AUTO_RETRIES
        });
        warnLog("parse:retry", autoRetryCount);
        scheduleRun(`auto-retry-${autoRetryCount}`, false, AUTO_RETRY_DELAY);
      } else {
        setStatus("parseFailedStatus");
        warnLog("parse:not-ready");
      }

      return;
    }

    cachedAttendance = parsed;
    colorDashboardRows(todayInfo, dashboardRows, parsed.map);

    setStatus("updatedStatus", {
      matched: parsed.map.size,
      total: dashboardRows.length
    });

    autoParseLocked = true;
    autoRetryCount = 0;

    info("parse:ready", {
      matched: parsed.map.size,
      total: dashboardRows.length
    });
  })()
    .catch(err => {
      errorLog("parse:error", err);
      setStatus("errorStatus");

      const rows = getDashboardLessonRows();
      if (rows.length) setRowsIdle(rows);
    })
    .finally(() => {
      activeRun = null;
      setRefreshButtonBusy(false);
    });

  return activeRun;
}

async function loadSettings() {
  try {
    const stored = await storageGet(DEFAULT_SETTINGS);
    settings = sanitizeSettings(stored);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function storageGet(defaults) {
  return new Promise(resolve => {
    chrome.storage.sync.get(defaults, items => resolve(items));
  });
}

function sanitizeSettings(raw) {
  return {
    language: raw?.language === "is" ? "is" : "en",
    theme: normalizeTheme(raw?.theme),
    lunchRowReductionPercent: normalizeLunchRowReductionPercent(
      raw?.lunchRowReductionPercent ?? raw?.lunchRowStyle
    ),
    presentColor: normalizeHexColor(raw?.presentColor, DEFAULT_SETTINGS.presentColor),
    absentColor: normalizeHexColor(raw?.absentColor, DEFAULT_SETTINGS.absentColor)
  };
}

function normalizeTheme(value) {
  return value === THEME_NEW ? THEME_NEW : THEME_DEFAULT;
}

function normalizeLunchRowReductionPercent(value) {
  if (value === "compact") return LUNCH_ROW_REDUCTION_MAX;
  if (value === "normal") return LUNCH_ROW_REDUCTION_DEFAULT;

  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return LUNCH_ROW_REDUCTION_DEFAULT;

  return Math.min(LUNCH_ROW_REDUCTION_MAX, Math.max(LUNCH_ROW_REDUCTION_MIN, parsed));
}

function tr(key, vars = {}) {
  const lang = settings.language === "is" ? "is" : "en";
  let text = I18N[lang][key] || I18N.en[key] || key;

  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }

  return text;
}

function setStatus(key, vars = {}) {
  statusState = { key, vars };
  const el = document.getElementById("inna-att-status");
  if (el) el.textContent = tr(key, vars);
}

function updatePanelTexts() {
  const title = document.getElementById("inna-att-panel-title");
  if (title) title.textContent = tr("panelTitle");

  const btn = document.getElementById("inna-att-refresh-btn");
  if (btn) {
    btn.textContent = refreshButtonBusy ? tr("refreshingButton") : tr("refreshButton");
  }

  const status = document.getElementById("inna-att-status");
  if (status) {
    status.textContent = tr(statusState.key, statusState.vars);
  }
}

function setRefreshButtonBusy(isBusy) {
  refreshButtonBusy = isBusy;
  const btn = document.getElementById("inna-att-refresh-btn");
  if (!btn) return;
  btn.disabled = isBusy;
  btn.textContent = isBusy ? tr("refreshingButton") : tr("refreshButton");
}

function injectBaseStyles() {
  if (document.getElementById("inna-attendance-base-style")) return;

  const style = document.createElement("style");
  style.id = "inna-attendance-base-style";
  style.textContent = `
    .inna-att-time-cell {
      position: relative !important;
      padding-left: 18px !important;
      box-sizing: border-box;
      overflow: visible !important;
    }

    .inna-att-indicator {
      position: absolute;
      left: 4px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      z-index: 20;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      box-shadow: 0 1px 3px rgba(0,0,0,.14);
      border: 2px solid #fff;
      pointer-events: none;
    }

    .inna-att-indicator--hidden {
      display: none !important;
    }

    .inna-att-indicator--loading {
      background: #60a5fa;
      color: transparent;
    }

    .inna-att-indicator--loading::after {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      border: 2px solid rgba(255,255,255,.45);
      border-top-color: #fff;
      animation: inna-spin .8s linear infinite;
    }

    .inna-att-panel {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      margin-top: 8px;
      background: linear-gradient(180deg, #6f7891 0%, #616b84 100%);
      color: #fff;
      border-top: 1px solid rgba(255,255,255,.08);
    }

    .inna-att-panel-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .inna-att-panel-title {
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
    }

    .inna-att-panel-status {
      font-size: 12px;
      color: rgba(255,255,255,.86);
      line-height: 1.2;
    }

    .inna-att-refresh-btn {
      appearance: none;
      border: 1px solid rgba(255,255,255,.18);
      background: rgba(255,255,255,.16);
      color: #fff;
      border-radius: 4px;
      padding: 7px 12px;
      font-size: 12px;
      line-height: 1.2;
      cursor: pointer;
      white-space: nowrap;
    }

    .inna-att-refresh-btn:hover {
      background: rgba(255,255,255,.24);
    }

    .inna-att-refresh-btn:disabled {
      opacity: .7;
      cursor: wait;
    }

    .inna-att-gap-row { display: flex; align-items: center; gap: 18px; min-height: 32px; padding: 8px 12px; }
    tr.inna-att-gap-row { display: table-row; }
    .inna-att-gap-row--free:not(tr) { background: rgba(148, 163, 184, 0.14) !important; }
    .inna-att-gap-row--lunch:not(tr) { background: rgba(251, 191, 36, 0.18) !important; }
    .inna-att-gap-row--free > td,
    .inna-att-gap-row--free > [role="cell"] {
      background: rgba(148, 163, 184, 0.14) !important;
      color: #3f4f63 !important;
      border-top: 1px dashed rgba(100, 116, 139, 0.55) !important;
      font-style: italic;
    }
    .inna-att-gap-row--lunch > td,
    .inna-att-gap-row--lunch > [role="cell"] {
      background: rgba(251, 191, 36, 0.18) !important;
      color: #6b4f00 !important;
      border-top: 1px dashed rgba(180, 126, 0, 0.6) !important;
      font-style: italic;
    }

    .inna-att-gap-row--lunch.inna-att-gap-row--lunch-scaled > td,
    .inna-att-gap-row--lunch.inna-att-gap-row--lunch-scaled > [role="cell"] {
      font-size: calc(100% * var(--inna-att-lunch-scale-factor, 1)) !important;
      line-height: calc(1.2 * var(--inna-att-lunch-scale-factor, 1)) !important;
      padding-top: calc(8px * var(--inna-att-lunch-scale-factor, 1)) !important;
      padding-bottom: calc(8px * var(--inna-att-lunch-scale-factor, 1)) !important;
    }
    .inna-att-gap-time {
      opacity: 0.95;
    }

    .inna-att-gap-label {
      font-weight: 600;
      letter-spacing: 0.15px;
    }

    @keyframes inna-spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

function applySettingsToCss() {
  let style = document.getElementById("inna-attendance-dynamic-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "inna-attendance-dynamic-style";
    document.head.appendChild(style);
  }

  const present = settings.presentColor;
  const absent = settings.absentColor;

  style.textContent = `
    .inna-att-green, .inna-att-green > td {
      background: ${hexToRgba(present, 0.18)} !important;
      border-left: 4px solid ${present} !important;
      box-shadow: inset 0 0 0 9999px ${hexToRgba(present, 0.06)};
    }

    .inna-att-red, .inna-att-red > td {
      background: ${hexToRgba(absent, 0.18)} !important;
      border-left: 4px solid ${absent} !important;
      box-shadow: inset 0 0 0 9999px ${hexToRgba(absent, 0.06)};
    }
  `;
}

function applyThemeStyles() {
  const theme = normalizeTheme(settings.theme);
  if (theme === THEME_NEW) {
    ensureNewThemeStyle();
    return;
  }

  removeNewThemeStyle();
}

function ensureNewThemeStyle() {
  if (document.getElementById(NEW_THEME_STYLE_ID)) return;

  const link = document.createElement("link");
  link.id = NEW_THEME_STYLE_ID;
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = chrome.runtime.getURL(NEW_THEME_CSS_PATH);

  (document.head || document.documentElement).appendChild(link);
}

function removeNewThemeStyle() {
  const node = document.getElementById(NEW_THEME_STYLE_ID);
  if (node) node.remove();
}
function refreshObserverRoot() {
  const nextRoot = findTimetableModuleRoot() || document.body || document.documentElement;
  if (!nextRoot) return;

  if (observer && observerRoot === nextRoot) return;

  if (observer) observer.disconnect();

  observerRoot = nextRoot;
  observer = new MutationObserver(onObservedMutation);
  observer.observe(observerRoot, {
    childList: true,
    subtree: true
  });
}

function onObservedMutation(mutations) {
  if (!isOnDashboard()) return;
  if (mutationsAreOnlyOurUi(mutations)) return;

  unlockIfDisplayedDayChanged();
  ensureRefreshPanel();

  if (cachedAttendance) {
    scheduleUiSync("mutation-cache");
  }

  if (!autoParseLocked && !activeRun) {
    const todayInfo = getDashboardDayInfo();
    const rows = getDashboardLessonRows();

    if (todayInfo && rows.length) {
      scheduleRun("mutation", false, 700);
    }
  }
}

function mutationsAreOnlyOurUi(mutations) {
  return mutations.every(m => {
    const nodes = [...m.addedNodes, ...m.removedNodes];
    if (!nodes.length) return true;

    return nodes.every(node => {
      if (!(node instanceof HTMLElement)) return true;
      if (node.id === "inna-att-panel") return true;
      if (node.id === "inna-attendance-hidden-frame") return true;
      if (node.id === "inna-attendance-base-style") return true;
      if (node.id === "inna-attendance-dynamic-style") return true;
      if (node.id === NEW_THEME_STYLE_ID) return true;
      if (node.classList.contains("inna-att-gap-row")) return true;
      if (node.closest?.(".inna-att-gap-row")) return true;
      if (node.classList.contains("inna-att-indicator")) return true;
      if (node.closest?.("#inna-att-panel")) return true;
      return false;
    });
  });
}

function unlockIfDisplayedDayChanged() {
  const current = getDashboardDayInfo();
  if (!current || !cachedAttendance) return;
  if (cachedAttendance.dayKey !== makeDayKey(current)) {
    autoParseLocked = false;
    autoRetryCount = 0;
    if (!activeRun) scheduleRun("displayed-day-changed", false, 350);
  }
}

function applyCachedStateToCurrentLayout() {
  if (!cachedAttendance || !isOnDashboard()) return;

  ensureRefreshPanel();

  const todayInfo = getDashboardDayInfo();
  if (!todayInfo) return;
  if (makeDayKey(todayInfo) !== cachedAttendance.dayKey) return;

  removeDashboardGapRows();
  const rows = getDashboardLessonRows();
  if (!rows.length) return;

  syncDashboardGapRows(rows);

  colorDashboardRows(todayInfo, rows, cachedAttendance.map);
  setStatus("readyDetailedStatus", {
    matched: cachedAttendance.map.size,
    total: rows.length
  });
}

function ensureRefreshPanel() {
  if (!isOnDashboard()) return;

  const timetableTable = findTimetableTable() || getDashboardLessonRows()[0]?.element?.parentElement;
  if (!timetableTable) return;

  let panel = document.getElementById("inna-att-panel");
  if (panel && panel.isConnected) {
    updatePanelTexts();
    return;
  }

  panel = document.createElement("div");
  panel.id = "inna-att-panel";
  panel.className = "inna-att-panel";

  const left = document.createElement("div");
  left.className = "inna-att-panel-left";

  const title = document.createElement("div");
  title.id = "inna-att-panel-title";
  title.className = "inna-att-panel-title";
  title.textContent = tr("panelTitle");

  const status = document.createElement("div");
  status.id = "inna-att-status";
  status.className = "inna-att-panel-status";
  status.textContent = tr(statusState.key, statusState.vars);

  left.appendChild(title);
  left.appendChild(status);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "inna-att-refresh-btn";
  btn.className = "inna-att-refresh-btn";
  btn.textContent = refreshButtonBusy ? tr("refreshingButton") : tr("refreshButton");
  btn.disabled = refreshButtonBusy;
  btn.addEventListener("click", async () => {
    await manualRefresh();
  });

  panel.appendChild(left);
  panel.appendChild(btn);
  timetableTable.insertAdjacentElement("afterend", panel);
}

function findTimetableHeader() {
  const candidates = document.querySelectorAll(
    ".panel-inna-dashboard .panel-heading-title, .panel-heading-title, h1,h2,h3,h4,[role='heading'],.card-header,.widget-title"
  );
  return [...candidates].find(el => /^(?:Timetable|Stundatafla|Schedule|Stundaskrá)/i.test(normalizeText(el.textContent))) || null;
}

function findTimetableModuleRoot() {
  const header = findTimetableHeader();
  if (header) {
    const dashboard = header.closest(".panel-inna-dashboard");
    if (dashboard?.querySelector("table.inna-panel-table")) return dashboard;
    let cur = header;
    for (let i = 0; i < 7 && cur; i++, cur = cur.parentElement) {
      if (cur.querySelector("table, [role='table'], [role='grid']") ||
          cur.querySelectorAll("[role='row'], .lesson-row, .timetable-row").length >= 2) return cur;
    }
  }
  return document.querySelector("[data-testid*='timetable' i], [class*='timetable-panel' i], [class*='stundatafla' i]");
}

function findTimetableTable() {
  const root = findTimetableModuleRoot();
  if (!root) return null;
  const tables = [...root.querySelectorAll("table, [role='table'], [role='grid']")];
  return tables.find(table => {
    const text = normalizeText(table.innerText || table.textContent || "");
    return /\b\d{1,2}:\d{2}\b/.test(text) && /[A-ZÁÉÍÓÚÝÞÆÖÐ]{2,}\d/i.test(text);
  }) || null;
}

async function manualRefresh() {
  autoParseLocked = false;
  autoRetryCount = 0;
  setRefreshButtonBusy(true);
  setStatus("manualRefreshStatus");
  await run("manual-refresh", true);
}

function buildAttendanceUrl(forceReload = false) {
  if (!forceReload) {
    return `${ATTENDANCE_PAGE_BASE}${ATTENDANCE_HASH}`;
  }
  return `${ATTENDANCE_PAGE_BASE}?_iac_ts=${Date.now()}${ATTENDANCE_HASH}`;
}

async function ensureAttendanceIframe(forceReload = false) {
  if (!attendanceIframe || !attendanceIframe.isConnected) {
    attendanceIframe = document.createElement("iframe");
    attendanceIframe.id = "inna-attendance-hidden-frame";
    attendanceIframe.style.position = "fixed";
    attendanceIframe.style.width = "1px";
    attendanceIframe.style.height = "1px";
    attendanceIframe.style.opacity = "0";
    attendanceIframe.style.pointerEvents = "none";
    attendanceIframe.style.left = "-9999px";
    attendanceIframe.style.top = "-9999px";
    document.body.appendChild(attendanceIframe);

    await navigateIframe(attendanceIframe, buildAttendanceUrl(true));
    await sleep(500);
    return attendanceIframe;
  }

  if (forceReload) {
    await navigateIframe(attendanceIframe, buildAttendanceUrl(true));
    await sleep(500);
    return attendanceIframe;
  }

  try {
    const win = attendanceIframe.contentWindow;
    if (!win || win.location.hash !== ATTENDANCE_HASH) {
      await navigateIframe(attendanceIframe, buildAttendanceUrl(true));
      await sleep(500);
    }
  } catch {
    await navigateIframe(attendanceIframe, buildAttendanceUrl(true));
    await sleep(500);
  }

  return attendanceIframe;
}

async function navigateIframe(iframe, url) {
  await new Promise(resolve => {
    const done = () => {
      iframe.removeEventListener("load", done);
      resolve();
    };

    iframe.addEventListener("load", done, { once: true });
    iframe.src = url;
  });
}

async function loadAttendanceSnapshot(todayInfo, forceManual = false) {
  const iframe = await ensureAttendanceIframe(forceManual);
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    let doc = null;
    try { doc = iframe.contentDocument; } catch { /* Access denied until loaded */ }
    const calendar = doc?.querySelector(".fc-time-grid, .fc-view");
    const parsed = calendar ? parseFullCalendarAttendance(doc, todayInfo) : null;
    if (parsed?.dateFound && parsed.lessons.length) {
      return { ready: true, lessons: parsed.lessons, text: getIframeNormalizedText(iframe), source: "calendar-dom" };
    }
    // Legacy layouts may expose text rather than FullCalendar; never fall back
    // to text if a calendar is present for a different date/week.
    const text = getIframeNormalizedText(iframe);
    if (!calendar && isAttendanceTextReady(text)) {
      return { ready: true, text, source: "legacy-text" };
    }
    if (attempt === 10 || attempt === 19) {
      try { await navigateIframe(iframe, buildAttendanceUrl(true)); } catch {}
    }
    await sleep(SNAPSHOT_POLL_MS);
  }
  if (!forceManual && cachedAttendance && cachedAttendance.dayKey === makeDayKey(todayInfo)) {
    return { ready: true, cached: cachedAttendance, source: "cache-fallback" };
  }
  return { ready: false, text: getIframeNormalizedText(iframe), source: "not-ready" };
}

// In FullCalendar's agendaWeek view each fc-content-skeleton table cell
// corresponds to the day header with the same column position. The first
// column is the time axis; dates are read from actual data-date attributes.
function parseFullCalendarAttendance(doc, todayInfo) {
  const headers = [...doc.querySelectorAll(".fc-day-header[data-date]")];
  const target = `${todayInfo.dayNum}/${todayInfo.monthNum}`;
  const targetHeader = headers.find(el => {
    const date = el.getAttribute("data-date") || "";
    const m = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m && `${m[2]}/${m[1]}` === target;
  });
  if (!targetHeader) return { dateFound: false, lessons: [] };
  const date = targetHeader.getAttribute("data-date");
  const index = headers.indexOf(targetHeader);
  const view = targetHeader.closest(".fc-view") || doc;
  const skeletons = [...view.querySelectorAll(".fc-time-grid .fc-content-skeleton")];
  const lessons = [];
  for (const skeleton of skeletons) {
    const columnCells = [...skeleton.querySelectorAll(":scope > table > tbody > tr > td")];
    // FullCalendar layouts use an extra first cell for the time axis.
    const column = columnCells.length === headers.length + 1
      ? columnCells[index + 1] : columnCells[index];
    if (!column) continue;
    for (const event of column.querySelectorAll(".fc-time-grid-event")) {
      const content = event.querySelector(".fc-content") || event;
      const range = normalizeText(content.querySelector(".fc-time")?.textContent || "")
        .match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
      if (!range) continue;
      const copy = content.cloneNode(true);
      copy.querySelector(".fc-time")?.remove();
      // Avoid including icon title/teacher information in the status match.
      const courseText = normalizeText(copy.textContent || "");
      const match = courseText.match(/([A-ZÁÉÍÓÚÝÞÆÖÐ][A-ZÁÉÍÓÚÝÞÆÖÐ0-9]+)\s*[-–]\s*(\d+)(?:\s+([A-ZÁÉÍÓÚÝÞÆÖÐ]))?(?:\s|$)/iu);
      if (!match) continue;
      const rawStatus = match[3]?.toUpperCase() || null;
      lessons.push({
        date,
        start: normalizeTime(range[1]),
        end: normalizeTime(range[2]),
        code: normalizeCode(match[1]),
        group: match[2],
        status: VALID_ATTENDANCE_CODES.has(rawStatus) ? rawStatus : null
      });
    }
  }
  return { dateFound: true, lessons };
}

function getIframeNormalizedText(iframe) {
  try {
    return normalizeText(iframe.contentDocument?.body?.innerText || "");
  } catch {
    return "";
  }
}

function isAttendanceTextReady(text) {
  if (!text) return false;

  const normalized = normalizeText(text);
  if (normalized.length < 60) return false;

  const hasLessonRows =
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+[A-Z\u00C1\u00C9\u00CD\u00D3\u00DA\u00DD\u00DE\u00C6\u00D60-9]+-\d+/u.test(normalized);

  const hasAnyTimeRange =
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.test(normalized);

  return hasLessonRows || hasAnyTimeRange;
}

function getDashboardDayInfo() {
  const root = findTimetableModuleRoot() || document.body;
  const subtitle = root.querySelector(".panel-heading-subtitle");
  const text = normalizeText(subtitle?.textContent || root.innerText || "");
  const days = { monday:"Monday", tuesday:"Tuesday", wednesday:"Wednesday", thursday:"Thursday", friday:"Friday",
    mánudagur:"Monday", þriðjudagur:"Tuesday", miðvikudagur:"Wednesday", fimmtudagur:"Thursday", föstudagur:"Friday",
    mán:"Monday", þri:"Tuesday", mið:"Wednesday", fim:"Thursday", fös:"Friday" };
  const re = /\b(monday|tuesday|wednesday|thursday|friday|mánudagur|þriðjudagur|miðvikudagur|fimmtudagur|föstudagur|mán|þri|mið|fim|fös)\s+(\d{1,2})[./](\d{1,2})\b/iu;
  const match = text.match(re);
  if (match) return { dayName: days[match[1].toLowerCase()], dayNum: match[2].padStart(2,"0"), monthNum: match[3].padStart(2,"0") };
  // Do not guess the displayed day: coloring the wrong date is worse than leaving rows uncolored.
  return null;
}

function getDashboardLessonRows() {
  const root = findTimetableModuleRoot() || document;
  const courseRe = /([A-ZÁÉÍÓÚÝÞÆÖÐ]{2,}[A-ZÁÉÍÓÚÝÞÆÖÐ0-9]*)\s*(?:\(\s*(\d+)\s*\)|[-–]\s*(\d+))/iu;
  const timeRe = /(\d{1,2}:\d{2})\s*(?:[-–—]|\s+)\s*(\d{1,2}:\d{2})/;
  const candidates = [...root.querySelectorAll("tr, [role='row'], .lesson-row, .timetable-row, [data-testid*='lesson' i], [class*='lesson-item' i]")];
  // Keep old course-link support for tables whose rows lack a stable class.
  for (const a of root.querySelectorAll('a[href*="#/NewModules/"], a[href*="course" i]')) {
    const row = a.closest("tr,[role='row'],.lesson-row,.timetable-row") || findUsefulContainer(a);
    if (row && !candidates.includes(row)) candidates.push(row);
  }
  const seen = new Set();
  return candidates.map(row => {
    if (row.closest("#inna-att-panel, #inna-attendance-hidden-frame") || row.classList.contains("inna-att-gap-row")) return null;
    const text = normalizeText(row.innerText || "");
    const time = text.match(timeRe);
    const course = text.match(courseRe);
    if (!time || !course) return null;
    const start = normalizeTime(time[1]);
    const end = normalizeTime(time[2]);
    if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) return null;
    const key = [start,end,course[1],course[2] || course[3]].join("|");
    if (seen.has(key)) return null;
    seen.add(key);
    const timeCell = findLikelyTimeCell(row);
    return { element:row, timeCell, start, end, code:normalizeCode(course[1]), group:course[2] || course[3] };
  }).filter(Boolean).sort((a,b) => parseTimeToMinutes(a.start)-parseTimeToMinutes(b.start));
}

function syncDashboardGapRows(rows) {
  removeDashboardGapRows();

  if (!Array.isArray(rows) || rows.length < 2) return;

  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i];
    const next = rows[i + 1];

    if (!current?.element || !next?.element) continue;
    if (!current.element.isConnected || !next.element.isConnected) continue;
    if (current.element.parentElement !== next.element.parentElement) continue;

    const gapStart = normalizeTime(current.end);
    const gapEnd = normalizeTime(next.start);

    const gapStartMinutes = parseTimeToMinutes(gapStart);
    const gapEndMinutes = parseTimeToMinutes(gapEnd);

    if (gapStartMinutes === null || gapEndMinutes === null) continue;
    if (gapEndMinutes <= gapStartMinutes) continue;

    // Preserve a distinct lunch row when a longer free period surrounds lunch.
    const segments = [];
    if (gapStartMinutes <= LUNCH_GAP_START_MINUTES && gapEndMinutes >= LUNCH_GAP_END_MINUTES) {
      if (LUNCH_GAP_START_MINUTES - gapStartMinutes >= MIN_FREE_GAP_MINUTES) {
        segments.push([gapStartMinutes, LUNCH_GAP_START_MINUTES, "free"]);
      }
      segments.push([LUNCH_GAP_START_MINUTES, LUNCH_GAP_END_MINUTES, "lunch"]);
      if (gapEndMinutes - LUNCH_GAP_END_MINUTES >= MIN_FREE_GAP_MINUTES) {
        segments.push([LUNCH_GAP_END_MINUTES, gapEndMinutes, "free"]);
      }
    } else {
      const kind = classifyGapKind(gapStartMinutes, gapEndMinutes);
      if (kind) segments.push([gapStartMinutes, gapEndMinutes, kind]);
    }
    let insertionAnchor = current.element;
    for (const [start, end, kind] of segments) {
      const gapRow = buildDashboardGapRow(current.element,
        minutesToTime(start), minutesToTime(end), end - start, kind);
      if (gapRow) {
        insertionAnchor.insertAdjacentElement("afterend", gapRow);
        insertionAnchor = gapRow;
      }
    }
  }
}

function removeDashboardGapRows() {
  document.querySelectorAll(".inna-att-gap-row").forEach(node => node.remove());
}

function buildDashboardGapRow(referenceRow, startTime, endTime, gapMinutes, gapKind) {
  const row = referenceRow.cloneNode(true);
  row.classList.remove("inna-att-green", "inna-att-red");
  row.classList.add("inna-att-gap-row");
  row.classList.add(gapKind === "lunch" ? "inna-att-gap-row--lunch" : "inna-att-gap-row--free");

  const lunchRowReductionPercent = normalizeLunchRowReductionPercent(settings.lunchRowReductionPercent);
  if (gapKind === "lunch" && lunchRowReductionPercent > 0) {
    const scaleFactor = 1 - lunchRowReductionPercent / 100;
    row.classList.add("inna-att-gap-row--lunch-scaled");
    row.style.setProperty("--inna-att-lunch-scale-factor", String(scaleFactor));
  }

  row.querySelectorAll(".inna-att-indicator").forEach(node => node.remove());

  const cells = row.querySelectorAll("td, [role='cell']");
  if (!cells.length) {
    row.replaceChildren();
    const time = document.createElement("span");
    time.className = "inna-att-gap-time";
    time.textContent = `${startTime} – ${endTime}`;
    const label = document.createElement("span");
    label.className = "inna-att-gap-label";
    label.textContent = `${tr(gapKind === "lunch" ? "lunchGapLabel" : "freeGapLabel")} (${formatGapDuration(gapMinutes)})`;
    row.append(time, label);
    return row;
  }

  const timeCell = cells[0];
  timeCell.classList.remove("inna-att-time-cell");
  timeCell.classList.add("inna-att-gap-time");
  timeCell.innerHTML = `<b>${startTime}</b> <br><b>${endTime}</b>`;

  for (let i = 1; i < cells.length; i++) {
    cells[i].textContent = "";
  }

  if (cells[1]) {
    cells[1].classList.add("inna-att-gap-label");
    const labelKey = gapKind === "lunch" ? "lunchGapLabel" : "freeGapLabel";
    cells[1].textContent = `${tr(labelKey)} (${formatGapDuration(gapMinutes)})`;
  }

  return row;
}

function minutesToTime(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function parseTimeToMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function classifyGapKind(startMinutes, endMinutes) {
  const gapMinutes = endMinutes - startMinutes;

  const isLunchGap =
    startMinutes === LUNCH_GAP_START_MINUTES &&
    endMinutes === LUNCH_GAP_END_MINUTES;

  if (isLunchGap) return "lunch";
  if (gapMinutes >= MIN_FREE_GAP_MINUTES) return "free";
  return null;
}

function formatGapDuration(totalMinutes) {
  const minutes = Math.max(1, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  const isIcelandic = settings.language === "is";

  if (hours && restMinutes) {
    return isIcelandic
      ? `${hours} klst ${restMinutes} m\u00EDn`
      : `${hours}h ${restMinutes}m`;
  }

  if (hours) {
    return isIcelandic ? `${hours} klst` : `${hours}h`;
  }

  return isIcelandic ? `${restMinutes} m\u00EDn` : `${restMinutes}m`;
}
function findLikelyTimeCell(row) {
  const cells = row.querySelectorAll("td, [role='cell']");
  if (cells?.[0]) return cells[0];
  return row.firstElementChild || row;
}

function buildAttendanceDataFromLessons(lessons, todayInfo, dashboardRows, fullText = "") {
  const dayKey = makeDayKey(todayInfo);
  const map = buildAttendanceMap(todayInfo, dashboardRows, lessons);
  return {
    dayKey,
    textHash: hashString(JSON.stringify(lessons)),
    fullText: normalizeText(fullText),
    dayChunk: "",
    lessons,
    map
  };
}

function buildAttendanceDataFromText(fullText, todayInfo, dashboardRows) {
  const normalizedFullText = normalizeText(fullText);
  const dayKey = makeDayKey(todayInfo);
  const textHash = hashString(normalizedFullText);

  if (
    cachedAttendance &&
    cachedAttendance.dayKey === dayKey &&
    cachedAttendance.textHash === textHash
  ) {
    return cachedAttendance;
  }

  const dayChunk = extractTodayChunk(normalizedFullText, todayInfo);
  const parseSource = dayChunk || normalizedFullText;
  const lessons = parseLessonsFromText(parseSource);
  const map = buildAttendanceMap(todayInfo, dashboardRows, lessons);

  const result = {
    dayKey,
    textHash,
    fullText: normalizedFullText,
    dayChunk,
    lessons,
    map
  };

  if (lessons.length) {
    cachedAttendance = result;
  }

  return result;
}

function extractTodayChunk(text, todayInfo) {
  const normalized = normalizeText(text);
  const dayNum = String(parseInt(todayInfo.dayNum, 10));
  const monthNum = String(parseInt(todayInfo.monthNum, 10));
  const shortDay = todayInfo.dayName.slice(0, 3);

  const markerPatterns = [
    new RegExp(`\\b${todayInfo.dayName}\\b\\s+0?${dayNum}[./]0?${monthNum}\\b`, "i"),
    new RegExp(`\\b${shortDay}\\b\\s+0?${dayNum}[./]0?${monthNum}\\b`, "i"),
    new RegExp(`\\b${todayInfo.dayName}\\b[^\\d]{0,10}0?${dayNum}[./]0?${monthNum}\\b`, "i")
  ];

  let start = -1;

  for (const pattern of markerPatterns) {
    const match = pattern.exec(normalized);
    if (match && typeof match.index === "number") {
      start = match.index;
      break;
    }
  }

  if (start === -1) return "";

  const rest = normalized.slice(start);
  const nextDayPattern =
    /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Mon|Tue|Wed|Thu|Fri)\b\s+\d{1,2}[./]\d{1,2}\b/i;
  const nextMatch = nextDayPattern.exec(rest.slice(1));

  if (!nextMatch || typeof nextMatch.index !== "number") {
    return rest;
  }

  return rest.slice(0, nextMatch.index + 1);
}

function parseLessonsFromText(text) {
  const lessons = [];
  const normalized = normalizeText(text);

  const regex =
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+([A-Z\u00C1\u00C9\u00CD\u00D3\u00DA\u00DD\u00DE\u00C6\u00D60-9]+)-(\d+)(?:\s+([A-Z\u00D3]))?(?=\s+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}|\s+Print\b|$)/gu;

  let match;
  while ((match = regex.exec(normalized)) !== null) {
    const rawStatus = match[5] ? String(match[5]).toUpperCase() : null;

    lessons.push({
      start: normalizeTime(match[1]),
      end: normalizeTime(match[2]),
      code: normalizeCode(match[3]),
      group: match[4],
      status: VALID_ATTENDANCE_CODES.has(rawStatus) ? rawStatus : null
    });
  }

  return lessons;
}

function buildAttendanceMap(todayInfo, dashboardRows, lessons) {
  const map = new Map();

  for (const row of dashboardRows) {
    const key = makeKey(todayInfo.dayName, row.start, row.end, row.code, row.group);

    const match = lessons.find(lesson =>
      lesson.start === row.start &&
      lesson.end === row.end &&
      lesson.code === row.code &&
      lesson.group === row.group
    );

    if (!match || !match.status) continue;
    map.set(key, match.status);
  }

  return map;
}

function colorDashboardRows(todayInfo, rows, attendanceMap) {
  for (const row of rows) {
    row.element.classList.remove("inna-att-green", "inna-att-red");

    const indicator = ensureRowIndicator(row.timeCell || row.element);
    const key = makeKey(todayInfo.dayName, row.start, row.end, row.code, row.group);
    const status = attendanceMap.get(key);

    setIndicatorState(indicator, "hidden");

    if (GREEN_CODES.has(status)) {
      row.element.classList.add("inna-att-green");
    } else if (RED_CODES.has(status)) {
      row.element.classList.add("inna-att-red");
    }
  }
}

function setRowsLoading(rows) {
  for (const row of rows) {
    const indicator = ensureRowIndicator(row.timeCell || row.element);
    setIndicatorState(indicator, "loading");
  }
}

function setRowsIdle(rows) {
  for (const row of rows) {
    const indicator = ensureRowIndicator(row.timeCell || row.element);
    setIndicatorState(indicator, "hidden");
  }
}

function ensureRowIndicator(targetElement) {
  targetElement.classList.add("inna-att-time-cell");

  let indicator = targetElement.querySelector(":scope > .inna-att-indicator");
  if (indicator) return indicator;

  indicator = document.createElement("span");
  indicator.className = "inna-att-indicator inna-att-indicator--hidden";
  targetElement.appendChild(indicator);
  return indicator;
}

function setIndicatorState(el, state) {
  const nextClass = `inna-att-indicator inna-att-indicator--${state}`;
  if (el.className !== nextClass) {
    el.className = nextClass;
  }
}

function canUseCachedAttendance(todayInfo) {
  return !!cachedAttendance && cachedAttendance.dayKey === makeDayKey(todayInfo);
}

function makeDayKey(todayInfo) {
  return `${todayInfo.dayName}|${todayInfo.dayNum}/${todayInfo.monthNum}`;
}

function makeKey(dayName, start, end, code, group) {
  return `${dayName}|${normalizeTime(start)}-${normalizeTime(end)}|${normalizeCode(code)}-${group}`;
}

function normalizeTime(value) {
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(value).trim();
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function normalizeCode(code) {
  return normalizeText(code).normalize("NFC").replace(/\s+/g, "");
}

function normalizeText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function findUsefulContainer(el) {
  let cur = el;
  for (let i = 0; i < 8 && cur; i++) {
    const text = normalizeText(cur.innerText || "");
    if (/\d{1,2}:\d{2}\s+\d{1,2}:\d{2}/.test(text)) return cur;
    cur = cur.parentElement;
  }
  return el.parentElement;
}

function hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeHexColor(value, fallback) {
  const raw = String(value || "").trim();

  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();

  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    const r = raw[1];
    const g = raw[2];
    const b = raw[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  return fallback;
}

function hexToRgba(hex, alpha) {
  const safe = normalizeHexColor(hex, "#000000");
  const value = safe.slice(1);
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

