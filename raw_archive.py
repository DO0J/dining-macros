"""
Shared helpers for the raw-menu archive in data/raw/. Used by fetch_menus.py
(to save) and clean_menus.py (to find the newest version of each menu).

Layout:
    data/raw/2026-10-14/leonard_lunch.json                    saved before versioning existed
    data/raw/2026-10-14/leonard_lunch__20261012-083000.json   one file per version that differed

Rules:
  - A file is written once and never changed, renamed or deleted afterwards.
  - A new version is saved only when the menu differs from the newest saved version.
  - The timestamp in the name (YYYYMMDD-HHMMSS) is when it was fetched, so the
    names sort oldest -> newest. An unversioned file sorts first (it's the oldest).
"""

import json
from datetime import datetime
from pathlib import Path

RAW_DIR = Path(__file__).parent / "data" / "raw"
VERSION_SEPARATOR = "__"
TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S"     # no ":" because Windows forbids it in file names


def split_name(path):
    """
    'leonard_lunch__20261012-083000.json' -> ('leonard', 'Lunch', '20261012-083000')
    'leonard_lunch.json'                  -> ('leonard', 'Lunch', '')
    """
    base, _, timestamp = path.stem.partition(VERSION_SEPARATOR)
    hall, meal = base.rsplit("_", 1)        # split at the LAST "_", since "ban_righ" contains one
    return hall, meal.capitalize(), timestamp


def versions(day_dir, hall, meal):
    """All saved versions of one menu, oldest first."""
    found = [p for p in day_dir.glob(f"{hall}_{meal.lower()}*.json")
             if split_name(p)[:2] == (hall, meal)]
    return sorted(found, key=lambda p: split_name(p)[2])


def latest_version(day_dir, hall, meal):
    """Path of the newest saved version, or None if this menu was never saved."""
    found = versions(day_dir, hall, meal)
    return found[-1] if found else None


def write_once(data, path):
    """
    Write JSON to a brand-new file, refusing to overwrite anything.
    It writes to a .tmp file first and renames it at the end, so a crash halfway
    through can't leave a half-written .json file in the archive.
    """
    if path.exists():
        raise FileExistsError(f"refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.rename(path)


def save_if_changed(data, day_dir, hall, meal):
    """
    Save `data` as a new version unless it equals the newest saved version.
    Returns (status, path, version_count) with status 'new', 'changed' or 'unchanged'.
    """
    latest = latest_version(day_dir, hall, meal)
    if latest is not None:
        with open(latest, encoding="utf-8") as f:
            # Compare the parsed data, not the file text, so formatting can't
            # count as a change. == on dicts/lists compares everything inside.
            if json.load(f) == data:
                return "unchanged", latest, len(versions(day_dir, hall, meal))

    timestamp = datetime.now().strftime(TIMESTAMP_FORMAT)
    path = day_dir / f"{hall}_{meal.lower()}{VERSION_SEPARATOR}{timestamp}.json"
    write_once(data, path)
    status = "changed" if latest is not None else "new"
    return status, path, len(versions(day_dir, hall, meal))


def all_latest(raw_dir=RAW_DIR):
    """
    The newest version of every menu in the archive, as a list of dicts:
        {"date": "2026-10-14", "hall": "leonard", "meal": "Lunch", "path": ..., "versions": 2,
         "history": [oldest path, ..., newest path]}
    """
    menus = {(p.parent.name, *split_name(p)[:2]) for p in raw_dir.glob("*/*.json")}
    result = []
    for date, hall, meal in menus:
        day_dir = raw_dir / date
        history = versions(day_dir, hall, meal)
        result.append({"date": date, "hall": hall, "meal": meal, "path": history[-1],
                       "versions": len(history), "history": history})
    return result
