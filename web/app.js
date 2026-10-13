/**
 * Hall Macros: the single-page app. Screens are chosen by the URL hash:
 *   #/week (home)   #/plate/<menu key>   #/swipes   #/settings
 * Each screen is a function that writes HTML into <main>; clicks are handled by one
 * listener that reads data-action attributes. Menu data comes from data/menus.json
 * (written by clean_menus.py); everything personal lives in store.js.
 */
import { mealTargets, exclusionReason } from "./optimizer.js";
import {
  HALLS, MEALS, DAYS, DAY_LABELS, cleanSettings, loadState, saveState, storageAvailable,
  exportText, importText, optimizerConfig, isoDate, parseIso, addDays, dayKey,
  swipeWeekStart, swipesInWeek, newId,
} from "./store.js";
import { solveAsync } from "./solver-client.js";

const MACROS = ["calories", "protein_g", "carbs_g", "fat_g"];
const MACRO_NAMES = { calories: "Calories", protein_g: "Protein", carbs_g: "Carbs", fat_g: "Fat" };
const MACRO_SHORT = { calories: "kcal", protein_g: "P", carbs_g: "C", fat_g: "F" };
const MACRO_UNIT = { calories: "kcal", protein_g: "g", carbs_g: "g", fat_g: "g" };
const NUTRITION_ROWS = [
  ["calories", "Calories"], ["protein_g", "Protein"], ["carbs_g", "Carbohydrates"],
  ["fiber_g", "Fibre", true], ["sugars_g", "Sugars", true], ["added_sugars_g", "Added sugars", true],
  ["fat_g", "Fat"], ["sat_fat_g", "Saturated", true], ["trans_fat_g", "Trans", true],
  ["cholesterol_mg", "Cholesterol"], ["sodium_mg", "Sodium"],
];

const app = {
  data: null,
  loadError: null,
  menus: new Map(),          // menu key -> menu (from menus.json)
  itemsByMenu: new Map(),    // menu key -> items in station order
  itemById: new Map(),
  state: loadState(),        // { settings, swipes, meals }
  config: null,
  configKey: "",
  targets: null,
  plans: new Map(),          // plan cache for the current config
  showFullMenu: false,
};

const main = document.getElementById("main");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const menuKey = (x) => `${x.date}|${x.hall}|${x.meal}`;
const plateHref = (key) => `#/plate/${encodeURIComponent(key)}`;
const hallName = (id) => HALLS.find((h) => h.id === id)?.name ?? id;
const round = (x) => Math.round(x);
const todayIso = () => isoDate(new Date());

function dateLabel(iso, { long = false } = {}) {
  const d = parseIso(iso);
  const text = d.toLocaleDateString("en-CA", { weekday: long ? "long" : "short", month: "short", day: "numeric" });
  return iso === todayIso() ? `Today · ${text}` : iso === addDays(todayIso(), 1) ? `Tomorrow · ${text}` : text;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

function persist() {
  saveState(app.state);
  document.getElementById("storage-banner").hidden = storageAvailable();
}

/** ok / low / high for one macro total against the meal targets and tolerances. */
function macroStatus(k, total) {
  const target = app.targets[k];
  if (k === "protein_g") return total >= target - 0.05 ? "ok" : "low";
  const tol = app.config.tolerance[k];
  if (total < target * (1 - tol) - 0.05) return "low";
  if (total > target * (1 + tol) + 0.05) return "high";
  return "ok";
}

function missLines(totals) {
  const lines = [];
  for (const k of MACROS) {
    const status = macroStatus(k, totals[k]);
    if (status === "ok") continue;
    const target = app.targets[k];
    if (k === "protein_g") lines.push(`Protein ${round(target - totals[k])} g short of the ${target} g minimum`);
    else {
      const pct = Math.abs(round(((totals[k] - target) / target) * 100));
      lines.push(`${MACRO_NAMES[k]} ${pct}% ${status === "low" ? "under" : "over"} target (allowed ±${round(app.config.tolerance[k] * 100)}%)`);
    }
  }
  return lines;
}

function chips(totals) {
  return `<div class="chips">${MACROS.map((k) => {
    const status = macroStatus(k, totals[k]);
    const icon = status === "ok" ? "✓" : status === "low" ? "↓" : "↑";
    return `<span class="chip ${status}">${round(totals[k])} ${MACRO_SHORT[k]} ${icon}</span>`;
  }).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Data, config and plans
// ---------------------------------------------------------------------------

async function loadData() {
  try {
    const response = await fetch("data/menus.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    app.data = await response.json();
  } catch (error) {
    app.loadError = String(error);
    return;
  }
  for (const menu of app.data.menus) app.menus.set(menuKey(menu), menu);
  for (const item of app.data.items) {
    const key = menuKey(item);
    if (!app.itemsByMenu.has(key)) app.itemsByMenu.set(key, []);
    app.itemsByMenu.get(key).push(item);
    app.itemById.set(item.id, item);
  }
  // Stations in the hall's own order (sort is stable, so item order within a station is kept)
  for (const list of app.itemsByMenu.values()) list.sort((a, b) => a.station_sort - b.station_sort);

  const generated = new Date(app.data.generated_at);
  const ageEl = document.getElementById("data-age");
  ageEl.textContent = `Menus updated ${generated.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  ageEl.classList.toggle("stale", Date.now() - generated > 2 * 24 * 3600 * 1000);
}

function refreshConfig() {
  app.config = optimizerConfig(app.state.settings);
  app.targets = mealTargets(app.config);
  const key = JSON.stringify(app.config);
  if (key !== app.configKey) {     // settings changed: old plans no longer apply
    app.configKey = key;
    app.plans = new Map();
  }
}

const EMPTY_MEAL = { unavailable: [], eaten: null, swipeId: null, snapshot: null };
const mealState = (key) => app.state.meals[key] ?? EMPTY_MEAL;
function setMealState(key, meal) {
  app.state.meals[key] = meal;
  persist();
}

/**
 * The optimized plate for a menu: { state: "pending" | "done" | "error", result }.
 * Results are cached per (menu, unavailable items) for the current settings.
 */
function planFor(key) {
  const menu = app.menus.get(key);
  if (!menu || menu.status !== "open") return { state: "none" };
  const unavailable = [...mealState(key).unavailable].sort();
  const cacheKey = `${key}|${unavailable.join(",")}`;
  const plans = app.plans;
  if (plans.has(cacheKey)) return plans.get(cacheKey);

  const entry = { state: "pending" };
  plans.set(cacheKey, entry);
  const items = (app.itemsByMenu.get(key) ?? []).filter((item) => !unavailable.includes(item.id));
  solveAsync(items, menu, app.config)
    .then((result) => { entry.state = "done"; entry.result = result; })
    .catch((error) => { entry.state = "error"; entry.error = String(error); console.error(error); })
    .finally(() => { if (plans === app.plans) scheduleRender({ fromSolver: true }); });
  return entry;
}

const planServings = (result) => Object.fromEntries(result.plate.map((p) => [p.id, p.servings]));

function totalsOf(servings) {
  const totals = Object.fromEntries(MACROS.map((k) => [k, 0]));
  for (const [id, n] of Object.entries(servings)) {
    const item = app.itemById.get(id);
    if (!item) continue;
    for (const k of MACROS) totals[k] += n * (item.nutrients[k].value ?? 0);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Rendering and routing
// ---------------------------------------------------------------------------

function currentRoute() {
  const match = (location.hash || "#/week").match(/^#\/([a-z]+)\/?(.*)$/);
  return { name: match?.[1] || "week", arg: match?.[2] ? decodeURIComponent(match[2]) : null };
}

let renderQueued = false;
let queuedFromSolver = true;
function scheduleRender({ fromSolver = false } = {}) {
  queuedFromSolver = queuedFromSolver && fromSolver;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const onlySolver = queuedFromSolver;
    queuedFromSolver = true;
    render({ fromSolver: onlySolver });
  });
}

function render({ fromSolver = false } = {}) {
  const route = currentRoute();
  const tab = route.name === "plate" ? "week" : route.name;
  for (const a of document.querySelectorAll(".tabbar a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (app.loadError) {
    main.innerHTML = `<p class="empty">Couldn't load the menus (${esc(app.loadError)}).<br>
      If you're testing locally, run <code>serve.py</code> and open the page through it.</p>`;
    return;
  }
  if (!app.data) return;
  if (route.name === "settings") {
    // Don't rebuild the form while you're typing in it; just update the status line.
    if (fromSolver) updateSettingsStatus();
    else renderSettings();
  } else if (route.name === "swipes") renderSwipes();
  else if (route.name === "plate" && route.arg) renderPlate(route.arg);
  else renderWeek();
}

// ---------------------------------------------------------------------------
// Screen 1: This week
// ---------------------------------------------------------------------------

function weekDays() {
  const today = todayIso();
  return Array.from({ length: 7 }, (_, i) => addDays(today, i));
}

/** Every (meal, hall) slot for a day, with why it can or can't be planned. */
function slotsForDay(iso) {
  const settings = app.state.settings;
  const slots = [];
  for (const meal of MEALS) {
    for (const hall of HALLS) {
      if (!settings.halls[hall.id]) continue;
      const key = `${iso}|${hall.id}|${meal}`;
      const menu = app.menus.get(key);
      const status = menu ? menu.status : "no_menu";
      const available = settings.availability[dayKey(iso)][meal];
      slots.push({ key, iso, meal, hall, menu, status, available, plannable: status === "open" && available });
    }
  }
  return slots;
}

/**
 * Recommended picks: within each swipe week, the best-scoring days for the swipes
 * you have left (one meal per day, skipping days you've already logged a meal).
 */
function recommendations(days) {
  const settings = app.state.settings;
  const byWeek = new Map();
  for (const iso of days) {
    const start = swipeWeekStart(iso, settings.resetDay);
    if (!byWeek.has(start)) byWeek.set(start, []);
    byWeek.get(start).push(iso);
  }
  const picks = new Set();
  const weeks = [];
  for (const [start, isos] of byWeek) {
    const used = swipesInWeek(app.state.swipes, start).length;
    const left = Math.max(0, settings.swipesPerWeek - used);
    let pending = false;
    const candidates = [];
    for (const iso of isos) {
      const slots = slotsForDay(iso);
      if (slots.some((s) => mealState(s.key).swipeId)) continue;
      let best = null;
      for (const slot of slots.filter((s) => s.plannable)) {
        const plan = planFor(slot.key);
        if (plan.state === "pending") pending = true;
        if (plan.state === "done" && (!best || plan.result.fit.score < best.score)) {
          best = { key: slot.key, score: plan.result.fit.score };
        }
      }
      if (best) candidates.push(best);
    }
    candidates.sort((a, b) => a.score - b.score).slice(0, left).forEach((c) => picks.add(c.key));
    weeks.push({ start, used, left, pending });
  }
  return { picks, weeks };
}

function renderWeek() {
  const days = weekDays();
  const settings = app.state.settings;
  const { picks, weeks } = recommendations(days);
  const current = weeks[0];
  const pending = weeks.some((w) => w.pending);

  let html = `<p class="summary">${current.left} of ${settings.swipesPerWeek} swipes left this week
    (resets ${DAY_LABELS[settings.resetDay]} 11:59 pm).
    ${pending ? "Finding the best picks…" : picks.size ? "★ marks the meals worth a swipe." : ""}</p>`;

  for (const iso of days) {
    const slots = slotsForDay(iso);
    const plannable = slots.filter((s) => s.plannable);
    const logged = slots.find((s) => mealState(s.key).swipeId);
    const newWeek = iso !== days[0] && swipeWeekStart(iso, settings.resetDay) === iso;
    html += `<section class="card ${plannable.length || logged ? "" : "muted"}">
      <div class="card-head"><h2 style="margin:0">${esc(dateLabel(iso))}</h2>
        <span>${newWeek ? '<span class="badge">New swipe week</span> ' : ""}${logged ? '<span class="badge ok">Eaten ✓</span>' : ""}</span></div>
      ${slots.length ? daySlotsHtml(slots, picks) : '<p class="row-note">No halls turned on (see Settings).</p>'}
    </section>`;
  }
  main.innerHTML = html;
}

/**
 * One day's rows. Greyed-out slots are merged so they don't drown the real options:
 * a hall with no menu all day -> one row; meals you're unavailable for -> one row each
 * (or a single row when you're unavailable all day), with links to view the menus anyway.
 */
function daySlotsHtml(slots, picks) {
  let html = "";
  const deadHalls = HALLS.filter((h) => {
    const own = slots.filter((s) => s.hall.id === h.id);
    return own.length && own.every((s) => s.status !== "open" && !mealState(s.key).swipeId);
  });
  const live = slots.filter((s) => !deadHalls.includes(s.hall));
  const unavailableMeals = MEALS.filter((m) => {
    const own = live.filter((s) => s.meal === m);
    return own.length && own.every((s) => !s.available && !mealState(s.key).swipeId);
  });
  const viewLinks = (meal) => live.filter((s) => s.meal === meal && s.status === "open")
    .map((s) => `<a href="${plateHref(s.key)}">${esc(s.hall.name)}</a>`).join(" · ");

  if (unavailableMeals.length === MEALS.length) {
    const links = MEALS.map((m) => live.filter((s) => s.meal === m && s.status === "open")
      .map((s) => `<a href="${plateHref(s.key)}">${m}${live.some((o) => o.meal === m && o !== s) ? ` (${esc(s.hall.name)})` : ""}</a>`).join(" · "))
      .filter(Boolean).join(" · ");
    html += `<div class="menu-row greyed"><span class="row-title">You're unavailable all day</span>
      ${links ? `<div class="row-note">View anyway: ${links}</div>` : ""}</div>`;
  }
  for (const meal of MEALS) {
    if (unavailableMeals.includes(meal)) {
      if (unavailableMeals.length < MEALS.length) {
        const links = viewLinks(meal);
        html += `<div class="menu-row greyed"><span class="row-title">${meal}</span>
          <span class="row-note">· You're unavailable${links ? ` · view: ${links}` : ""}</span></div>`;
      }
      continue;
    }
    for (const slot of live.filter((s) => s.meal === meal)) html += slotHtml(slot, picks);
  }
  for (const hall of deadHalls) {
    const statuses = new Set(slots.filter((s) => s.hall === hall).map((s) => s.status));
    const why = statuses.size === 1 && statuses.has("closed") ? "Closed" : "No menu posted";
    html += `<div class="menu-row greyed"><span class="row-title">${esc(hall.name)}</span>
      <span class="row-note">· ${why}</span></div>`;
  }
  return html;
}

function slotHtml(slot, picks) {
  const title = `<span class="row-title">${esc(slot.meal)}</span> <span class="row-note">${esc(slot.hall.name)}</span>`;
  const meal = mealState(slot.key);
  if (slot.status !== "open") {
    const why = slot.status === "closed" ? "Closed" : slot.status === "error" ? "Menu unavailable" : "No menu posted";
    return `<div class="menu-row greyed"><div class="row-head">${title} <span class="row-note">· ${why}</span></div></div>`;
  }
  if (meal.swipeId && meal.snapshot) {
    return `<a class="menu-row" href="${plateHref(slot.key)}"><div class="row-head">${title}
      <span class="badge ok">Logged</span></div>${chips(meal.snapshot.totals)}</a>`;
  }
  if (!slot.available) {
    return `<a class="menu-row greyed" href="${plateHref(slot.key)}"><div class="row-head">${title}
      <span class="row-note">· You're unavailable (tap to view anyway)</span></div></a>`;
  }
  const plan = planFor(slot.key);
  if (plan.state !== "done") {
    const text = plan.state === "error" ? "Couldn't plan this menu" : "Planning…";
    return `<a class="menu-row" href="${plateHref(slot.key)}"><div class="row-head">${title}</div>
      <div class="row-note">${text}</div></a>`;
  }
  const r = plan.result;
  const recommended = picks.has(slot.key);
  const preview = r.plate.map((p) => `${p.servings}× ${esc(p.name)}`).join(", ");
  return `<a class="menu-row ${recommended ? "recommended" : ""}" href="${plateHref(slot.key)}">
    <div class="row-head">${recommended ? '<span class="badge accent">★ Recommended</span>' : ""} ${title}
      <span class="row-note">· ${r.fit.servings} servings · score ${r.fit.score}</span></div>
    <div class="plate-preview">${preview || "Nothing suitable on this menu"}</div>
    ${chips(r.totals)}
    ${r.misses.map((m) => `<div class="miss">✗ ${esc(m)}</div>`).join("")}
    ${r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
  </a>`;
}

// ---------------------------------------------------------------------------
// Screen 2: Plate view
// ---------------------------------------------------------------------------

function renderPlate(key) {
  const menu = app.menus.get(key);
  const [iso, hallId, meal] = key.split("|");
  let html = `<a class="back" href="#/week">← This week</a>
    <h2>${esc(dateLabel(iso, { long: true }))}<br>${esc(hallName(hallId))} · ${esc(meal)}</h2>`;
  if (!menu || menu.status !== "open") {
    main.innerHTML = html + `<p class="empty">${menu?.status === "closed" ? "Closed." : "No menu posted."}</p>`;
    return;
  }
  const ms = mealState(key);
  const plan = planFor(key);
  if (!ms.eaten && plan.state !== "done") {
    main.innerHTML = html + `<p class="empty">${plan.state === "error" ? "Couldn't plan this menu." : "Planning your plate…"}</p>`;
    return;
  }
  const servings = ms.eaten ?? planServings(plan.result);
  const totals = totalsOf(servings);
  const mode = ms.swipeId ? "Logged meal" : ms.eaten ? "What I ate" : "Suggested plate";

  // Totals panel with target bars
  const SCALE = 1.5;        // bars run from 0 to 150% of target
  const bars = MACROS.map((k) => {
    const target = app.targets[k];
    const status = macroStatus(k, totals[k]);
    const tol = k === "protein_g" ? null : app.config.tolerance[k];
    const lo = tol === null ? 1 : 1 - tol;
    const hi = tol === null ? SCALE : 1 + tol;
    const pct = (x) => `${(Math.min(x, SCALE) / SCALE) * 100}%`;
    return `<div class="macro"><span>${MACRO_NAMES[k]}</span>
      <div class="bar"><div class="band" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})"></div>
        <div class="fill ${status}" style="width:${pct(totals[k] / target)}"></div>
        <div class="target" style="left:${pct(1)}"></div></div>
      <span class="macro-value">${round(totals[k])} / ${target} ${MACRO_UNIT[k]}</span></div>`;
  }).join("");

  const warnings = [];
  if (menu.removed_from_website) warnings.push(`Menu ${menu.warning || "removed from website"}`);
  for (const [id, n] of Object.entries(servings)) {
    const item = app.itemById.get(id);
    if (!item || n <= 0) continue;
    if (item.estimated) warnings.push(`${item.name}: estimated numbers (rescaled from a bulk batch)`);
    if (item.flags.length) warnings.push(`${item.name}: flagged numbers (${item.flags.map((f) => f.check).join(", ")}), totals may be off`);
  }

  html += `<section class="card totals">
    <div class="card-head"><h3>${mode}</h3>${ms.eaten && !ms.swipeId ? '<button class="btn small" data-action="reset-plan">Reset to plan</button>' : ""}</div>
    ${bars}
    ${missLines(totals).map((m) => `<div class="miss">✗ ${esc(m)}</div>`).join("")}
    ${warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
  </section>`;

  // Items grouped by station: what's on the plate, then (optionally) the rest of the menu
  const unavailable = new Set(ms.unavailable);
  const menuItems = (app.itemsByMenu.get(key) ?? []).filter((i) => !unavailable.has(i.id));
  const onPlate = menuItems.filter((i) => (servings[i.id] ?? 0) > 0);
  const others = menuItems.filter((i) => !((servings[i.id] ?? 0) > 0));
  html += stationGroups(onPlate, servings, key);
  if (!onPlate.length) html += `<p class="empty">Nothing on the plate yet.</p>`;

  html += `<button class="btn wide" data-action="toggle-menu">${app.showFullMenu ? "Hide" : "Show"} the rest of the menu (${others.length})</button>`;
  if (app.showFullMenu) html += stationGroups(others, servings, key);

  if (unavailable.size) {
    html += `<section class="card"><h3>Marked not available</h3>${[...unavailable].map((id) => {
      const item = app.itemById.get(id);
      return `<div class="swipe"><span>${esc(item?.name ?? "Unknown item")}</span>
        <button class="btn small" data-action="restore" data-id="${esc(id)}">Undo</button></div>`;
    }).join("")}</section>`;
  }

  const week = swipeWeekStart(iso, app.state.settings.resetDay);
  const left = app.state.settings.swipesPerWeek - swipesInWeek(app.state.swipes, week).length;
  html += ms.swipeId
    ? `<section class="card"><p style="margin:0">✓ Logged. This meal used a swipe.</p>
        <button class="btn wide" data-action="unlog">Undo log</button></section>`
    : `<button class="btn primary wide" data-action="log">Log this meal · uses a swipe (${Math.max(0, left)} left that week)</button>`;

  main.innerHTML = html;
}

function stationGroups(items, servings, key) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.station)) groups.set(item.station, []);
    groups.get(item.station).push(item);
  }
  let html = "";
  for (const [station, list] of groups) {
    html += `<div class="station"><h3>${esc(station)}</h3><ul class="items">${list.map((item) => {
      const n = servings[item.id] ?? 0;
      const excluded = exclusionReason(item, app.config);
      const n_ = item.nutrients;
      const badges = [item.estimated ? '<span class="badge warn">estimated</span>' : "",
                      excluded ? `<span class="badge warn">${esc(excluded)}</span>` : ""].join(" ");
      return `<li class="item ${n ? "" : "off"}">
        <button class="item-main" data-action="info" data-id="${esc(item.id)}">
          <span class="item-name">${esc(item.name)}</span>
          <span class="item-sub">${esc(item.serving)} · ${round(n_.calories.value ?? 0)} kcal · ${round(n_.protein_g.value ?? 0)} g protein ${badges}</span>
        </button>
        <div class="item-controls">
          <div class="stepper">
            <button data-action="dec" data-id="${esc(item.id)}" aria-label="One less ${esc(item.name)}" ${n ? "" : "disabled"}>−</button>
            <span class="count" aria-label="servings">${n}</span>
            <button data-action="inc" data-id="${esc(item.id)}" aria-label="One more ${esc(item.name)}">+</button>
          </div>
          <button class="link-btn" data-action="unavailable" data-id="${esc(item.id)}">Not available</button>
        </div></li>`;
    }).join("")}</ul></div>`;
  }
  return html;
}

function snapshotOf(servings) {
  const items = Object.entries(servings).filter(([, n]) => n > 0).map(([id, n]) => ({ id, name: app.itemById.get(id)?.name ?? id, servings: n }));
  const totals = Object.fromEntries(Object.entries(totalsOf(servings)).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { items, totals };
}

function changeServings(key, id, delta) {
  const ms = { ...mealState(key) };
  const plan = planFor(key);
  const servings = { ...(ms.eaten ?? (plan.state === "done" ? planServings(plan.result) : {})) };
  servings[id] = Math.min(20, Math.max(0, (servings[id] ?? 0) + delta));
  if (!servings[id]) delete servings[id];
  ms.eaten = servings;
  if (ms.swipeId) ms.snapshot = snapshotOf(servings);
  setMealState(key, ms);
  render();
}

function markUnavailable(key, id) {
  const ms = { ...mealState(key), unavailable: [...new Set([...mealState(key).unavailable, id])] };
  if (ms.swipeId && ms.eaten) {           // already logged: just take it off what you ate
    ms.eaten = { ...ms.eaten };
    delete ms.eaten[id];
    ms.snapshot = snapshotOf(ms.eaten);
  } else {
    ms.eaten = null;                      // follow the new plan
  }
  setMealState(key, ms);
  toast(`Re-planning without ${app.itemById.get(id)?.name ?? "that item"}…`);
  render();
}

function restoreItem(key, id) {
  const ms = mealState(key);
  setMealState(key, { ...ms, unavailable: ms.unavailable.filter((x) => x !== id), eaten: ms.swipeId ? ms.eaten : null });
  render();
}

function logMeal(key) {
  const ms = { ...mealState(key) };
  const plan = planFor(key);
  const servings = ms.eaten ?? (plan.state === "done" ? planServings(plan.result) : null);
  if (!servings) return;
  const [iso, hallId, meal] = key.split("|");
  const swipe = { id: newId(), date: iso, at: new Date().toISOString(), menuKey: key, label: `${hallName(hallId)} ${meal}` };
  app.state.swipes.push(swipe);
  setMealState(key, { ...ms, eaten: servings, swipeId: swipe.id, snapshot: snapshotOf(servings) });
  toast("Meal logged, 1 swipe used.");
  render();
}

function removeSwipe(swipeId) {
  const swipe = app.state.swipes.find((s) => s.id === swipeId);
  app.state.swipes = app.state.swipes.filter((s) => s.id !== swipeId);
  if (swipe?.menuKey && mealState(swipe.menuKey).swipeId === swipeId) {
    app.state.meals[swipe.menuKey] = { ...mealState(swipe.menuKey), swipeId: null, snapshot: null };
  }
  persist();
  render();
}

function openInfo(id) {
  const item = app.itemById.get(id);
  if (!item) return;
  const n = item.nutrients;
  const diet = [["vegan", "Vegan"], ["vegetarian", "Vegetarian"], ["gluten_free", "Gluten-free"], ["halal", "Halal"], ["kosher", "Kosher"]]
    .filter(([k]) => item[k]).map(([, label]) => `<span class="badge">${label}</span>`).join(" ");
  const allergens = item.allergens === null
    ? "Not available from the university. Ask hall staff."
    : item.allergens.length ? item.allergens.join(", ") : "None listed";
  document.getElementById("info-body").innerHTML = `
    <h2 id="info-title" style="margin-top:0">${esc(item.name)}</h2>
    <p class="summary">${esc(item.station)}${item.other_stations.length ? ` (also at ${esc(item.other_stations.join(", "))})` : ""} · per serving: ${esc(item.serving)}</p>
    ${item.other_sizes.length ? `<p class="summary">Other sizes: ${esc(item.other_sizes.map((s) => s.serving).join(", "))}</p>` : ""}
    ${item.estimate_note ? `<div class="warn">⚠ ${esc(item.estimate_note)}</div>` : ""}
    ${item.flags.map((f) => `<div class="warn">⚠ ${esc(f.check)}: ${esc(f.reason)}</div>`).join("")}
    <table class="nutrition">${NUTRITION_ROWS.map(([k, label, sub]) =>
      `<tr class="${sub ? "sub" : ""}"><td>${label}</td><td>${esc(n[k]?.display ?? "unknown")}</td></tr>`).join("")}</table>
    ${diet ? `<p>${diet}</p>` : ""}
    <p><strong>Allergens:</strong> ${esc(allergens)}</p>
    ${item.ingredients ? `<p class="summary"><strong>Ingredients:</strong> ${esc(item.ingredients)}</p>` : ""}`;
  document.getElementById("info").showModal();
}

// ---------------------------------------------------------------------------
// Screen 3: Swipes
// ---------------------------------------------------------------------------

function renderSwipes() {
  const settings = app.state.settings;
  const start = swipeWeekStart(todayIso(), settings.resetDay);
  const end = addDays(start, 6);
  const thisWeek = swipesInWeek(app.state.swipes, start).sort((a, b) => a.date.localeCompare(b.date));
  const left = settings.swipesPerWeek - thisWeek.length;
  const daysToReset = Math.round((parseIso(end) - parseIso(todayIso())) / 86400000);

  let html = `<section class="card" style="text-align:center">
    <div class="big-number">${Math.max(0, left)}</div>
    <div>of ${settings.swipesPerWeek} swipes left this week${left < 0 ? ` (${-left} over)` : ""}</div>
    <p class="summary">${esc(dateLabel(start))} – ${esc(dateLabel(end))}<br>
      Resets ${DAY_LABELS[settings.resetDay]} 11:59 pm${daysToReset ? ` (in ${daysToReset} day${daysToReset === 1 ? "" : "s"})` : " (tonight)"}</p>
  </section>
  <section class="card"><h3>This week</h3>
    ${thisWeek.length ? thisWeek.map(swipeRow).join("") : '<p class="row-note">No swipes used yet.</p>'}
    <button class="btn wide" data-action="add-swipe">+ Add a swipe I didn't log</button>
  </section>`;

  const otherWeeks = new Map();
  for (const s of app.state.swipes) {
    const ws = swipeWeekStart(s.date, settings.resetDay);
    if (ws !== start) otherWeeks.set(ws, (otherWeeks.get(ws) ?? 0) + 1);
  }
  if (otherWeeks.size) {
    html += `<section class="card"><h3>Other weeks</h3>${[...otherWeeks].sort((a, b) => b[0].localeCompare(a[0])).map(([ws, count]) =>
      `<div class="swipe"><span>Week of ${esc(dateLabel(ws))}</span><span>${count} / ${settings.swipesPerWeek}</span></div>`).join("")}</section>`;
  }
  main.innerHTML = html;
}

function swipeRow(s) {
  const meal = s.menuKey ? mealState(s.menuKey) : null;
  const totals = meal?.swipeId === s.id && meal.snapshot ? meal.snapshot.totals : null;
  const label = s.menuKey ? `<a href="${plateHref(s.menuKey)}">${esc(s.label)}</a>` : esc(s.label);
  return `<div class="swipe"><span>${esc(dateLabel(s.date))} · ${label}
      ${totals ? `<br><span class="row-note">${round(totals.calories)} kcal · ${round(totals.protein_g)} g protein</span>` : ""}</span>
    <button class="btn small" data-action="remove-swipe" data-id="${esc(s.id)}">Remove</button></div>`;
}

// ---------------------------------------------------------------------------
// Screen 4: Settings
// ---------------------------------------------------------------------------

function numberField(name, label, value, hint = "", step = "1") {
  return `<div class="field"><label for="f-${name}">${label}${hint ? `<span class="hint">${hint}</span>` : ""}</label>
    <input id="f-${name}" name="${name}" type="number" inputmode="decimal" step="${step}" value="${esc(value)}"></div>`;
}

function renderSettings() {
  const s = app.state.settings;
  const itemNames = [...new Set(app.data.items.map((i) => i.name))].sort();
  main.innerHTML = `<form id="settings" autocomplete="off" onsubmit="return false">
    <p id="settings-status" class="status-line"></p>

    <section class="card"><h3>Daily targets</h3>
      ${MACROS.map((k) => numberField(`dailyTargets.${k}`, `${MACRO_NAMES[k]} (${MACRO_UNIT[k]})`,
        s.dailyTargets[k], k === "protein_g" ? "Minimum: going over is fine" : "")).join("")}
      ${numberField("hallSharePct", "Hall meal share (%)", s.hallSharePct, "How much of the day the hall meal covers")}
      <p id="meal-targets" class="summary"></p>
    </section>

    <section class="card"><h3>Tolerances (± % of target)</h3>
      ${["calories", "carbs_g", "fat_g"].map((k) => numberField(`tolerancePct.${k}`, MACRO_NAMES[k], s.tolerancePct[k])).join("")}
    </section>

    <section class="card"><h3>Servings</h3>
      ${numberField("maxServings", "Max servings per item", s.maxServings)}
      ${numberField("perServing", "Cost per serving", s.perServing,
        "Higher = smaller plates, a little further from target. 0 = hit targets exactly, however many servings.", "0.5")}
      <h3 style="margin-top:12px">Per-item limits</h3>
      <datalist id="item-names">${itemNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <div id="overrides">${Object.entries(s.maxServingsByName).map(([name, cap]) => overrideRow(name, cap)).join("")}</div>
      <button type="button" class="btn small" data-action="add-override">+ Add an item limit</button>
    </section>

    <section class="card"><h3>Halls</h3>
      ${HALLS.map((h) => `<div class="field"><label for="f-hall-${h.id}">${h.name}</label>
        <input class="switch" id="f-hall-${h.id}" name="halls.${h.id}" type="checkbox" ${s.halls[h.id] ? "checked" : ""}></div>`).join("")}
    </section>

    <section class="card"><h3>When I can eat at the hall</h3>
      <table class="grid"><tr><th></th>${MEALS.map((m) => `<th>${m}</th>`).join("")}</tr>
        ${DAYS.map((d) => `<tr><th>${DAY_LABELS[d].slice(0, 3)}</th>${MEALS.map((m) =>
          `<td><label><input class="switch" type="checkbox" name="avail.${d}.${m}" aria-label="${DAY_LABELS[d]} ${m}"
            ${s.availability[d][m] ? "checked" : ""}></label></td>`).join("")}</tr>`).join("")}
      </table>
    </section>

    <section class="card"><h3>Meal plan</h3>
      ${numberField("swipesPerWeek", "Swipes per week", s.swipesPerWeek)}
      <div class="field"><label for="f-reset">Plan resets at 11:59 pm on</label>
        <select id="f-reset" name="resetDay">${DAYS.map((d) => `<option value="${d}" ${d === s.resetDay ? "selected" : ""}>${DAY_LABELS[d]}</option>`).join("")}</select></div>
    </section>

    <section class="card"><h3>Your data</h3>
      <p class="summary">Settings, swipes and meal logs are stored only on this device. Export a backup to move them or keep them safe.</p>
      <button type="button" class="btn wide" data-action="export">Export backup</button>
      <button type="button" class="btn wide" data-action="import">Import backup</button>
      <button type="button" class="btn wide" data-action="reset-settings">Reset settings to defaults</button>
    </section>
  </form>`;
  updateSettingsStatus();
}

function overrideRow(name = "", cap = 3) {
  return `<div class="override" data-override>
    <input type="text" list="item-names" placeholder="Item name" aria-label="Item name" value="${esc(name)}" data-ov="name">
    <input type="number" inputmode="numeric" min="0" max="20" aria-label="Max servings" value="${esc(cap)}" data-ov="cap">
    <button type="button" class="btn small" data-action="remove-override" aria-label="Remove limit">✕</button></div>`;
}

function readSettingsForm() {
  const form = document.getElementById("settings");
  const draft = structuredClone(app.state.settings);
  for (const el of form.elements) {
    if (!el.name) continue;
    const path = el.name.split(".");
    if (path[0] === "avail") draft.availability[path[1]][path[2]] = el.checked;
    else if (path[0] === "halls") draft.halls[path[1]] = el.checked;
    else if (path.length === 2) draft[path[0]][path[1]] = el.value;
    else draft[path[0]] = el.value;
  }
  draft.maxServingsByName = {};
  for (const row of form.querySelectorAll("[data-override]")) {
    const name = row.querySelector('[data-ov="name"]').value.trim();
    if (name) draft.maxServingsByName[name] = row.querySelector('[data-ov="cap"]').value;
  }
  return cleanSettings(draft, app.state.settings);   // invalid fields keep their current value
}

function applySettings(settings) {
  app.state.settings = settings;
  persist();
  refreshConfig();
  for (const iso of weekDays()) for (const slot of slotsForDay(iso)) if (slot.plannable) planFor(slot.key);
  updateSettingsStatus();
}

function updateSettingsStatus() {
  const status = document.getElementById("settings-status");
  if (!status) return;
  const pending = [...app.plans.values()].filter((p) => p.state === "pending").length;
  status.textContent = pending ? `Re-planning ${pending} menu${pending === 1 ? "" : "s"}…` : "Plans are up to date. Changes save automatically.";
  const t = app.targets;
  document.getElementById("meal-targets").textContent =
    `Hall meal targets: ${t.calories} kcal · ${t.protein_g} g protein (min) · ${t.carbs_g} g carbs · ${t.fat_g} g fat`;
}

function exportBackup() {
  const blob = new Blob([exportText(app.state)], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: `hall-macros-backup-${todayIso()}.json`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importBackup(file) {
  try {
    const imported = importText(await file.text());
    if (!confirm("Replace all settings, swipes and meal logs on this device with this backup?")) return;
    app.state = imported;
    persist();
    refreshConfig();
    toast("Backup imported.");
    render();
  } catch (error) {
    alert(error.message);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

main.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  const route = currentRoute();
  const key = route.arg;
  switch (action) {
    case "inc": return changeServings(key, id, +1);
    case "dec": return changeServings(key, id, -1);
    case "unavailable": return markUnavailable(key, id);
    case "restore": return restoreItem(key, id);
    case "info": return openInfo(id);
    case "toggle-menu": app.showFullMenu = !app.showFullMenu; return render();
    case "reset-plan": setMealState(key, { ...mealState(key), eaten: null }); return render();
    case "log": return logMeal(key);
    case "unlog": return removeSwipe(mealState(key).swipeId);
    case "remove-swipe": return removeSwipe(id);
    case "add-swipe":
      app.state.swipes.push({ id: newId(), date: todayIso(), at: new Date().toISOString(), menuKey: null, label: "Other meal" });
      persist();
      return render();
    case "add-override":
      document.getElementById("overrides").insertAdjacentHTML("beforeend", overrideRow("", app.state.settings.maxServings));
      return document.querySelector("#overrides [data-override]:last-child input").focus();
    case "remove-override":
      el.closest("[data-override]").remove();
      return applySettings(readSettingsForm());
    case "export": return exportBackup();
    case "import": return document.getElementById("import-file").click();
    case "reset-settings":
      if (!confirm("Reset all settings to the defaults? Swipes and meal logs are kept.")) return;
      applySettings(cleanSettings({}));
      return renderSettings();
  }
});

// Settings: apply shortly after typing stops, and immediately when a field is left/toggled.
let settingsTimer;
main.addEventListener("input", (event) => {
  if (!event.target.closest("#settings")) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => applySettings(readSettingsForm()), 400);
});
main.addEventListener("change", (event) => {
  if (!event.target.closest("#settings")) return;
  clearTimeout(settingsTimer);
  applySettings(readSettingsForm());
  // Show the value actually in use (e.g. an emptied box goes back to its saved value).
  const el = event.target;
  if (el.type === "number" && el.name) {
    const [a, b] = el.name.split(".");
    el.value = b ? app.state.settings[a][b] : app.state.settings[a];
  }
});

document.getElementById("import-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) importBackup(file);
});

const dialog = document.getElementById("info");
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });   // tap outside closes

window.addEventListener("hashchange", () => {
  app.showFullMenu = false;
  render();
  window.scrollTo(0, 0);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

document.getElementById("storage-banner").hidden = storageAvailable();
refreshConfig();
await loadData();
render();
