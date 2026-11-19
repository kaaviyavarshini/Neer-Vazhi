#!/usr/bin/env python3
"""
scripts/fetch_dem.py
Fetches a DEM (COP30 or SRTMGL1_E) from OpenTopography Global DEM API:
- Reads bbox from config/area.json and OPENTOPO_KEY from .env
- Pads bbox by 0.005 degrees
- Supports --demtype (default COP30, also SRTMGL1_E)
- Saves to data/raw/dem_<demtype>.tif
- Prints width x height, min / max / mean height, and nodata count
- Clear error handling (401 means bad key, etc.)
"""

import argparse
import json
import os
import pathlib
import sys
from dotenv import load_dotenv
import requests
import numpy as np

try:
    import rasterio
    from rasterio.io import MemoryFile
except ImportError:
    rasterio = None

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "area.json"
DATA_RAW = ROOT / "data" / "raw"
DATA_RAW.mkdir(parents=True, exist_ok=True)

API_URL = "https://portal.opentopography.org/API/globaldem"

def load_config():
    load_dotenv(ROOT / ".env")
    key = os.getenv("OPENTOPO_KEY", "").strip()
    if not key:
        print("ERROR: OPENTOPO_KEY is missing from .env", file=sys.stderr)
        sys.exit(1)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    if "bbox" in cfg:
        b = cfg["bbox"]
        south, west, north, east = b["south"], b["west"], b["north"], b["east"]
    else:
        south, west, north, east = cfg["south"], cfg["west"], cfg["north"], cfg["east"]

    return key, south, west, north, east

def main():
    parser = argparse.ArgumentParser(description="Download Global DEM from OpenTopography")
    parser.add_argument("--demtype", default="COP30", choices=["COP30", "SRTMGL1_E", "SRTMGL1", "SRTMGL3"],
                        help="DEM product to fetch (default: COP30)")
    args = parser.parse_args()

    api_key, south, west, north, east = load_config()

    # Bbox padded by 0.005 degrees
    pad = 0.005
    p_south = round(south - pad, 4)
    p_west = round(west - pad, 4)
    p_north = round(north + pad, 4)
    p_east = round(east + pad, 4)

    out_file = DATA_RAW / f"dem_{args.demtype}.tif"

    print(f"Requesting DEM '{args.demtype}' from OpenTopography...")
    print(f"  Target BBox : south={south}, west={west}, north={north}, east={east}")
    print(f"  Padded BBox : south={p_south}, west={p_west}, north={p_north}, east={p_east} (pad = {pad}°)")

    params = {
        "demtype": args.demtype,
        "south": p_south,
        "north": p_north,
        "west": p_west,
        "east": p_east,
        "outputFormat": "GTiff",
        "API_Key": api_key,
    }

    try:
        resp = requests.get(API_URL, params=params, timeout=120)
        if resp.status_code == 401:
            print("ERROR: 401 Unauthorized - Invalid or inactive OPENTOPO_KEY.", file=sys.stderr)
            sys.exit(1)
        resp.raise_for_status()
    except requests.exceptions.HTTPError as e:
        print(f"HTTP Error {resp.status_code}: {resp.text}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.RequestException as e:
        print(f"Network Request Error: {e}", file=sys.stderr)
        sys.exit(1)

    raw_data = resp.content
    with open(out_file, "wb") as f:
        f.write(raw_data)
    print(f"Saved {len(raw_data):,} bytes -> {out_file}")

    # Inspect raster
    if rasterio is not None:
        with rasterio.open(out_file) as ds:
            width = ds.width
            height = ds.height
            nodata = ds.nodata
            arr = ds.read(1)

            if nodata is not None:
                nodata_count = int(np.sum(arr == nodata))
                valid_mask = arr != nodata
            else:
                nodata_count = int(np.sum(np.isnan(arr)))
                valid_mask = ~np.isnan(arr)

            valid_data = arr[valid_mask]
            if len(valid_data) > 0:
                min_h = float(np.min(valid_data))
                max_h = float(np.max(valid_data))
                mean_h = float(np.mean(valid_data))
            else:
                min_h = max_h = mean_h = float("nan")

        print("\n--- DEM Summary ---")
        print(f"  Product       : {args.demtype}")
        print(f"  Dimensions    : {width} × {height} (width × height)")
        print(f"  NoData Value  : {nodata}")
        print(f"  NoData Count  : {nodata_count}")
        print(f"  Min Height    : {min_h:.2f} m")
        print(f"  Max Height    : {max_h:.2f} m")
        print(f"  Mean Height   : {mean_h:.2f} m")
    else:
        print("rasterio not installed; skipping detailed raster stats.")

if __name__ == "__main__":
    main()
