/**
 * Plate optimizer: picks integer servings from one menu to hit the meal targets.
 *
 * Runs in the browser (and in Node for testing). It does no network access:
 * the page loads data/clean/items.json and menus.json and passes them in.
 *
 * Model (integer linear program) for one menu = one hall + date + meal period:
 *   x_i                 servings of item i, integer, 0..cap_i
 *   protein             sum(p_i * x_i) + short >= target            short: big penalty
 *   calories/carbs/fat  sum(n_i * x_i) + under_in + under_out - over_in - over_out = target
 *                       under_in, over_in <= tolerance * target     inside the band: small penalty
 *                       under_out, over_out unlimited                outside the band: big penalty
 *   minimize            weighted deviations (per 1% of target) + a tiny cost per serving
 * Every target is soft, so a solve always returns a plate; misses are reported, not errors.
 *
 * Solver: javascript-lp-solver 1.0.3, vendored (pinned copy) in ./vendor/.
 */
import solver from "./vendor/javascript-lp-solver-1.0.3.js";

export const DEFAULT_CONFIG = {
  dailyTargets: { calories: 3600, protein_g: 190, carbs_g: 485, fat_g: 100 },
  hallShare: 0.75,                                   // the hall meal covers this share of the day
  tolerance: { calories: 0.10, carbs_g: 0.10, fat_g: 0.10 },   // ± fraction of the meal target
  maxServings: 3,
  maxServingsByName: { "Fried Eggs": 5 },            // 5 servings = 10 eggs
  excludedNames: [],
  // Penalty per 1% of target missed: protein shortfall > calories > carbs, fat.
  weights: {
    proteinShortfall: 50,
    outsideTolerance: { calories: 20, carbs_g: 8, fat_g: 8 },
    insideTolerance: { calories: 1, carbs_g: 0.5, fat_g: 0.5 },
    // Cost per serving: an extra serving must improve the fit by >= 2 points to be added.
    // Without it, almost any menu can hit 2700 kcal to the calorie with 20+ servings,
    // every menu "fits", and the solver wastes seconds chasing the last few kcal.
    perServing: 2,
  },
  solverTimeoutMs: 3000,
};

const MACROS = ["calories", "protein_g", "carbs_g", "fat_g"];
const BANDED = ["calories", "carbs_g", "fat_g"];
const LABELS = { calories: "Calories", protein_g: "Protein", carbs_g: "Carbs", fat_g: "Fat" };
const UNITS = { calories: "kcal", protein_g: "g", carbs_g: "g", fat_g: "g" };

const round1 = (x) => Math.round(x * 10) / 10;
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Meal targets = daily targets x hall share, rounded (2700 kcal, 143 g protein, ...). */
export function mealTargets(config = DEFAULT_CONFIG) {
  return Object.fromEntries(MACROS.map((k) => [k, Math.round(config.dailyTargets[k] * config.hallShare)]));
}

/** Why an item can't be recommended, or null if it can. */
export function exclusionReason(item, config = DEFAULT_CONFIG) {
  if (config.excludedNames.some((n) => sameName(n, item.name))) return "excluded in settings";
  if (!item.usable) return "not usable (unhandled bulk recipe)";
  if (item.flags.length) return "flagged: " + item.flags.map((f) => f.check).join(", ");
  if (MACROS.some((k) => item.nutrients[k].value == null)) return "missing calories or macros";
  return null;
}

function servingCap(item, config) {
  const match = Object.entries(config.maxServingsByName).find(([name]) => sameName(name, item.name));
  return match ? match[1] : config.maxServings;
}

/** Build the solver model for one menu. Exported so tests can inspect or re-solve it. */
export function buildModel(menuItems, config = DEFAULT_CONFIG) {
  const targets = mealTargets(config);
  const w = config.weights;
  const eligible = [];
  const excluded = [];
  for (const item of menuItems) {
    const reason = exclusionReason(item, config);
    if (reason) excluded.push({ name: item.name, reason });
    else eligible.push(item);
  }

  const constraints = {};
  const variables = {};
  const ints = {};
  const perUnit = (k, weightPerPct) => (weightPerPct * 100) / targets[k];   // penalty per g or kcal

  constraints.protein_g = { min: targets.protein_g };
  variables.protein_short = { protein_g: 1, penalty: perUnit("protein_g", w.proteinShortfall) };

  for (const k of BANDED) {
    const band = config.tolerance[k] * targets[k];
    constraints[k] = { equal: targets[k] };
    constraints[`${k}_under_band`] = { max: band };
    constraints[`${k}_over_band`] = { max: band };
    variables[`${k}_under_in`] = { [k]: 1, [`${k}_under_band`]: 1, penalty: perUnit(k, w.insideTolerance[k]) };
    variables[`${k}_over_in`] = { [k]: -1, [`${k}_over_band`]: 1, penalty: perUnit(k, w.insideTolerance[k]) };
    variables[`${k}_under_out`] = { [k]: 1, penalty: perUnit(k, w.outsideTolerance[k]) };
    variables[`${k}_over_out`] = { [k]: -1, penalty: perUnit(k, w.outsideTolerance[k]) };
  }

  eligible.forEach((item, i) => {
    const v = { penalty: w.perServing, [`cap${i}`]: 1 };
    for (const k of MACROS) v[k] = item.nutrients[k].value;
    variables[`x${i}`] = v;
    constraints[`cap${i}`] = { max: servingCap(item, config) };
    ints[`x${i}`] = 1;
  });

  const model = {
    optimize: "penalty", opType: "min", constraints, variables, ints,
    options: { timeout: config.solverTimeoutMs, tolerance: 0 },
  };
  return { model, eligible, excluded, targets };
}

/** How badly a set of totals misses the targets (same weights as the solver, minus the tie-breaker). */
export function fitPenalty(totals, targets, config = DEFAULT_CONFIG) {
  const w = config.weights;
  const pct = (k, amount) => (amount / targets[k]) * 100;
  let penalty = w.proteinShortfall * pct("protein_g", Math.max(0, targets.protein_g - totals.protein_g));
  for (const k of BANDED) {
    const off = pct(k, Math.abs(totals[k] - targets[k]));
    const inside = Math.min(off, config.tolerance[k] * 100);
    penalty += w.insideTolerance[k] * inside + w.outsideTolerance[k] * (off - inside);
  }
  return round1(penalty);
}

/**
 * Ranking score = target misses + serving cost (exactly what the solver minimizes). Lower is better.
 * penalty: how far off the targets the plate is; servings: plate size.
 */
function fitSummary(totals, targets, plate, config, misses) {
  const penalty = fitPenalty(totals, targets, config);
  const servings = plate.reduce((sum, p) => sum + p.servings, 0);
  return { score: round1(penalty + config.weights.perServing * servings), penalty, servings,
           meetsAllTargets: misses.length === 0 };
}

/**
 * Solve one menu. `menuInfo` is its entry from menus.json (for date/hall/meal and warnings).
 * Returns { menu, plate, totals, report, misses, warnings, excluded, fit, solver }.
 */
export function solveMenu(menuItems, menuInfo = {}, config = DEFAULT_CONFIG) {
  const { model, eligible, excluded, targets } = buildModel(menuItems, config);
  const started = Date.now();
  const result = solver.Solve(model);
  const elapsedMs = Date.now() - started;

  const plate = [];
  eligible.forEach((item, i) => {
    const servings = Math.round(result[`x${i}`] || 0);
    if (servings > 0) {
      plate.push({
        name: item.name, station: item.station, servings, serving: item.serving,
        estimated: item.estimated, id: item.id,
        perServing: Object.fromEntries(MACROS.map((k) => [k, item.nutrients[k].value])),
      });
    }
  });

  const totals = Object.fromEntries(
    MACROS.map((k) => [k, round1(plate.reduce((sum, p) => sum + p.servings * p.perServing[k], 0))]));

  const report = {};
  const misses = [];
  const short = round1(Math.max(0, targets.protein_g - totals.protein_g));
  report.protein_g = { total: totals.protein_g, target: targets.protein_g, rule: "minimum", met: short === 0 };
  if (short > 0) misses.push(`Protein: ${short} g short of the ${targets.protein_g} g minimum`);
  for (const k of BANDED) {
    const tol = config.tolerance[k];
    const diffPct = round1(((totals[k] - targets[k]) / targets[k]) * 100);
    const within = Math.abs(totals[k] - targets[k]) <= tol * targets[k] + 1e-9;
    report[k] = { total: totals[k], target: targets[k], diffPct, within,
                  allowed: [Math.round(targets[k] * (1 - tol)), Math.round(targets[k] * (1 + tol))] };
    if (!within) {
      misses.push(`${LABELS[k]}: ${totals[k]} ${UNITS[k]} is ${Math.abs(diffPct)}% ` +
                  `${diffPct < 0 ? "under" : "over"} the ${targets[k]} ${UNITS[k]} target (allowed ±${tol * 100}%)`);
    }
  }

  const warnings = [];
  if (menuInfo.removed_from_website) warnings.push(`Menu ${menuInfo.warning || "removed from website"}`);
  if (menuInfo.status && menuInfo.status !== "open") warnings.push(`Menu status is "${menuInfo.status}"`);
  for (const p of plate.filter((p) => p.estimated)) {
    warnings.push(`${p.name}: estimated numbers (rescaled from a bulk batch)`);
  }
  const timedOut = elapsedMs >= config.solverTimeoutMs;
  if (!result.feasible) warnings.push("Solver found no solution (this shouldn't happen; please report)");
  else if (timedOut) warnings.push("Solver hit its time limit; this plate may not be the best possible");

  return {
    menu: { date: menuInfo.date, hall: menuInfo.hall, meal: menuInfo.meal },
    targets, plate, totals, report, misses, warnings, excluded,
    fit: fitSummary(totals, targets, plate, config, misses),
    solver: { feasible: result.feasible, timedOut, elapsedMs },
  };
}

const menuKey = (x) => `${x.date}|${x.hall}|${x.meal}`;

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayISO() {
  return new Date().toLocaleDateString("en-CA");
}

/**
 * Solve every open menu from `fromDate` for `days` days, ranked best fit first.
 * Returns { fromDate, toDate, ranked: [solveMenu results + rank], skipped: [closed/no_menu menus] }.
 */
export function planWeek(items, menus, config = DEFAULT_CONFIG, { fromDate = todayISO(), days = 7 } = {}) {
  const toDate = addDays(fromDate, days);          // exclusive
  const itemsByMenu = new Map();
  for (const item of items) {
    const key = menuKey(item);
    if (!itemsByMenu.has(key)) itemsByMenu.set(key, []);
    itemsByMenu.get(key).push(item);
  }

  const ranked = [];
  const skipped = [];
  for (const menu of menus) {
    if (menu.date < fromDate || menu.date >= toDate) continue;
    if (menu.status !== "open") {
      skipped.push({ date: menu.date, hall: menu.hall, meal: menu.meal, status: menu.status });
      continue;
    }
    ranked.push(solveMenu(itemsByMenu.get(menuKey(menu)) || [], menu, config));
  }
  ranked.sort((a, b) => a.fit.score - b.fit.score);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { fromDate, toDate: addDays(toDate, -1), ranked, skipped };
}
