const THEME_DEFAULT = "default";
const THEME_NEW = "new";
const LUNCH_ROW_REDUCTION_MIN = 0;
const LUNCH_ROW_REDUCTION_MAX = 30;
const LUNCH_ROW_REDUCTION_DEFAULT = 0;

const DEFAULT_SETTINGS = {
  language: "en",
  theme: THEME_DEFAULT,
  lunchRowReductionPercent: LUNCH_ROW_REDUCTION_DEFAULT,
  presentColor: "#22c55e",
  absentColor: "#ef4444"
};

const TEXT = {
  en: {
    pageTitle: "Attendance settings",
    pageSubtitle: "Choose interface language, theme, and attendance colors.",
    languageLabel: "Language",
    themeLabel: "Theme",
    themeDefaultOption: "Default",
    themeNewOption: "New color scheme",
    lunchRowReductionLabel: "Lunch row size reduction",
    lunchRowReductionValue: "{value}% smaller",
    presentColorLabel: "Positive attendance color",
    absentColorLabel: "Negative attendance color",
    previewPresent: "Positive attendance preview",
    previewAbsent: "Negative attendance preview",
    save: "Save",
    reset: "Reset to defaults",
    saved: "Settings saved.",
    resetDone: "Defaults restored."
  },
  is: {
    pageTitle: "Stillingar fyrir m\u00E6tingu",
    pageSubtitle: "Veldu tungum\u00E1l vi\u00F0m\u00F3ts, \u00FEema og liti fyrir m\u00E6tingu.",
    languageLabel: "Tungum\u00E1l",
    themeLabel: "\u00DEema",
    themeDefaultOption: "Sj\u00E1lfgefi\u00F0",
    themeNewOption: "N\u00FDtt lita\u00FEema",
    lunchRowReductionLabel: "Minnkun \u00E1 st\u00E6r\u00F0 h\u00E1degishl\u00E9s",
    lunchRowReductionValue: "{value}% minni",
    presentColorLabel: "Litur fyrir j\u00E1kv\u00E6\u00F0a m\u00E6tingu",
    absentColorLabel: "Litur fyrir neikv\u00E6\u00F0a m\u00E6tingu",
    previewPresent: "Forsko\u00F0un j\u00E1kv\u00E6\u00F0rar m\u00E6tingar",
    previewAbsent: "Forsko\u00F0un neikv\u00E6\u00F0rar m\u00E6tingar",
    save: "Vista",
    reset: "Endurstilla sj\u00E1lfgefi\u00F0",
    saved: "Stillingar vista\u00F0ar.",
    resetDone: "Sj\u00E1lfgefnar stillingar endurheimtar."
  }
};

const languageEl = document.getElementById("language");
const themeEl = document.getElementById("theme");
const lunchRowReductionEl = document.getElementById("lunchRowReductionPercent");
const lunchRowReductionValueEl = document.getElementById("lunchRowReductionValue");
const presentColorEl = document.getElementById("presentColor");
const absentColorEl = document.getElementById("absentColor");
const statusEl = document.getElementById("status");

const pageTitleEl = document.getElementById("pageTitle");
const pageSubtitleEl = document.getElementById("pageSubtitle");
const languageLabelEl = document.getElementById("languageLabel");
const themeLabelEl = document.getElementById("themeLabel");
const themeDefaultOptionEl = document.getElementById("themeDefaultOption");
const themeNewOptionEl = document.getElementById("themeNewOption");
const lunchRowReductionLabelEl = document.getElementById("lunchRowReductionLabel");
const presentColorLabelEl = document.getElementById("presentColorLabel");
const absentColorLabelEl = document.getElementById("absentColorLabel");
const previewPresentEl = document.getElementById("previewPresent");
const previewAbsentEl = document.getElementById("previewAbsent");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");

document.addEventListener("DOMContentLoaded", async () => {
  const settings = sanitizeSettings(await storageGet(DEFAULT_SETTINGS));
  fillForm(settings);
  renderText(settings.language);
  renderPreview();
});

languageEl.addEventListener("change", () => {
  renderText(languageEl.value);
  clearStatus();
});

themeEl.addEventListener("change", () => {
  clearStatus();
});

lunchRowReductionEl.addEventListener("input", () => {
  renderLunchRowReductionValue(languageEl.value);
  clearStatus();
});

presentColorEl.addEventListener("input", () => {
  renderPreview();
  clearStatus();
});

absentColorEl.addEventListener("input", () => {
  renderPreview();
  clearStatus();
});

saveBtn.addEventListener("click", async () => {
  const settings = sanitizeSettings({
    language: languageEl.value,
    theme: themeEl.value,
    lunchRowReductionPercent: lunchRowReductionEl.value,
    presentColor: presentColorEl.value,
    absentColor: absentColorEl.value
  });

  await storageSet(settings);
  renderText(settings.language);
  statusEl.textContent = TEXT[settings.language].saved;
});

resetBtn.addEventListener("click", async () => {
  fillForm(DEFAULT_SETTINGS);
  renderText(DEFAULT_SETTINGS.language);
  renderPreview();
  await storageSet(DEFAULT_SETTINGS);
  statusEl.textContent = TEXT[DEFAULT_SETTINGS.language].resetDone;
});

function fillForm(settings) {
  languageEl.value = settings.language;
  themeEl.value = settings.theme;
  lunchRowReductionEl.value = String(settings.lunchRowReductionPercent);
  presentColorEl.value = settings.presentColor;
  absentColorEl.value = settings.absentColor;
  renderLunchRowReductionValue(settings.language);
  renderPreview();
}

function renderText(language) {
  const lang = language === "is" ? "is" : "en";
  const t = TEXT[lang];

  document.documentElement.lang = lang;
  pageTitleEl.textContent = t.pageTitle;
  pageSubtitleEl.textContent = t.pageSubtitle;
  languageLabelEl.textContent = t.languageLabel;
  themeLabelEl.textContent = t.themeLabel;
  themeDefaultOptionEl.textContent = t.themeDefaultOption;
  themeNewOptionEl.textContent = t.themeNewOption;
  lunchRowReductionLabelEl.textContent = t.lunchRowReductionLabel;
  presentColorLabelEl.textContent = t.presentColorLabel;
  absentColorLabelEl.textContent = t.absentColorLabel;
  previewPresentEl.textContent = t.previewPresent;
  previewAbsentEl.textContent = t.previewAbsent;
  saveBtn.textContent = t.save;
  resetBtn.textContent = t.reset;
  renderLunchRowReductionValue(lang);
}

function renderLunchRowReductionValue(language) {
  const lang = language === "is" ? "is" : "en";
  const t = TEXT[lang];
  const value = normalizeLunchRowReductionPercent(lunchRowReductionEl.value);
  lunchRowReductionValueEl.textContent = t.lunchRowReductionValue.replace("{value}", String(value));
}

function renderPreview() {
  const present = normalizeHexColor(presentColorEl.value, DEFAULT_SETTINGS.presentColor);
  const absent = normalizeHexColor(absentColorEl.value, DEFAULT_SETTINGS.absentColor);

  previewPresentEl.style.background = hexToRgba(present, 0.18);
  previewPresentEl.style.borderLeftColor = present;
  previewPresentEl.style.boxShadow = `inset 0 0 0 9999px ${hexToRgba(present, 0.06)}`;

  previewAbsentEl.style.background = hexToRgba(absent, 0.18);
  previewAbsentEl.style.borderLeftColor = absent;
  previewAbsentEl.style.boxShadow = `inset 0 0 0 9999px ${hexToRgba(absent, 0.06)}`;
}

function clearStatus() {
  statusEl.textContent = "";
}

function storageGet(defaults) {
  return new Promise(resolve => {
    chrome.storage.sync.get(defaults, items => resolve(items));
  });
}

function storageSet(values) {
  return new Promise(resolve => {
    chrome.storage.sync.set(values, () => resolve());
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
