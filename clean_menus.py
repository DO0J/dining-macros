"""
Phase 2: turn the raw menu files into one clean, consistent list of food items.

Run it from the project folder:
    .venv\\Scripts\\python clean_menus.py

Reads   data/raw/<date>/<hall>_<meal>__<timestamp>.json  (newest version of each menu;
        opened read-only, never changed)
Writes  data/clean/items.json   one record per food item (what later phases use)
        data/clean/items.csv    the same records, flattened for Excel
        data/clean/menus.json   one line per (date, hall, meal): open / closed / no_menu
        data/clean/flags.txt    every flagged or estimated item and why, for review

Everything in data/clean/ is rebuilt from scratch each run, so it's safe to delete.
"""

import csv
import json
import re
from datetime import datetime
from pathlib import Path

from raw_archive import all_latest

PROJECT_DIR = Path(__file__).parent
CLEAN_DIR = PROJECT_DIR / "data" / "clean"
SITE_DATA_FILE = PROJECT_DIR / "web" / "data" / "menus.json"   # what the website loads

MEAL_ORDER = ["Breakfast", "Lunch", "Dinner"]
REMOVED_WARNING = "removed from website, may be cancelled"

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

# Raw field name -> (our field name, unit). This order is also the CSV column order.
# CaloriesFromFat is deliberately left out: it's often null and not trustworthy.
NUTRIENTS = {
    "Calories":           ("calories",       "kcal"),
    "Protein":            ("protein_g",      "g"),
    "TotalCarbohydrates": ("carbs_g",        "g"),
    "TotalFat":           ("fat_g",          "g"),
    "SaturatedFat":       ("sat_fat_g",      "g"),
    "TransFat":           ("trans_fat_g",    "g"),
    "DietaryFiber":       ("fiber_g",        "g"),
    "Sugars":             ("sugars_g",       "g"),
    "AddedSugars":        ("added_sugars_g", "g"),
    "Cholesterol":        ("cholesterol_mg", "mg"),
    "Sodium":             ("sodium_mg",      "mg"),
}

# If any of these is missing the item is marked "incomplete".
# added_sugars_g is not in the list: it's null for ~95% of items, so requiring
# it would mark nearly everything incomplete and make the flag useless.
REQUIRED_NUTRIENTS = [
    "calories", "protein_g", "carbs_g", "fat_g", "sat_fat_g", "trans_fat_g",
    "fiber_g", "sugars_g", "cholesterol_mg", "sodium_mg",
]

# Bulk recipes
BULK_SUBCATEGORY = "Made-to-Order/Bulk Recipe"
BATCH_MIN_SIZE = 1000     # a bulk entry this big (g or mL) is a whole batch, not a portion
SOUP_PORTION_ML = 250
SALAD_PORTION_G = 150

# Outlier checks (explained in check_outliers below)
CAL_TOLERANCE_KCAL = 25          # check 1: allowed difference is the larger of these two
CAL_TOLERANCE_FRACTION = 0.20
FAT_DENSE_PER_100 = 30           # check 2: at least this many g of fat per 100 g...
PROTEIN_POOR_PER_100 = 10        # ...with less than this much protein per 100 g


# ---------------------------------------------------------------------------
# Parsing small pieces of text
# ---------------------------------------------------------------------------

# Matches "3.5 g", "410 mg", "35", "less than 1 g".
#   group 1 = "less than " (or None), group 2 = the number, group 3 = the unit (or None)
AMOUNT_PATTERN = re.compile(r"^(less than\s+)?(\d+(?:\.\d+)?)\s*(g|mg)?$")

# Matches "118 millilitre", "118 1/10 millilitre", "1 kilogram", "2 each".
#   group 1 = whole number, groups 2/3 = optional fraction, group 4 = unit word
SERVING_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)(?:\s+(\d+)/(\d+))?\s+([a-z]+)$")
SERVING_UNITS = {"gram": "g", "kilogram": "kg", "millilitre": "mL", "each": "each", "slice": "slice"}

ALLERGEN_FLAGS = {
    "ContainsEggs": "Eggs", "ContainsFish": "Fish", "ContainsMilk": "Milk",
    "ContainsPeanuts": "Peanuts", "ContainsSesame": "Sesame", "ContainsShellfish": "Shellfish",
    "ContainsSoy": "Soy", "ContainsTreeNuts": "Tree Nuts", "ContainsWheat": "Wheat",
}


def fmt(x):
    """Format a number without pointless decimals: 3.0 -> '3', 4.71875 -> '4.7', 0.031 -> '0.031'."""
    if x == 0 or abs(x) >= 1:
        return f"{round(x, 1):g}"
    return f"{x:.2g}"


def parse_nutrient(raw_value, unit, scale=1.0):
    """
    Turn one raw nutrient string into {"value": number or None, "display": text}.
        "3.5 g"         -> {"value": 3.5,  "display": "3.5 g"}
        "less than 1 g" -> {"value": 0.5,  "display": "<1 g"}    (half of the bound)
        None            -> {"value": None, "display": "unknown"} (never zero!)
    `scale` multiplies the number, used when rescaling a bulk batch to one portion.
    """
    if raw_value is None or str(raw_value).strip() == "":
        return {"value": None, "display": "unknown"}

    match = AMOUNT_PATTERN.match(str(raw_value).strip())
    expected_unit = None if unit == "kcal" else unit       # calories come with no unit
    if not match or match.group(3) != expected_unit:
        return {"value": None, "display": f"unreadable ({raw_value})"}

    less_than, number, _ = match.groups()
    number = float(number) * scale
    shown = str(round(number)) if unit == "kcal" else fmt(number)   # whole calories only
    if less_than:
        return {"value": round(number / 2, 3), "display": f"<{shown} {unit}"}
    return {"value": round(number, 3), "display": f"{shown} {unit}"}


def parse_serving(text):
    """'118 1/10 millilitre' -> (118.1, 'mL'), '1 kilogram' -> (1000.0, 'g'). Unknown -> (None, None)."""
    match = SERVING_PATTERN.match((text or "").strip())
    if not match or match.group(4) not in SERVING_UNITS:
        return None, None
    qty = float(match.group(1))
    if match.group(2):
        qty += int(match.group(2)) / int(match.group(3))
    unit = SERVING_UNITS[match.group(4)]
    if unit == "kg":
        qty, unit = qty * 1000, "g"
    return qty, unit


def recipe_code(item):
    """
    ProductId looks like 272162_123503_M3047_4_486779. The middle chunk is the recipe;
    the last chunk is the specific serving size of that recipe.
    If an ID ever has a different shape, use the whole ID so it can't be wrongly merged.
    """
    product_id = item.get("ProductId") or ""
    parts = product_id.split("_")
    return parts[2] if len(parts) == 5 else product_id


def parse_allergens(item):
    """List of allergens, or None when the university says the info isn't available."""
    text = item.get("Allergens") or ""
    if not text.startswith("Contains:"):
        return None                       # unknown, NOT "no allergens"
    return [name for flag, name in ALLERGEN_FLAGS.items() if item.get(flag)]


def parse_tags(item):
    """'3CGlutenFree;40CEatWell' -> ['GlutenFree', 'EatWell'] (drops the numeric code prefix)."""
    tags = (item.get("DietaryInformation") or "").split(";")
    return [re.sub(r"^\d+C", "", t) for t in tags if t]


# ---------------------------------------------------------------------------
# Building clean records
# ---------------------------------------------------------------------------

def build_record(entry, context, scale=1.0):
    """Turn one raw item (plus where it was found) into a clean record."""
    item = entry["item"]
    qty, unit = parse_serving(item.get("Serving"))
    code = recipe_code(item)
    allergens = parse_allergens(item)

    record = {
        "id": f'{context["date"]}|{context["hall"]}|{context["meal"]}|{code}',
        "date": context["date"],
        "hall": context["hall"],
        "meal": context["meal"],
        "station": entry["station"],
        "other_stations": [],
        "subcategory": entry["subcategory"],
        "name": (item.get("ProductName") or "").strip(),
        "product_id": item.get("ProductId"),
        "recipe_code": code,
        "serving": item.get("Serving"),
        "serving_qty": qty,
        "serving_unit": unit,
        "other_sizes": [],
        "nutrients": {
            our_name: parse_nutrient(item.get(raw_name), nutrient_unit, scale)
            for raw_name, (our_name, nutrient_unit) in NUTRIENTS.items()
        },
        "vegan": bool(item.get("IsVegan")),
        "vegetarian": bool(item.get("IsVegetarian")),
        "gluten_free": bool(item.get("IsGlutenFree")),
        "halal": bool(item.get("IsHalal")),
        "kosher": bool(item.get("IsKosher")),
        "tags": parse_tags(item),
        "allergens": allergens,
        "allergens_known": allergens is not None,
        "ingredients": item.get("Ingredients"),
        # Raw university field, kept as-is. It does NOT mean "add-on": soups, salads and
        # eggs have it too. Serving caps are set by category in the optimizer instead.
        "is_deemphasized": bool(item.get("IsDeemphasized")),
        "estimated": False,
        "estimate_note": None,
        "usable": True,
        "notes": [],
        "flags": [],
    }

    missing = [n for n in REQUIRED_NUTRIENTS if record["nutrients"][n]["value"] is None]
    record["incomplete"] = bool(missing)
    if missing:
        record["flags"].append({"check": "incomplete", "reason": "missing or unreadable: " + ", ".join(missing)})
    return record


def is_batch(entry):
    """A bulk-recipe entry big enough to be a whole batch (e.g. 8000 mL of soup)."""
    qty, unit = parse_serving(entry["item"].get("Serving"))
    return (entry["subcategory"] == BULK_SUBCATEGORY
            and unit in ("g", "mL")
            and qty >= BATCH_MIN_SIZE)


def portion_size(entry):
    """How big one portion of this batch should be: (qty, unit), or None if we don't know."""
    _, unit = parse_serving(entry["item"].get("Serving"))
    station = (entry["station"] or "").lower()
    if unit == "mL" and "soup" in station:
        return SOUP_PORTION_ML, "mL"
    if unit == "g" and station == "salad bar":
        return SALAD_PORTION_G, "g"
    return None


def calories_of(entry):
    """Sort key: listed calories, with unknown calories sorted last."""
    value = parse_nutrient(entry["item"].get("Calories"), "kcal")["value"]
    return value if value is not None else float("inf")


def clean_group(group, context):
    """
    Turn all entries of one recipe in one menu into a single record.
    Cases:
      - normal items: keep the smallest serving, note other sizes and stations
      - bulk batch + portion-sized twin: use the portion, drop the batch
      - bulk batch alone: rescale it to a standard portion, or flag it if unsure
    """
    batches = [e for e in group if is_batch(e)]
    portions = sorted((e for e in group if not is_batch(e)), key=calories_of)

    if portions:
        base = portions[0]
        record = build_record(base, context)
        record["other_stations"] = sorted({e["station"] for e in portions} - {base["station"]})
        seen_servings = {base["item"].get("Serving")}
        for e in portions[1:]:
            serving = e["item"].get("Serving")
            if serving not in seen_servings:
                seen_servings.add(serving)
                record["other_sizes"].append({"serving": serving, "calories": calories_of(e)})
        if batches:
            record["notes"].append("bulk batch entry dropped; portion-sized entry used instead")
        record["flags"] += check_outliers(record)
        return record

    # Only whole-batch entries exist for this recipe.
    base = batches[0]
    batch_qty, batch_unit = parse_serving(base["item"].get("Serving"))
    target = portion_size(base)

    if target is None:
        record = build_record(base, context)
        record["usable"] = False
        record["flags"].append({
            "check": "bulk_unhandled",
            "reason": f"whole-batch recipe ({base['item'].get('Serving')}) that isn't a soup "
                      f"or salad-bar item, so no portion size is known; excluded from planning",
        })
        return record

    target_qty, target_unit = target
    record = build_record(base, context, scale=target_qty / batch_qty)
    record["serving"] = f"{target_qty} {target_unit}"
    record["serving_qty"], record["serving_unit"] = float(target_qty), target_unit
    record["estimated"] = True
    record["estimate_note"] = (f"rescaled from a {base['item'].get('Serving')} batch "
                               f"to {target_qty} {target_unit}; numbers are estimates")
    record["flags"] += check_outliers(record)
    return record


# ---------------------------------------------------------------------------
# Outlier checks (flag, never hide)
# ---------------------------------------------------------------------------

def check_outliers(record):
    """
    Check 1, calorie_mismatch: listed calories vs. 4*protein + 4*carbs + 9*fat.
        Labels round calories to 10 kcal and fat to 0.5 g, and fiber counts as carbs
        but gives only ~2 kcal/g, so small mismatches are normal. Flag only if the
        difference exceeds the larger of 25 kcal or 20% of the listed calories.
    Check 2, fat_density: at least 30 g fat per 100 g with under 10 g protein per 100 g.
        Real foods that fatty are either fatty meat/cheese (lots of protein: bacon,
        sausage, cheddar pass) or pure-fat foods (oil, butter, dressing, chips). A
        cooked main or side in the second group is suspicious, e.g. fries listed at 37 g/100 g.
    Check 3, impossible_weight: protein + carbs + fat weigh more than the serving itself.
    """
    flags = []
    n = {name: data["value"] for name, data in record["nutrients"].items()}
    cal, protein, carbs, fat = n["calories"], n["protein_g"], n["carbs_g"], n["fat_g"]
    qty, unit = record["serving_qty"], record["serving_unit"]

    if None not in (cal, protein, carbs, fat):
        from_macros = 4 * protein + 4 * carbs + 9 * fat
        allowed = max(CAL_TOLERANCE_KCAL, CAL_TOLERANCE_FRACTION * cal)
        if abs(cal - from_macros) > allowed:
            flags.append({"check": "calorie_mismatch",
                          "reason": f"listed {cal:.0f} kcal but macros add up to {from_macros:.0f} kcal "
                                    f"(allowed difference {allowed:.0f})"})

    if unit in ("g", "mL") and qty and None not in (protein, fat):
        fat_per_100 = fat / qty * 100
        protein_per_100 = protein / qty * 100
        if fat_per_100 >= FAT_DENSE_PER_100 and protein_per_100 < PROTEIN_POOR_PER_100:
            flags.append({"check": "fat_density",
                          "reason": f"{fat_per_100:.0f} g fat per 100 {unit} with only "
                                    f"{protein_per_100:.0f} g protein; only oils, butter, dressings "
                                    f"or chips are normally that fatty with so little protein"})

    if unit == "g" and qty and None not in (protein, carbs, fat) and protein + carbs + fat > qty:
        flags.append({"check": "impossible_weight",
                      "reason": f"protein + carbs + fat = {protein + carbs + fat:.0f} g, "
                                f"more than the {qty:g} g serving"})
    return flags


# ---------------------------------------------------------------------------
# One menu file, then the whole folder
# ---------------------------------------------------------------------------

def clean_menu(raw_menu, context):
    """Return (status, records) for one raw menu file."""
    if raw_menu.get("error"):
        return "error", []
    periods = raw_menu.get("MealPeriods") or []
    if not periods:
        return "no_menu", []              # nothing posted at all
    stations = periods[0].get("Stations") or []
    if not stations:
        return "closed", []               # a meal period with no stations = hall closed

    # Flatten Stations -> SubCategories -> Items into a simple list.
    entries = []
    for station in stations:
        for sub in station.get("SubCategories") or []:
            for item in sub.get("Items") or []:
                entries.append({"station": station.get("Name"), "subcategory": sub.get("Name"), "item": item})

    # Group entries that are the same recipe (dicts keep insertion order, so menu order survives).
    groups = {}
    for entry in entries:
        groups.setdefault(recipe_code(entry["item"]), []).append(entry)

    # Station position on the menu (the feed's Sort value, then list order), so the
    # website can show stations in the same order as the hall's own menu.
    ranked = sorted(enumerate(stations), key=lambda pair: (pair[1].get("Sort") or 0, pair[0]))
    station_rank = {}
    for rank, (_, station) in enumerate(ranked):
        station_rank.setdefault(station.get("Name"), rank)

    records = [clean_group(group, context) for group in groups.values()]
    for record in records:
        record["station_sort"] = station_rank.get(record["station"], len(station_rank))
    return "open", records


def load_json(path):
    """Read one archived file (read-only: the raw archive is never changed)."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def menus_in_order():
    """Newest version of every archived menu, sorted by date, hall, then Breakfast/Lunch/Dinner."""
    def sort_key(menu):
        meal_rank = MEAL_ORDER.index(menu["meal"]) if menu["meal"] in MEAL_ORDER else 99
        return (menu["date"], menu["hall"], meal_rank)
    return sorted(all_latest(), key=sort_key)


def flat_row(record):
    """One record as a flat dict for the CSV file."""
    row = {k: record[k] for k in ("id", "date", "hall", "meal", "station", "subcategory", "name",
                                  "recipe_code", "product_id", "serving", "serving_qty", "serving_unit")}
    for name, data in record["nutrients"].items():
        row[name] = data["value"]
    row["other_stations"] = "; ".join(record["other_stations"])
    row["other_sizes"] = "; ".join(s["serving"] for s in record["other_sizes"])
    row["vegan"], row["vegetarian"] = record["vegan"], record["vegetarian"]
    row["allergens"] = "unknown" if record["allergens"] is None else ", ".join(record["allergens"])
    for key in ("is_deemphasized", "estimated", "incomplete", "usable"):
        row[key] = record[key]
    row["flags"] = "; ".join(f["check"] for f in record["flags"])
    return row


def write_flag_report(records, path):
    """A readable list of every flagged or estimated item, each recipe listed once."""
    unique = {}
    for r in records:
        if r["flags"] or r["estimated"]:
            unique.setdefault((r["product_id"], r["serving"]), []).append(r)

    lines = []
    for title, wanted in (("FLAGGED", lambda r: r["flags"]), ("ESTIMATED (rescaled bulk)", lambda r: r["estimated"])):
        group = [rs for rs in unique.values() if wanted(rs[0])]
        lines.append(f"===== {title}: {len(group)} distinct items =====")
        for rs in sorted(group, key=lambda rs: rs[0]["name"]):
            r, n = rs[0], rs[0]["nutrients"]
            lines.append(f'{r["name"]}  [{r["serving"]}]  at {r["station"]}, {r["hall"]}; on {len(rs)} menu(s)')
            lines.append("    " + ", ".join(n[k]["display"] for k in ("calories", "protein_g", "carbs_g", "fat_g")))
            for f in r["flags"]:
                lines.append(f'    {f["check"]}: {f["reason"]}')
            if r["estimate_note"]:
                lines.append(f'    note: {r["estimate_note"]}')
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return "\n".join(lines)


def write_site_data(menus, records):
    """
    The one data file the website loads: web/data/menus.json. Compact (no indentation)
    because phones download it. Everything in web/ gets published, so only menu data goes here.
    """
    SITE_DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    site_data = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "menus": menus,
        "items": records,
    }
    with open(SITE_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(site_data, f, ensure_ascii=False, separators=(",", ":"))


def main():
    CLEAN_DIR.mkdir(parents=True, exist_ok=True)
    all_records, menus = [], []

    for menu in menus_in_order():
        context = {"date": menu["date"], "hall": menu["hall"], "meal": menu["meal"]}
        source = menu["path"]
        status, records = clean_menu(load_json(source), context)
        removed = False

        # A menu that was posted and later vanished from the website: keep using the
        # most recent real version, but warn that the meal may have been cancelled.
        if status == "no_menu":
            for older in reversed(menu["history"][:-1]):
                older_status, older_records = clean_menu(load_json(older), context)
                if older_status == "open":
                    status, records, source, removed = older_status, older_records, older, True
                    break

        menus.append({**context, "status": status, "items": len(records),
                      "source_file": source.name, "versions": menu["versions"],
                      "removed_from_website": removed,
                      "warning": REMOVED_WARNING if removed else None})
        all_records += records

    with open(CLEAN_DIR / "items.json", "w", encoding="utf-8") as f:
        json.dump(all_records, f, indent=2, ensure_ascii=False)
    with open(CLEAN_DIR / "menus.json", "w", encoding="utf-8") as f:
        json.dump(menus, f, indent=2)
    # "utf-8-sig" adds a marker that makes Excel read accented characters correctly.
    with open(CLEAN_DIR / "items.csv", "w", encoding="utf-8-sig", newline="") as f:
        rows = [flat_row(r) for r in all_records]
        writer = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ["id"])
        writer.writeheader()
        writer.writerows(rows)
    report = write_flag_report(all_records, CLEAN_DIR / "flags.txt")
    write_site_data(menus, all_records)

    # Summary
    statuses = {}
    for m in menus:
        statuses[m["status"]] = statuses.get(m["status"], 0) + 1
    print(f"Menus: {len(menus)} files -> " + ", ".join(f"{v} {k}" for k, v in statuses.items()))
    print(f"Items: {len(all_records)} records, "
          f"{sum(r['estimated'] for r in all_records)} rescaled, "
          f"{sum(bool(r['flags']) for r in all_records)} flagged, "
          f"{sum(r['incomplete'] for r in all_records)} incomplete")
    for m in menus:
        if m["removed_from_website"]:
            print(f'WARNING: {m["date"]} {m["hall"]} {m["meal"]}: {REMOVED_WARNING} (using {m["source_file"]})')
    print(f"Saved to {CLEAN_DIR}\n")
    print(report)


if __name__ == "__main__":
    main()
