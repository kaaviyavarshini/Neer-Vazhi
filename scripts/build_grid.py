#!/usr/bin/env python3
"""
scripts/build_grid.py
1. Loads data/raw/dem_COP30.tif (or via --dem flag). Resamples to regular lon/lat grid
   over bbox with cellSizeM cells (calculating degrees per metre at this latitude).
   Fills nodata with nearest valid value.
2. Applies a 3x3 median filter for surface smoothing (rooftops/trees removal):
   stored as "heights"; unfiltered stored as "heightsRaw".
3. Writes web/data/grid.json: { west, south, east, north, cols, rows, cellSizeM, rowOrder: "north-to-south",
   heights[], heightsRaw[], min, max, datum }. Rounded to 0.01 m.
4. Clips roads to bbox and writes web/data/roads.json: [{ id, name, highway, coords: [[lon,lat], ...] }],
   densified so no segment is longer than one cell.
5. Writes web/data/labels.json as [{ name, lon, lat }] and web/data/marsh.json with wetland outline.
Prints grid size, height range, and file sizes. Keeps grid.json under 2 MB.
"""

import argparse
import json
import math
import os
import pathlib
import sys
import numpy as np
from scipy.ndimage import median_filter, distance_transform_edt
import rasterio

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "area.json"
DATA_RAW = ROOT / "data" / "raw"
DATA_WEB = ROOT / "web" / "data"
DATA_WEB.mkdir(parents=True, exist_ok=True)

GRID_JSON = DATA_WEB / "grid.json"
ROADS_JSON = DATA_WEB / "roads.json"
LABELS_JSON = DATA_WEB / "labels.json"
MARSH_JSON = DATA_WEB / "marsh.json"

RAW_ROADS_GEOJSON = DATA_RAW / "roads.geojson"
RAW_LABELS_GEOJSON = DATA_RAW / "labels.geojson"

def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "bbox" in cfg:
        b = cfg["bbox"]
        south, west, north, east = b["south"], b["west"], b["north"], b["east"]
    else:
        south, west, north, east = cfg["south"], cfg["west"], cfg["north"], cfg["east"]
    cell_size_m = cfg.get("cellSizeM", 30)
    return south, west, north, east, cell_size_m

def deg_per_metre(lat_deg):
    lat_rad = math.radians(lat_deg)
    m_per_deg_lat = 111132.954 - 559.822 * math.cos(2 * lat_rad) + 1.175 * math.cos(4 * lat_rad)
    m_per_deg_lon = 111412.84 * math.cos(lat_rad) - 93.5 * math.cos(3 * lat_rad)
    return 1.0 / m_per_deg_lat, 1.0 / m_per_deg_lon

def densify_segment(p1, p2, max_len_deg):
    x1, y1 = p1
    x2, y2 = p2
    dist = math.hypot(x2 - x1, y2 - y1)
    if dist <= max_len_deg or dist == 0:
        return [p1, p2]
    num_sub = math.ceil(dist / max_len_deg)
    points = [p1]
    for i in range(1, num_sub):
        t = i / num_sub
        points.append([round(x1 + t * (x2 - x1), 6), round(y1 + t * (y2 - y1), 6)])
    points.append(p2)
    return points

def densify_linestring(coords, max_len_deg):
    if len(coords) < 2:
        return coords
    out = [coords[0]]
    for i in range(len(coords) - 1):
        seg = densify_segment(coords[i], coords[i+1], max_len_deg)
        out.extend(seg[1:])
    return out

def clip_segment_to_box(p1, p2, west, south, east, north):
    # Cohen-Sutherland line clipping algorithm
    INSIDE = 0
    LEFT = 1
    RIGHT = 2
    BOTTOM = 4
    TOP = 8

    def compute_code(x, y):
        code = INSIDE
        if x < west:
            code |= LEFT
        elif x > east:
            code |= RIGHT
        if y < south:
            code |= BOTTOM
        elif y > north:
            code |= TOP
        return code

    x1, y1 = p1
    x2, y2 = p2
    code1 = compute_code(x1, y1)
    code2 = compute_code(x2, y2)

    while True:
        if not (code1 | code2):
            return [round(x1, 6), round(y1, 6)], [round(x2, 6), round(y2, 6)]
        elif code1 & code2:
            return None
        else:
            code_out = code1 if code1 else code2
            if code_out & TOP:
                x = x1 + (x2 - x1) * (north - y1) / (y2 - y1)
                y = north
            elif code_out & BOTTOM:
                x = x1 + (x2 - x1) * (south - y1) / (y2 - y1)
                y = south
            elif code_out & RIGHT:
                y = y1 + (y2 - y1) * (east - x1) / (x2 - x1)
                x = east
            elif code_out & LEFT:
                y = y1 + (y2 - y1) * (west - x1) / (x2 - x1)
                x = west

            if code_out == code1:
                x1, y1 = x, y
                code1 = compute_code(x1, y1)
            else:
                x2, y2 = x, y
                code2 = compute_code(x2, y2)

def clip_linestring(coords, west, south, east, north):
    clipped_lines = []
    current_line = []
    for i in range(len(coords) - 1):
        res = clip_segment_to_box(coords[i], coords[i+1], west, south, east, north)
        if res is not None:
            c1, c2 = res
            if not current_line:
                current_line.append(c1)
                current_line.append(c2)
            else:
                if current_line[-1] == c1:
                    current_line.append(c2)
                else:
                    clipped_lines.append(current_line)
                    current_line = [c1, c2]
        else:
            if current_line:
                clipped_lines.append(current_line)
                current_line = []
    if current_line:
        clipped_lines.append(current_line)
    return clipped_lines

def main():
    parser = argparse.ArgumentParser(description="Build simulation grid, roads, and marsh layers")
    parser.add_argument("--dem", default="data/raw/dem_COP30.tif", help="Path to input DEM GeoTIFF")
    args = parser.parse_args()

    south, west, north, east, cell_size_m = load_config()
    centre_lat = (south + north) / 2.0
    deg_per_m_lat, deg_per_m_lon = deg_per_metre(centre_lat)

    d_lat = cell_size_m * deg_per_m_lat
    d_lon = cell_size_m * deg_per_m_lon

    cols = int(round((east - west) / d_lon))
    rows = int(round((north - south) / d_lat))

    print(f"Building regular lon/lat grid over bbox:")
    print(f"  south={south}, west={west}, north={north}, east={east}")
    print(f"  cellSizeM={cell_size_m} m -> grid size: {cols} cols × {rows} rows ({cols*rows:,} cells)")

    # 1. Load and resample DEM
    dem_path = ROOT / args.dem
    if not dem_path.exists():
        print(f"ERROR: DEM file not found: {dem_path}", file=sys.stderr)
        sys.exit(1)

    with rasterio.open(dem_path) as ds:
        data = ds.read(1).astype(np.float32)
        nodata = ds.nodata
        transform = ds.transform

        # Fill nodata with nearest valid
        if nodata is not None:
            mask = (data == nodata) | np.isnan(data)
        else:
            mask = np.isnan(data)

        if np.any(mask):
            ind = distance_transform_edt(mask, return_distances=False, return_indices=True)
            data[mask] = data[tuple(ind[:, mask])]

        # Target grid coordinates (north to south row order)
        grid_lons = np.linspace(west + d_lon/2.0, east - d_lon/2.0, cols)
        grid_lats = np.linspace(north - d_lat/2.0, south + d_lat/2.0, rows)

        inv_transform = ~transform
        sample_raw = np.zeros((rows, cols), dtype=np.float32)

        # Bilinear sampling into regular grid
        for r_idx, lat in enumerate(grid_lats):
            for c_idx, lon in enumerate(grid_lons):
                px, py = inv_transform * (lon, lat)
                x0 = int(math.floor(px))
                y0 = int(math.floor(py))
                x1 = min(x0 + 1, ds.width - 1)
                y1 = min(y0 + 1, ds.height - 1)
                x0 = max(0, min(x0, ds.width - 1))
                y0 = max(0, min(y0, ds.height - 1))

                dx = px - x0
                dy = py - y0

                val = (1 - dx) * (1 - dy) * data[y0, x0] + \
                      dx * (1 - dy) * data[y0, x1] + \
                      (1 - dx) * dy * data[y1, x0] + \
                      dx * dy * data[y1, x1]
                sample_raw[r_idx, c_idx] = val

    # 2. Apply 3x3 median filter for surface smoothing (rooftops/vegetation)
    sample_filtered = median_filter(sample_raw, size=3)

    min_h = float(np.min(sample_filtered))
    max_h = float(np.max(sample_filtered))

    heights = [round(float(h), 2) for h in sample_filtered.ravel()]
    heights_raw = [round(float(h), 2) for h in sample_raw.ravel()]

    grid_obj = {
        "west": west,
        "south": south,
        "east": east,
        "north": north,
        "cols": cols,
        "rows": rows,
        "cellSizeM": cell_size_m,
        "rowOrder": "north-to-south",
        "heights": heights,
        "heightsRaw": heights_raw,
        "min": round(min_h, 2),
        "max": round(max_h, 2),
        "datum": "EGM2008_orthometric",
    }

    with open(GRID_JSON, "w", encoding="utf-8") as f:
        json.dump(grid_obj, f, separators=(",", ":"))
    grid_size_mb = GRID_JSON.stat().st_size / (1024 * 1024)
    print(f"\nSaved {GRID_JSON.name} ({grid_size_mb:.2f} MB)")

    # 4. Clip roads and densify
    max_seg_deg = min(d_lat, d_lon)
    roads_list = []
    marsh_features = []

    if RAW_ROADS_GEOJSON.exists():
        with open(RAW_ROADS_GEOJSON, "r", encoding="utf-8") as f:
            roads_geo = json.load(f)

        road_id = 1
        for feat in roads_geo.get("features", []):
            props = feat.get("properties", {})
            geom = feat.get("geometry", {})
            geom_type = geom.get("type")
            coords = geom.get("coordinates", [])

            if props.get("natural") == "wetland" or geom_type == "Polygon":
                marsh_features.append(feat)
                continue

            if geom_type == "LineString" and "highway" in props:
                sub_lines = clip_linestring(coords, west, south, east, north)
                for line in sub_lines:
                    if len(line) >= 2:
                        densified = densify_linestring(line, max_seg_deg)
                        roads_list.append({
                            "id": road_id,
                            "name": props.get("name", ""),
                            "highway": props.get("highway", "residential"),
                            "coords": densified,
                        })
                        road_id += 1

    with open(ROADS_JSON, "w", encoding="utf-8") as f:
        json.dump(roads_list, f, separators=(",", ":"))
    roads_size_kb = ROADS_JSON.stat().st_size / 1024
    print(f"Saved {ROADS_JSON.name}: {len(roads_list)} clipped segments ({roads_size_kb:.1f} KB)")

    # 5. Labels and Marsh
    labels_list = []
    if RAW_LABELS_GEOJSON.exists():
        with open(RAW_LABELS_GEOJSON, "r", encoding="utf-8") as f:
            labels_geo = json.load(f)
        for feat in labels_geo.get("features", []):
            props = feat.get("properties", {})
            coords = feat.get("geometry", {}).get("coordinates", [])
            if len(coords) == 2:
                lon, lat = coords
                if west <= lon <= east and south <= lat <= north:
                    labels_list.append({
                        "name": props.get("name", ""),
                        "lon": round(lon, 5),
                        "lat": round(lat, 5),
                    })

    with open(LABELS_JSON, "w", encoding="utf-8") as f:
        json.dump(labels_list, f, indent=2)
    labels_size_kb = LABELS_JSON.stat().st_size / 1024
    print(f"Saved {LABELS_JSON.name}: {len(labels_list)} labels ({labels_size_kb:.1f} KB)")

    marsh_obj = {
        "type": "FeatureCollection",
        "features": marsh_features,
    }
    with open(MARSH_JSON, "w", encoding="utf-8") as f:
        json.dump(marsh_obj, f, separators=(",", ":"))
    marsh_size_kb = MARSH_JSON.stat().st_size / 1024
    print(f"Saved {MARSH_JSON.name}: {len(marsh_features)} wetland polygons ({marsh_size_kb:.1f} KB)")

    print("\n" + "=" * 60)
    print(f"Grid Size           : {cols} × {rows} ({cols * rows:,} nodes)")
    print(f"Filtered Height     : {min_h:.2f} m to {max_h:.2f} m (range: {max_h - min_h:.2f} m)")
    print(f"Unfiltered Height   : {np.min(sample_raw):.2f} m to {np.max(sample_raw):.2f} m")
    print(f"Grid File Size      : {grid_size_mb:.3f} MB (under 2 MB limit: {'PASS' if grid_size_mb < 2.0 else 'FAIL'})")
    print("=" * 60)

if __name__ == "__main__":
    main()
