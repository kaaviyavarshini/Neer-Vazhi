#!/usr/bin/env python3
"""
scripts/fetch_rain.py
Fetches historical precipitation from Open-Meteo archive API for the centre of the study bbox
and defines synthetic reference presets:
  1. michaung_2023: 2023-12-02 to 2023-12-06
  2. nov_dec_2015: 2015-11-30 to 2015-12-03
  3. heavy_day: 200 mm in 24 h with a triangular peak at hour 10
  4. gauge_440: 440 mm in 36 h (Perungudi rain-gauge total reported for Cyclone Michaung)

Outputs:
  web/data/rain.json: { preset: { label, times[], mm[], total_mm } }

Note on meteorological reanalysis:
  Open-Meteo archive data uses ERA5 / ERA5-Land reanalysis models on a ~9-30 km grid.
  Reanalysis precipitation represents spatial grid-cell averages and frequently underestimates
  intense, localized convective bursts recorded by localized surface rain gauges.
"""

import json
import pathlib
import sys
import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "area.json"
OUT_JSON = ROOT / "web" / "data" / "rain.json"
OUT_JSON.parent.mkdir(parents=True, exist_ok=True)

OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

def load_bbox_centre():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "bbox" in cfg:
        b = cfg["bbox"]
        south, west, north, east = b["south"], b["west"], b["north"], b["east"]
    else:
        south, west, north, east = cfg["south"], cfg["west"], cfg["north"], cfg["east"]
    centre_lat = (south + north) / 2.0
    centre_lon = (west + east) / 2.0
    return centre_lat, centre_lon

def fetch_open_meteo(lat: float, lon: float, start_date: str, end_date: str):
    params = {
        "latitude": round(lat, 4),
        "longitude": round(lon, 4),
        "start_date": start_date,
        "end_date": end_date,
        "hourly": "precipitation",
        "timezone": "Asia/Kolkata",
    }
    resp = requests.get(OPEN_METEO_ARCHIVE_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    raw_precip = hourly.get("precipitation", [])
    mm = [round(float(p or 0.0), 2) for p in raw_precip]
    return times, mm

def generate_triangular_series(hours: int, total_volume: float, peak_hour: int):
    # Triangular hyetograph peaking at peak_hour (0-indexed or 1-indexed)
    # Weights rise linearly from 0 to peak_hour, then fall to hours
    weights = []
    for h in range(hours):
        if h <= peak_hour:
            w = (h + 1) / (peak_hour + 1)
        else:
            w = (hours - h) / (hours - peak_hour)
        weights.append(max(w, 0.0))
    sum_w = sum(weights)
    mm = [round((w / sum_w) * total_volume, 2) for w in weights]
    # Adjust small rounding delta on peak hour
    diff = round(total_volume - sum(mm), 2)
    mm[peak_hour] = round(mm[peak_hour] + diff, 2)
    times = [f"T+{h:02d}:00" for h in range(hours)]
    return times, mm

def main():
    lat, lon = load_bbox_centre()
    print(f"Study area centre: lat={lat:.4f}, lon={lon:.4f}")

    presets_config = {
        "michaung_2023": {
            "label": "Cyclone Michaung (Dec 2023) - Open-Meteo Reanalysis",
            "start": "2023-12-02",
            "end": "2023-12-06",
        },
        "nov_dec_2015": {
            "label": "Chennai Floods (Nov-Dec 2015) - Open-Meteo Reanalysis",
            "start": "2015-11-30",
            "end": "2015-12-03",
        },
    }

    result = {}

    # 1. Fetch real reanalysis events
    for key, info in presets_config.items():
        print(f"Fetching {key} ({info['start']} to {info['end']}) ...")
        times, mm = fetch_open_meteo(lat, lon, info["start"], info["end"])
        tot = round(sum(mm), 2)
        result[key] = {
            "label": info["label"],
            "times": times,
            "mm": mm,
            "total_mm": tot,
        }

    # 2. Synthetic preset: heavy_day (200 mm in 24 h with peak at hour 10)
    print("Generating synthetic preset: heavy_day (200 mm in 24 h, peak at hour 10) ...")
    hd_times, hd_mm = generate_triangular_series(hours=24, total_volume=200.0, peak_hour=10)
    result["heavy_day"] = {
        "label": "Synthetic Heavy Day (200 mm / 24 h, peak at h=10)",
        "times": hd_times,
        "mm": hd_mm,
        "total_mm": round(sum(hd_mm), 2),
    }

    # 3. Synthetic preset: gauge_440 (440 mm in 36 h, Perungudi reported total for Cyclone Michaung)
    print("Generating synthetic preset: gauge_440 (440 mm in 36 h, Perungudi gauge reference) ...")
    # Peak at hour 18 (mid-storm surge)
    g440_times, g440_mm = generate_triangular_series(hours=36, total_volume=440.0, peak_hour=18)
    result["gauge_440"] = {
        "label": "Cyclone Michaung Perungudi Gauge Reference (440 mm / 36 h)",
        "times": g440_times,
        "mm": g440_mm,
        "total_mm": round(sum(g440_mm), 2),
    }

    # Save to web/data/rain.json
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    print(f"\nSaved {len(result)} presets -> {OUT_JSON}")

    # Summary table
    print("\n" + "=" * 80)
    print(f"{'Preset':<16} | {'Total (mm)':<10} | {'Peak (mm/h)':<11} | {'Peak Hour / Time':<25}")
    print("-" * 80)

    for preset_key, data in result.items():
        total_mm = data["total_mm"]
        mm_list = data["mm"]
        times_list = data["times"]
        max_val = max(mm_list) if mm_list else 0.0
        max_idx = mm_list.index(max_val) if mm_list else 0
        peak_time = times_list[max_idx] if times_list else "-"
        print(f"{preset_key:<16} | {total_mm:<10.1f} | {max_val:<11.2f} | {peak_time:<25}")

    print("=" * 80)
    print("NOTE: Reanalysis rainfall (ERA5/Open-Meteo) represents regional spatial averages (~9-30 km grid)")
    print("and is typically significantly lower than localized point-gauge surface recordings (e.g. 440 mm")
    print("measured at the Perungudi automatic weather station during Cyclone Michaung).")
    print("=" * 80 + "\n")

if __name__ == "__main__":
    main()
