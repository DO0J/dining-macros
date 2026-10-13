"""
Phase 1: download the dining-hall menus and archive them, unchanged.

Run it from the project folder:
    .venv\\Scripts\\python fetch_menus.py

Each menu is saved under data/raw/<date>/, with a timestamp of when it was fetched:
    data/raw/2026-10-14/leonard_lunch__20261012-083000.json

A new copy is saved only when the menu differs from the newest copy already saved,
so re-running the script is cheap and earlier versions are never overwritten.
(See raw_archive.py for the details.)

The files are saved exactly as the university sends them. Cleaning happens in
clean_menus.py, so a cleaner bug can be fixed and re-run without downloading again.
"""

import time
from datetime import date, timedelta

import requests

from raw_archive import RAW_DIR, save_if_changed

# ---------------------------------------------------------------------------
# Settings: the values you're most likely to change
# ---------------------------------------------------------------------------

FEED_URL = "https://www.queensu.ca/food/dining/todays-menu/feed"

# Name used in filenames -> the university's locationId
HALLS = {
    "ban_righ": "14628",
    "leonard": "14627",
    "jean_royce": "14629",
}

MEAL_PERIODS = ["Breakfast", "Lunch", "Dinner"]

DAYS_AHEAD = 7            # menus are posted about a week ahead
PAUSE_SECONDS = 0.5       # wait between requests so we don't hammer their server
TIMEOUT_SECONDS = 20      # give up on a request that hangs this long


# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

def fetch_menu(location_id, meal_period, day):
    """Download one menu and return it as a Python dict (parsed JSON)."""
    params = {
        "locationId": location_id,
        "mealPeriod": meal_period,
        "selDate": day.strftime("%m-%d-%Y"),   # the feed wants MM-DD-YYYY
    }
    # Try twice: a single network hiccup shouldn't kill the whole run.
    for attempt in (1, 2):
        try:
            response = requests.get(FEED_URL, params=params, timeout=TIMEOUT_SECONDS)
            response.raise_for_status()        # turns HTTP errors (404, 500...) into exceptions
            return response.json()
        except (requests.RequestException, ValueError) as error:
            if attempt == 2:
                raise
            print(f"    retrying after error: {error}")
            time.sleep(2)


def describe(menu):
    """Return a short human-readable summary of one downloaded menu."""
    if not menu.get("MealPeriods"):
        return "no menu posted"
    stations = menu["MealPeriods"][0].get("Stations") or []
    if not stations:
        return "closed (no stations)"
    item_count = sum(
        len(sub.get("Items") or [])
        for station in stations
        for sub in station.get("SubCategories") or []
    )
    return f"{len(stations)} stations, {item_count} items"


def main():
    today = date.today()
    days = [today + timedelta(days=i) for i in range(DAYS_AHEAD)]
    counts = {"new": 0, "changed": 0, "unchanged": 0, "failed": 0}

    for day in days:
        print(day.strftime("%a %Y-%m-%d"))
        for hall_name, location_id in HALLS.items():
            for meal in MEAL_PERIODS:
                label = f"  {hall_name:<9} {meal:<9}"
                try:
                    menu = fetch_menu(location_id, meal, day)
                    # An error reply isn't a menu: don't archive it, or it would
                    # become the "newest version" and hide the real menu.
                    if menu.get("error"):
                        raise ValueError(f"server said: {menu['error']}")
                    status, path, version_count = save_if_changed(
                        menu, RAW_DIR / day.isoformat(), hall_name, meal)
                except Exception as error:
                    print(f"{label} FAILED: {error}")
                    counts["failed"] += 1
                    continue

                counts[status] += 1
                note = {"new": "saved", "changed": f"CHANGED, saved version {version_count}",
                        "unchanged": "unchanged"}[status]
                print(f"{label} {describe(menu):<26} {note}")
                time.sleep(PAUSE_SECONDS)

    print(f"\nDone: {counts['new']} new, {counts['changed']} changed, "
          f"{counts['unchanged']} unchanged, {counts['failed']} failed. Archive: {RAW_DIR}")


# This block only runs when you execute the file directly
# (not when another script does "import fetch_menus").
if __name__ == "__main__":
    main()
