const GREEN_CODES = new Set(["M", "X", "O"]);
const RED_CODES = new Set(["F", "V", "E"]);
const VALID_ATTENDANCE_CODES = new Set([...GREEN_CODES, ...RED_CODES]);

const DASHBOARD_HASHES = new Set(["#/", "#", ""]);
const ATTENDANCE_HASH = "#/AttendanceOverview";
const ATTENDANCE_PAGE_BASE = "https://nam.inna.is/Components/Students/Students.html";

const MAX_AUTO_RETRIES = 4;
const AUTO_RETRY_DELAY = 1600;
const RUN_DEBOUNCE_MS = 600;
const UI_SYNC_DEBOUNCE_MS = 180;
const SNAPSHOT_ATTEMPTS = 24;
const SNAPSHOT_POLL_MS = 350;

const LOG_ENABLED = true;

const DEFAULT_SETTINGS = {
  language: "en",
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
    readyDetailedStatus: "Attendance: ready ({matched}/{total} matched)",
    updatedStatus: "Attendance: updated ({matched}/{total} matched)",
    restoredStatus: "Attendance: restored cached result ({matched}/{total} matched)",
    errorStatus: "Attendance: error"
  },
  is: {
    panelTitle: "Mætingarsamstilling",
    refreshButton: "Uppfæra mætingu",
    refreshingButton: "Uppfæri...",
    waitingStatus: "Bíð eftir samstillingu",
    waitingTimetableStatus: "Mæting: bíð eftir stundatöflu",
    noRowsStatus: "Mæting: engir tímar fundust",
    loadingStatus: "Mæting: sæki gögn...",
    manualRefreshStatus: "Mæting: handvirk uppfærsla...",
    retryingStatus: "Mæting: reyni aftur ({current}/{max})",
    notReadyStatus: "Mæting: gögn ekki tilbúin, notaðu „Uppfæra mætingu“",
    parseFailedStatus: "Mæting: tókst ekki að lesa gögn, notaðu „Uppfæra mætingu“",
    readyDetailedStatus: "Mæting: tilbúin ({matched}/{total} pöruð)",
    updatedStatus: "Mæting: uppfært ({matched}/{total} pöruð)",
    restoredStatus: "Mæting: endurheimti skyndiminni ({matched}/{total} pöruð)",
    errorStatus: "Mæting: villa"
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
  ensureRefreshPanel();
  refreshObserverRoot();
  bindStorageListener();

  scheduleRun("init", false, 800);

  window.addEventListener("hashchange", () => {
    ensureRefreshPanel();
    refreshObserverRoot();

    if (!isOnDashboard()) return;

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

    if (!changed) return;

    settings = sanitizeSettings(next);
    applySettingsToCss();
    updatePanelTexts();

    if (cachedAttendance) {
      applyCachedStateToCurrentLayout("settings-change");
    }
  });
}

function isOnDashboard() {
  return DASHBOARD_HASHES.has(location.hash || "#/");
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

    const dashboardRows = getDashboardLessonRows();
    if (!dashboardRows.length) {
      setStatus("noRowsStatus");
      return;
    }

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

    if (!snapshot.ready || !snapshot.text.length) {
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

    const parsed = buildAttendanceDataFromText(snapshot.text, todayInfo, dashboardRows);

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
    presentColor: normalizeHexColor(raw?.presentColor, DEFAULT_SETTINGS.presentColor),
    absentColor: normalizeHexColor(raw?.absentColor, DEFAULT_SETTINGS.absentColor)
  };
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
    .inna-att-green {
      background: ${hexToRgba(present, 0.18)} !important;
      border-left: 4px solid ${present} !important;
      box-shadow: inset 0 0 0 9999px ${hexToRgba(present, 0.06)};
    }

    .inna-att-red {
      background: ${hexToRgba(absent, 0.18)} !important;
      border-left: 4px solid ${absent} !important;
      box-shadow: inset 0 0 0 9999px ${hexToRgba(absent, 0.06)};
    }
  `;
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
      if (node.classList.contains("inna-att-indicator")) return true;
      if (node.closest?.("#inna-att-panel")) return true;
      return false;
    });
  });
}

function applyCachedStateToCurrentLayout() {
  if (!cachedAttendance || !isOnDashboard()) return;

  ensureRefreshPanel();

  const todayInfo = getDashboardDayInfo();
  if (!todayInfo) return;
  if (makeDayKey(todayInfo) !== cachedAttendance.dayKey) return;

  const rows = getDashboardLessonRows();
  if (!rows.length) return;

  colorDashboardRows(todayInfo, rows, cachedAttendance.map);
  setStatus("readyDetailedStatus", {
    matched: cachedAttendance.map.size,
    total: rows.length
  });
}

function ensureRefreshPanel() {
  if (!isOnDashboard()) return;

  const timetableTable = findTimetableTable();
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
  const nodes = [...document.querySelectorAll("body *")];
  for (const el of nodes) {
    const text = normalizeText(el.textContent || "");
    if (text === "Timetable" || text.startsWith("Timetable ")) {
      return el;
    }
  }
  return null;
}

function findTimetableModuleRoot() {
  const header = findTimetableHeader();
  if (!header) return null;

  let cur = header;
  for (let i = 0; i < 8 && cur; i++) {
    const text = normalizeText(cur.innerText || "");
    if (text.includes("Timetable") && (cur.querySelector("table") || cur.closest("table"))) {
      return cur;
    }
    cur = cur.parentElement;
  }

  return header.parentElement || null;
}

function findTimetableTable() {
  const root = findTimetableModuleRoot();
  if (root) {
    const table = root.querySelector("table");
    if (table) return table;
  }

  const tables = [...document.querySelectorAll("table")];
  for (const table of tables) {
    const text = normalizeText(table.innerText || "");
    if (/\b\d{1,2}:\d{2}\b/.test(text) && /\([0-9]+\)/.test(text)) {
      return table;
    }
  }

  return null;
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
  const dayKey = makeDayKey(todayInfo);

  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    const text = getIframeNormalizedText(iframe);

    if (isAttendanceTextReady(text)) {
      return { ready: true, text, source: "live" };
    }

    if (attempt === 8 || attempt === 16) {
      try {
        await navigateIframe(iframe, buildAttendanceUrl(true));
      } catch {}
    }

    await sleep(SNAPSHOT_POLL_MS);
  }

  if (!forceManual && cachedAttendance && cachedAttendance.dayKey === dayKey) {
    return {
      ready: true,
      text: cachedAttendance.fullText,
      source: "cache-fallback"
    };
  }

  return {
    ready: false,
    text: getIframeNormalizedText(iframe),
    source: "empty"
  };
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
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+[A-ZÁÉÍÓÚÝÞÆÖ0-9]+-\d+/u.test(normalized);

  const hasAnyTimeRange =
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.test(normalized);

  return hasLessonRows || hasAnyTimeRange;
}

function getDashboardDayInfo() {
  const text = normalizeText(document.body.innerText);
  const m = text.match(/\b(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY)\s+(\d{2})\.(\d{2})\b/i);
  if (!m) return null;

  return {
    dayName: capitalize(m[1].toLowerCase()),
    dayNum: m[2],
    monthNum: m[3]
  };
}

function getDashboardLessonRows() {
  const anchors = [...document.querySelectorAll('a[href*="#/NewModules/"]')];

  return anchors
    .map(a => {
      const row = a.closest("tr") || a.closest("[role='row']") || findUsefulContainer(a);
      if (!row) return null;

      const rowText = normalizeText(row.innerText || "");
      const timeMatch = rowText.match(/(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/);
      const codeMatch = normalizeText(a.innerText).match(
        /([A-ZÁÉÍÓÚÝÞÆÖ0-9]+)\s*\(\s*(\d+)\s*\)/u
      );

      if (!timeMatch || !codeMatch) return null;

      const timeCell = findLikelyTimeCell(row);

      return {
        element: row,
        timeCell,
        start: normalizeTime(timeMatch[1]),
        end: normalizeTime(timeMatch[2]),
        code: normalizeCode(codeMatch[1]),
        group: codeMatch[2]
      };
    })
    .filter(Boolean);
}

function findLikelyTimeCell(row) {
  const cells = row.querySelectorAll("td, [role='cell']");
  if (cells?.[0]) return cells[0];
  return row.firstElementChild || row;
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
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+([A-ZÁÉÍÓÚÝÞÆÖ0-9]+)-(\d+)(?:\s+([A-ZÓ]))?(?=\s+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}|\s+Print\b|$)/gu;

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
