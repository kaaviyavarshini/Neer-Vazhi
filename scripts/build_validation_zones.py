#!/usr/bin/env python3
"""
scripts/build_validation_zones.py
Rasterises the GCC flood-inundation ZONE polygons (data/validation/*zones*.kml)
onto the model's 30 m grid and writes web/data/validation_zones.json.

SCORING ONLY (Phase 2 rule 3): the model never reads this file.

Code per cell: 0 = no zone polygon, 1 = Very High, 2 = High, 3 = Moderate,
4 = Low, 5 = Very Low (the file's own OVERLAY__1 value). Zone polygons overlap;
where several cover a cell the MOST SEVERE (lowest number) wins (assumption).

Run:  python -I scripts/build_validation_zones.py
"""
import json, pathlib, sys
import xml.etree.ElementTree as ET
import numpy as np
from rasterio import features
from rasterio.transform import from_bounds

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = next((ROOT / "data" / "validation").glob("*zones*.kml"), None)
GRID = ROOT / "web" / "data" / "grid.json"
OUT = ROOT / "web" / "data" / "validation_zones.json"
NAMES = {1: "Very High", 2: "High", 3: "Moderate", 4: "Low", 5: "Very Low"}


def tag(t):
    return t.rsplit("}", 1)[-1]


def ring(text):
    pts = [p.split(",") for p in text.split()]
    return [(float(p[0]), float(p[1])) for p in pts if len(p) >= 2]


def main():
    if SRC is None:
        sys.exit("No *zones*.kml in data/validation/")
    g = json.loads(GRID.read_text(encoding="utf-8"))
    w, s, e, n, cols, rows = g["west"], g["south"], g["east"], g["north"], g["cols"], g["rows"]
    tr = from_bounds(w, s, e, n, cols, rows)  # row 0 = north, same as the model grid
    shapes = {k: [] for k in NAMES}
    total = used = 0
    for _, el in ET.iterparse(SRC, events=("end",)):
        if tag(el.tag) != "Placemark":
            continue
        total += 1
        cat = None
        for sd in el.iter():
            if tag(sd.tag) == "SimpleData" and sd.get("name") == "OVERLAY__1":
                cat = int(sd.text)
        for poly in (p for p in el.iter() if tag(p.tag) == "Polygon"):
            outer, holes = None, []
            for b in poly.iter():
                if tag(b.tag) == "coordinates":
                    r = ring(b.text)
                    if outer is None:
                        outer = r
                    else:
                        holes.append(r)
            if cat in shapes and outer and len(outer) >= 4:
                lons = [p[0] for p in outer]; lats = [p[1] for p in outer]
                if max(lons) >= w and min(lons) <= e and max(lats) >= s and min(lats) <= n:
                    shapes[cat].append({"type": "Polygon", "coordinates": [outer] + holes})
                    used += 1
        el.clear()
    grid = np.zeros((rows, cols), dtype=np.uint8)
    for cat in (5, 4, 3, 2, 1):  # paint least severe first so the most severe wins
        if shapes[cat]:
            m = features.rasterize([(sh, cat) for sh in shapes[cat]], out_shape=(rows, cols),
                                   transform=tr, fill=0, dtype="uint8")
            grid = np.where(m > 0, m, grid)
    OUT.write_text(json.dumps({"west": w, "south": s, "east": e, "north": n, "cols": cols,
                               "rows": rows, "names": NAMES,
                               "codes": "".join(map(str, grid.ravel()))}, separators=(",", ":")),
                   encoding="utf-8")
    print(f"{total} zone polygons read, {used} overlap the study box")
    for c, nm in NAMES.items():
        print(f"  {nm}: {(grid == c).sum()} cells ({100 * (grid == c).mean():.1f}% of box)")
    print(f"  no zone: {(grid == 0).sum()} cells ({100 * (grid == 0).mean():.1f}%)")
    print("Wrote", OUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
