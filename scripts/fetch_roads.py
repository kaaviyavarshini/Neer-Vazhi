#!/usr/bin/env python3
"""
scripts/fetch_roads.py
Fetches OSM data from Overpass API for bbox in config/area.json:
  1. every way with a highway tag, with out geom;
  2. nodes with place=suburb, neighbourhood or quarter that have a name
  3. ways and relations with natural=wetland (Pallikaranai Marsh)

Converts the result to GeoJSON in Python (no extra tools).
Keeps only name, highway and ref in roads.geojson properties.
Saves data/raw/roads.geojson and data/raw/labels.geojson.
Prints road counts per highway type and the list of label names.
On HTTP 429 or 504, waits 30 s and retries once.
"""

import json
import pathlib
import sys
import time
import requests

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "area.json"
DATA_RAW = ROOT / "data" / "raw"
DATA_RAW.mkdir(parents=True, exist_ok=True)

ROADS_GEOJSON = DATA_RAW / "roads.geojson"
LABELS_GEOJSON = DATA_RAW / "labels.geojson"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

def load_bbox():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "bbox" in cfg:
        b = cfg["bbox"]
        return b["south"], b["west"], b["north"], b["east"]
    return cfg["south"], cfg["west"], cfg["north"], cfg["east"]

def query_overpass(query: str):
    headers = {
        "User-Agent": "NeerVazhi/1.0 (FloodVisualisation; contact: info@example.org)"
    }
    for attempt in range(2):
        try:
            resp = requests.post(
                OVERPASS_URL,
                data={"data": query},
                headers=headers,
                timeout=120,
            )
            if resp.status_code in (429, 502, 504):
                if attempt == 0:
                    print(f"HTTP {resp.status_code} received from Overpass. Waiting 30s before retry...")
                    time.sleep(30)
                    continue
                else:
                    print(f"HTTP error {resp.status_code}: {resp.text}")
                    resp.raise_for_status()
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if attempt == 0 and status in (429, 502, 504):
                print(f"HTTP {status} received. Waiting 30s before retry...")
                time.sleep(30)
                continue
            raise e

def main():
    south, west, north, east = load_bbox()
    print(f"Querying Overpass for bbox: south={south}, west={west}, north={north}, east={east} ...")

    query = f"""
[out:json][timeout:90];
(
  way["highway"]({south},{west},{north},{east});
  node["place"~"suburb|neighbourhood|quarter"]["name"]({south},{west},{north},{east});
  way["natural"="wetland"]({south},{west},{north},{east});
  relation["natural"="wetland"]({south},{west},{north},{east});
);
out body geom;
"""

    data = query_overpass(query)
    elements = data.get("elements", [])
    print(f"Received {len(elements)} elements from Overpass.")

    road_features = []
    label_features = []
    highway_counts = {}
    label_names = []

    for el in elements:
        el_type = el.get("type")
        tags = el.get("tags", {})

        # 1. Labels: nodes with place=suburb, neighbourhood or quarter with a name
        if el_type == "node" and "place" in tags and "name" in tags:
            name = tags["name"]
            place = tags["place"]
            lon = el.get("lon")
            lat = el.get("lat")
            if lon is not None and lat is not None:
                feat = {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [lon, lat],
                    },
                    "properties": {
                        "name": name,
                        "place": place,
                    },
                }
                label_features.append(feat)
                label_names.append(name)

        # 2. Roads: ways with highway tag
        elif el_type == "way" and "highway" in tags:
            geom = el.get("geometry", [])
            if len(geom) >= 2:
                coords = [[pt["lon"], pt["lat"]] for pt in geom if "lon" in pt and "lat" in pt]
                if len(coords) >= 2:
                    h_type = tags["highway"]
                    highway_counts[h_type] = highway_counts.get(h_type, 0) + 1

                    # Keep only name, highway, and ref
                    props = {"highway": h_type}
                    if "name" in tags:
                        props["name"] = tags["name"]
                    if "ref" in tags:
                        props["ref"] = tags["ref"]

                    feat = {
                        "type": "Feature",
                        "geometry": {
                            "type": "LineString",
                            "coordinates": coords,
                        },
                        "properties": props,
                    }
                    road_features.append(feat)

        # 3. Wetlands: ways with natural=wetland
        elif el_type == "way" and tags.get("natural") == "wetland":
            geom = el.get("geometry", [])
            if len(geom) >= 3:
                coords = [[pt["lon"], pt["lat"]] for pt in geom if "lon" in pt and "lat" in pt]
                if len(coords) >= 3:
                    # Keep only name, highway, ref if present
                    props = {}
                    if "name" in tags:
                        props["name"] = tags["name"]
                    if "highway" in tags:
                        props["highway"] = tags["highway"]
                    if "ref" in tags:
                        props["ref"] = tags["ref"]

                    feat = {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [coords],
                        },
                        "properties": props,
                    }
                    road_features.append(feat)

    # Build GeoJSON collections
    roads_geojson = {
        "type": "FeatureCollection",
        "features": road_features,
    }

    labels_geojson = {
        "type": "FeatureCollection",
        "features": label_features,
    }

    with open(ROADS_GEOJSON, "w", encoding="utf-8") as f:
        json.dump(roads_geojson, f, separators=(",", ":"))
    print(f"Saved {len(road_features)} features -> {ROADS_GEOJSON}")

    with open(LABELS_GEOJSON, "w", encoding="utf-8") as f:
        json.dump(labels_geojson, f, indent=2)
    print(f"Saved {len(label_features)} labels -> {LABELS_GEOJSON}")

    # Print road counts per highway type
    print("\n--- Road Counts per Highway Type ---")
    for h_type, count in sorted(highway_counts.items(), key=lambda x: -x[1]):
        print(f"  {h_type:<20}: {count}")

    # Print list of label names
    print("\n--- Place Label Names ---")
    unique_labels = sorted(set(label_names))
    if unique_labels:
        for name in unique_labels:
            print(f"  - {name}")
    else:
        print("  (None found)")

if __name__ == "__main__":
    main()
