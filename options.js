const DEFAULT_SETTINGS = {
  language: "en",
  presentColor: "#22c55e",
  absentColor: "#ef4444"
};

const TEXT = {
  en: {
    pageTitle: "Attendance settings",
    pageSubtitle: "Choose interface language and attendance colors.",
    languageLabel: "Language",
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
    pageTitle: "Stillingar fyrir mætingu",
    pageSubtitle: "Veldu tungumál viðmóts og liti fyrir mætingu.",
    languageLabel: "Tungumál",
    presentColorLabel: "Litur fyrir jákvæða mætingu",
    absentColorLabel: "Litur fyrir neikvæða mætingu",
    previewPresent: "Forskoðun jákvæðrar mætingar",
    previewAbsent: "Forskoðun neikvæðrar mætingar",
    save: "Vista",
    reset: "Endurstilla sjálfgefið",
    saved: "Stillingar vistaðar.",
    resetDone: "Sjálfgefnar stillingar endurheimtar."
  }
};

const languageEl = document.getElementById("language");
const presentColorEl = document.getElementById("presentColor");
const absentColorEl = document.getElementById("absentColor");
const statusEl = document.getElementById("status");

const pageTitleEl = document.getElementById("pageTitle");
const pageSubtitleEl = document.getElementById("pageSubtitle");
const languageLabelEl = document.getElementById("languageLabel");
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
  presentColorEl.value = settings.presentColor;
  absentColorEl.value = settings.absentColor;
  renderPreview();
}

function renderText(language) {
  const lang = language === "is" ? "is" : "en";
  const t = TEXT[lang];

  document.documentElement.lang = lang;
  pageTitleEl.textContent = t.pageTitle;
  pageSubtitleEl.textContent = t.pageSubtitle;
  languageLabelEl.textContent = t.languageLabel;
  presentColorLabelEl.textContent = t.presentColorLabel;
  absentColorLabelEl.textContent = t.absentColorLabel;
  previewPresentEl.textContent = t.previewPresent;
  previewAbsentEl.textContent = t.previewAbsent;
  saveBtn.textContent = t.save;
  resetBtn.textContent = t.reset;
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
    presentColor: normalizeHexColor(raw?.presentColor, DEFAULT_SETTINGS.presentColor),
    absentColor: normalizeHexColor(raw?.absentColor, DEFAULT_SETTINGS.absentColor)
  };
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
