# Dining Macros (Queen's dining hall macro tracker)

A personal tool for one student: download the Queen's University dining hall menus,
clean the nutrition data, pick the best plate for each meal with an integer linear
program, and show it in a phone-first web app.

## Working with the user
- Mechanical engineering student, beginner at Python and JavaScript, on Windows 11.
- Brief, beginner-friendly explanations of what each piece does and why. Don't re-explain earlier concepts.
- At most 2 short "try changing this" exercises per phase.
- Keep outputs short to save tokens: don't print whole files or long command outputs.
- Build in phases. Show anything that needs review (flag lists, plans) before finalizing it.
- Ask before deleting or overwriting data. Never commit unless asked.

## Status
- Done: Phase 1 (fetcher), 2 (cleaner), 3 (optimizer), 4 (website).
- **Next: Phase 5**: publish `web/` on GitHub Pages, and schedule the fetch + clean
  (e.g. GitHub Actions) so `web/data/menus.json` stays current. Then test on the real phone.
- Ban Righ (14628) has returned no menus at all (empty `MealPeriods`) since 2026-10-11, though the
  dining site's own config says it isn't closed. The user is checking it. The app shows "No menu posted".

## Layout and commands
Run from this folder (`C:\Users\djlav\Downloads\dining-macros`), Python 3.10 (Microsoft Store install):
```
.venv\Scripts\python fetch_menus.py    # download next 7 days -> data/raw/ (versioned)
.venv\Scripts\python clean_menus.py    # data/raw -> data/clean/ + web/data/menus.json
.venv\Scripts\python serve.py          # http://localhost:8000/web/  (test in DevTools phone emulation)
.venv\Scripts\python tools\make_icons.py   # regenerate web/icons/*.png (pure Python)
```
- Fresh setup: `python -m venv .venv` then `.venv\Scripts\python -m pip install -r requirements.txt` (only `requests`).
- Use `serve.py`, not `python -m http.server`: on Windows the latter can send `.js` with the wrong
  content type and browsers then refuse to run JavaScript modules.
- Node.js is NOT installed and isn't needed. `web/package.json` (`"type": "module"`) only exists so Node can import the modules for testing.
- Git 2.56 (Git for Windows) is installed and on PATH, with the global name and email set. Sign-in uses Git Credential Manager (a browser login on the first push). Commit email = GitHub noreply `205542163+DO0J@users.noreply.github.com`
  (username DO0J, with a zero). Repo initialised on branch `main`, no commits or remote yet. `.gitignore` excludes `.venv/`,
  `data/raw/` and `data/clean/` (regenerated; `web/data/menus.json` IS committed).

## Data source
`https://www.queensu.ca/food/dining/todays-menu/feed?locationId=ID&mealPeriod=Lunch&selDate=MM-DD-YYYY`
- JSON, no cookies. mealPeriod: Breakfast, Lunch, Dinner. Menus are posted ~7 days ahead.
- Halls: **Leonard 14627**, **Ban Righ 14628**, **Jean-Royce 14629** (found in the config embedded in
  https://www.queensu.ca/food/eat-now/todays-menu).
- Structure: `MealPeriods[0].Stations[].SubCategories[].Items[]`. Nutrient values are strings ("3.5 g",
  "less than 1 g"), and some are null. Empty `MealPeriods` = no menu posted; empty `Stations` = closed.
  `{"error": ...}` = bad request (e.g. mealPeriod "Brunch").
- ProductId `272162_123503_M3047_4_486779`: part 3 is the **recipe code** (may start with M or A).
  The last part identifies one serving size. Verified across all files: one code = one name, and the same full ID always has the same data.

## Phase 1: fetcher + archive (`fetch_menus.py`, `raw_archive.py`)
- Fetches today + 6 days × 3 halls × 3 meals, 0.5 s pause, 20 s timeout, 1 retry.
- Archive files are **written once, never changed**: `data/raw/<date>/<hall>_<meal>__<YYYYMMDD-HHMMSS>.json`.
  A new version is saved only if the parsed JSON differs from the newest saved version. Unversioned files
  from before versioning count as the oldest version. Writes go to a temp file first and refuse to overwrite.
- Server error replies are not archived (they would hide the real menu).
- `data/raw/` stays out of Git. The user backs it up separately.

## Phase 2: cleaner rules (`clean_menus.py`)
Reads the newest version of each menu (read-only). Writes `data/clean/` (items.json, items.csv, menus.json,
flags.txt) and the site file `web/data/menus.json` (`{generated_at, menus, items}`, compact).
- Nutrients are stored as `{value, display}`. "less than X" -> display "<X", value X/2. Missing/null/unreadable ->
  `value: null`, "unknown" (never 0). `incomplete` = a required nutrient is missing (all except added sugars,
  which is null for ~95% of items). CaloriesFromFat is ignored.
- Allergens: `null` + `allergens_known: false` when the feed says info isn't available (most items).
- One record per recipe per menu: size variants -> smallest by calories is the base (others go in `other_sizes`).
  The same recipe at several stations is merged (`other_stations`).
- Bulk ("Made-to-Order/Bulk Recipe"): an entry is a batch if it's ≥1000 g/mL. If a portion-sized twin is in the menu, use it and drop the batch.
  Otherwise rescale soups -> 250 mL and salad bar -> 150 g, with `estimated: true`. Anything else -> `bulk_unhandled`, `usable: false`.
- `is_deemphasized` is the raw IsDeemphasized field only (it is NOT an add-on flag: soups, salads and eggs have it).
- `station_sort` = station position on the menu (feed Sort, then list order).
- Outlier flags (flag, never hide; the reason is stored):
  1. `calorie_mismatch`: |listed − (4P+4C+9F)| > max(25 kcal, 20%).
  2. `fat_density`: ≥30 g fat/100 g with <10 g protein/100 g (catches the fries at 37 g/100 g; bacon, sausage and cheddar pass).
     The user chose to keep the threshold at 30.
  3. `impossible_weight`: P+C+F grams > serving grams.
  Currently flagged: French Fries (Leonard, Jean-Royce) and Jean-Royce Curry Pumpkin Soup (75 kcal listed vs 238 from macros).
- Menu status: open / closed / no_menu / error. If the newest version is no_menu but an older version was open,
  use the last real menu with `removed_from_website: true`, warning "removed from website, may be cancelled".

## Phase 3: optimizer (`web/optimizer.js`)
- Browser JS module, solver **javascript-lp-solver 1.0.3** vendored at `web/vendor/` (no CDN). It was checked against
  0.4.24 and with a local search for better plates on all menus.
- One plate = one menu (hall + date + meal). Integer servings per item, capped at 3 (Fried Eggs 5 = 10 eggs).
- Meal targets = daily × 75%: daily 3600 kcal / 190 g P / 485 g C / 100 g F -> 2700 / 143 / 364 / 75.
- All targets are soft constraints, so a solve always returns a plate. Shortfalls are reported, never errors.
  Protein is a minimum (shortfall weight 50 per 1%). Calories/carbs/fat aim for target: inside ±10% costs 1 (cal) or 0.5 (C, F) per 1%,
  outside costs 20 (cal) or 8 (C, F) per 1%.
- `perServing: 2` cost per serving. Without it every menu hits targets exactly with 20+ servings, so the ranking is
  meaningless and solves time out. With it the whole week solves in ~1 s.
- Excluded: anything flagged, incomplete or unusable. Estimated items are allowed but come with a warning.
- Ranking score = fit penalty + perServing × servings (lower is better). `planWeek()` ranks open menus.

## Phase 4: website (`web/`, plain HTML/CSS/JS, no build step)
- Files: `index.html`, `styles.css`, `app.js` (hash routes `#/week`, `#/plate/<key>`, `#/swipes`, `#/settings`),
  `store.js` (settings, swipes, meal logs, week math), `solver-client.js` + `solver-worker.js` (solving in a Web Worker,
  with a fallback to the main thread), `manifest.webmanifest`, `icons/`. `optimizer-test.html` is the old Phase 3 test page.
- localStorage key `queens-macros:v1` = `{settings, swipes, meals}`. All access is in try/catch, and the app shows a banner if
  storage is unavailable. Export/Import a single JSON backup (`app: "queens-macros"`).
- Settings defaults: the targets above, 75% share, ±10% tolerances, cap 3, Fried Eggs 5, perServing 2, halls
  Leonard + Ban Righ on and Jean-Royce off, availability weekday lunch + dinner, 5 swipes/week, plan resets
  Sunday 11:59 pm (configurable, so the week runs Mon–Sun). Changes re-plan right away. Invalid input keeps the current value.
- This week: 7 day cards. Greyed rows are merged per day (one row per hall with no menu, one per unavailable meal or the whole day).
  Recommended (★) = within each swipe week, the best day-best menus for the swipes left (one per day, skipping days already logged).
- Plate view: stations in menu order. Tap an item for full nutrition. "Not available" re-plans (resets adjusted servings
  unless the meal is logged). +/- records what was actually eaten, with live totals. "Show the rest of the menu" lists the other items. "Log this meal" uses a swipe dated by the menu's date.
- Light/dark mode follows the phone. Tap targets ≥44 px.
- Past meal periods today are not hidden (hall hours unknown).
