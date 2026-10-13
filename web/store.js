/**
 * Everything the app remembers on this device: settings, swipes and meal logs.
 * Saved in localStorage under one key. Every read/write is wrapped in try/catch,
 * so the app still works (without saving) if storage is empty, blocked or full.
 */
import { DEFAULT_CONFIG } from "./optimizer.js";

export const HALLS = [
  { id: "leonard", name: "Leonard" },
  { id: "ban_righ", name: "Ban Righ" },
  { id: "jean_royce", name: "Jean-Royce" },
];
export const MEALS = ["Breakfast", "Lunch", "Dinner"];
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABELS = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
                            fri: "Friday", sat: "Saturday", sun: "Sunday" };
const JS_WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };   // Date.getDay() numbering

const weekday = (day) => !["sat", "sun"].includes(day);

export const DEFAULT_SETTINGS = {
  dailyTargets: { calories: 3600, protein_g: 190, carbs_g: 485, fat_g: 100 },
  hallSharePct: 75,
  tolerancePct: { calories: 10, carbs_g: 10, fat_g: 10 },
  maxServings: 3,
  maxServingsByName: { "Fried Eggs": 5 },
  perServing: 2,
  halls: { leonard: true, ban_righ: true, jean_royce: false },
  availability: Object.fromEntries(DAYS.map((d) => [d, { Breakfast: false, Lunch: weekday(d), Dinner: weekday(d) }])),
  swipesPerWeek: 5,
  resetDay: "sun",          // the plan resets at 11:59 pm on this day
};

const STORAGE_KEY = "queens-macros:v1";
let storageWorks = true;
export const storageAvailable = () => storageWorks;

// ---------------------------------------------------------------------------
// Validation: anything missing or malformed falls back to the default
// ---------------------------------------------------------------------------

const mapObject = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(k, v)]));

function number(value, fallback, min, max) {
  const n = typeof value === "string" && value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

export function cleanSettings(s = {}, base = DEFAULT_SETTINGS) {
  const d = base;          // fallback for anything missing or invalid
  const overrides = {};
  const rawOverrides = s.maxServingsByName && typeof s.maxServingsByName === "object"
    ? s.maxServingsByName : d.maxServingsByName;
  for (const [name, cap] of Object.entries(rawOverrides)) {
    if (name.trim()) overrides[name.trim()] = Math.round(number(cap, d.maxServings, 0, 20));
  }
  return {
    dailyTargets: mapObject(d.dailyTargets, (k, v) => number(s.dailyTargets?.[k], v, 1, 20000)),
    hallSharePct: number(s.hallSharePct, d.hallSharePct, 1, 100),
    tolerancePct: mapObject(d.tolerancePct, (k, v) => number(s.tolerancePct?.[k], v, 0, 100)),
    maxServings: Math.round(number(s.maxServings, d.maxServings, 1, 20)),
    maxServingsByName: overrides,
    perServing: number(s.perServing, d.perServing, 0, 100),
    halls: mapObject(d.halls, (k, v) => bool(s.halls?.[k], v)),
    availability: mapObject(d.availability, (day, meals) =>
      mapObject(meals, (meal, v) => bool(s.availability?.[day]?.[meal], v))),
    swipesPerWeek: Math.round(number(s.swipesPerWeek, d.swipesPerWeek, 0, 50)),
    resetDay: DAYS.includes(s.resetDay) ? s.resetDay : d.resetDay,
  };
}

function cleanSwipes(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && typeof s.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .map((s) => ({ id: s.id, date: s.date, at: String(s.at || ""), menuKey: s.menuKey || null,
                   label: String(s.label || "Swipe") }));
}

function cleanMeals(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const [key, m] of Object.entries(obj)) {
    if (!m || typeof m !== "object") continue;
    out[key] = {
      unavailable: Array.isArray(m.unavailable) ? m.unavailable.filter((id) => typeof id === "string") : [],
      eaten: m.eaten && typeof m.eaten === "object" ? mapObject(m.eaten, (k, v) => Math.max(0, Math.round(number(v, 0, 0, 50)))) : null,
      swipeId: typeof m.swipeId === "string" ? m.swipeId : null,
      snapshot: m.snapshot && typeof m.snapshot === "object" ? m.snapshot : null,
    };
  }
  return out;
}

function cleanState(raw = {}) {
  return { settings: cleanSettings(raw.settings), swipes: cleanSwipes(raw.swipes), meals: cleanMeals(raw.meals) };
}

// ---------------------------------------------------------------------------
// Load / save / export / import
// ---------------------------------------------------------------------------

export function loadState() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return cleanState(text ? JSON.parse(text) : {});
  } catch {
    storageWorks = false;       // blocked storage or corrupted JSON: start fresh
    return cleanState({});
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWorks = true;
  } catch {
    storageWorks = false;
  }
  return storageWorks;
}

export function exportText(state) {
  return JSON.stringify({ app: "queens-macros", version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

/** Parse a backup file; throws an Error with a readable message if it isn't one. */
export function importText(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
  if (!data || data.app !== "queens-macros") throw new Error("That file isn't a Queen's Macros backup.");
  return cleanState(data);
}

/** Turn the saved settings into the optimizer's config object. */
export function optimizerConfig(settings) {
  return {
    ...DEFAULT_CONFIG,
    dailyTargets: { ...settings.dailyTargets },
    hallShare: settings.hallSharePct / 100,
    tolerance: mapObject(settings.tolerancePct, (k, v) => v / 100),
    maxServings: settings.maxServings,
    maxServingsByName: { ...settings.maxServingsByName },
    excludedNames: [],
    weights: { ...DEFAULT_CONFIG.weights, perServing: settings.perServing },
  };
}

// ---------------------------------------------------------------------------
// Dates and swipe weeks (all in the phone's local time)
// ---------------------------------------------------------------------------

export function isoDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function parseIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export const dayKey = (iso) => DAYS[(parseIso(iso).getDay() + 6) % 7];   // "mon".."sun"

/** First day (YYYY-MM-DD) of the swipe week containing `iso`: the day after the reset day. */
export function swipeWeekStart(iso, resetDay) {
  const startWeekday = (JS_WEEKDAY[resetDay] + 1) % 7;
  const back = (parseIso(iso).getDay() - startWeekday + 7) % 7;
  return addDays(iso, -back);
}

export function swipesInWeek(swipes, weekStartIso) {
  const end = addDays(weekStartIso, 7);
  return swipes.filter((s) => s.date >= weekStartIso && s.date < end);
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
