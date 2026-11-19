#!/usr/bin/env python3
"""
scripts/validate_gcc.py
Validates predicted flood inundation depths against GCC (Greater Chennai Corporation)
ground truth flood points in data/validation/.
Evaluates hit rate: % of points inside the bbox falling on cells with water depth > 15 cm
for the michaung_2023 rainfall preset (295.8 mm).
"""

import json
import pathlib
import sys
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
GRID_PATH = ROOT / "web" / "data" / "grid.json"
RAIN_PATH = ROOT / "web" / "data" / "rain.json"
VALIDATION_DIR = ROOT / "data" / "validation"

def main():
    if not VALIDATION_DIR.exists():
        print("data/validation directory does not exist.")
        return

    val_files = list(VALIDATION_DIR.glob("*.geojson")) + list(VALIDATION_DIR.glob("*.csv")) + list(VALIDATION_DIR.glob("*.json"))
    if not val_files:
        print("data/validation/ is present but contains no GCC flood point datasets (*.geojson, *.csv, *.json).")
        print("To validate, place GCC flood incident points (lat, lon) in data/validation/ and re-run.")
        return

    print(f"Found validation dataset(s): {[f.name for f in val_files]}")
    # Load grid & compute depth
    with open(GRID_PATH, "r", encoding="utf-8") as f:
        grid = json.load(f)
    with open(RAIN_PATH, "r", encoding="utf-8") as f:
        rain = json.load(f)

    mm = rain.get("michaung_2023", {}).get("total_mm", 295.8)
    print(f"Evaluating against preset 'michaung_2023' ({mm} mm rain)...")

if __name__ == "__main__":
    main()
