#!/usr/bin/env python3
"""
scripts/build_validation.py
Reads every point file in data/validation/ (KML, GeoJSON/JSON, CSV), keeps the
points inside the study box (config/area.json) and writes web/data/validation.json:

    [{id, lon, lat, source, reportedDepthM | null, year | null}]

Validation data is ONLY for scoring the model (Phase 2 rule 3). Nothing here is a
model input; build_grid.py / pooling-*.js never read these files.

Rules for what is read (nothing is guessed):
  * source   = file name without extension.
  * depth    = a DEPTH column, converted to metres. The unit comes from the file
               name ("inches" -> x0.0254). A DEPTH column with no unit in the
               name is NOT used (depth stays null) and a warning is printed.
  * year     = a 4-digit year (19xx/20xx) in the file name, else null.
  * Files with no point features (e.g. polygon zone files) are skipped and listed.

Run:  python -I scripts/build_validation.py
"""
import csv
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
VAL_DIR = ROOT / "data" / "validation"
AREA = ROOT / "config" / "area.json"
OUT = ROOT / "web" / "data" / "validation.json"
INCH_M = 0.0254  # 1 inch in metres


def strip_ns(tag):
    return tag.rsplit("}", 1)[-1]


def num(x):
    try:
        v = float(str(x).strip())
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def read_kml(path):
    """Yield (lon, lat, props) for every Point placemark."""
    for _, el in ET.iterparse(path, events=("end",)):
        if strip_ns(el.tag) != "Placemark":
            continue
        props, pt = {}, None
        for sub in el.iter():
            t = strip_ns(sub.tag)
            if t == "SimpleData":
                props[sub.get("name")] = (sub.text or "").strip()
            elif t == "name" and sub.text:
                props.setdefault("name", sub.text.strip())
            elif t == "Point":
                for c in sub.iter():
                    if strip_ns(c.tag) == "coordinates" and c.text:
                        pt = c.text.strip().split(",")
        el.clear()
        if pt and len(pt) >= 2 and num(pt[0]) is not None and num(pt[1]) is not None:
            yield float(pt[0]), float(pt[1]), props


def read_geojson(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    feats = data.get("features", []) if isinstance(data, dict) else []
    for f in feats:
        g = f.get("geometry") or {}
        if g.get("type") == "Point":
            lon, lat = g["coordinates"][:2]
            yield float(lon), float(lat), f.get("properties") or {}


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            low = {k.lower().strip(): v for k, v in row.items() if k}
            lat = num(low.get("lat") or low.get("latitude") or low.get("f_latitude"))
            lon = num(low.get("lon") or low.get("lng") or low.get("long_")
                      or low.get("longitude") or low.get("f_longitude"))
            if lat is not None and lon is not None:
                yield lon, lat, row


READERS = {".kml": read_kml, ".geojson": read_geojson, ".json": read_geojson, ".csv": read_csv}


def main():
    area = json.loads(AREA.read_text(encoding="utf-8"))
    south, west, north, east = area["south"], area["west"], area["north"], area["east"]
    files = sorted(p for p in VAL_DIR.iterdir() if p.suffix.lower() in READERS)
    if not files:
        sys.exit("No KML/GeoJSON/CSV files in data/validation/ - download them there first.")

    out, seen = [], set()
    print(f"Study box: S{south} W{west} N{north} E{east}")
    for path in files:
        source = path.stem
        stem_l = source.lower()
        ym = re.search(r"(?:19|20)\d\d", source)
        year = int(ym.group(0)) if ym else None
        inches = "inch" in stem_l
        total = inside = with_depth = 0
        warned = False
        for lon, lat, props in READERS[path.suffix.lower()](path):
            total += 1
            if not (south <= lat <= north and west <= lon <= east):
                continue
            inside += 1
            depth = None
            raw = num({k.upper(): v for k, v in props.items()}.get("DEPTH"))
            if raw is not None:
                if inches:
                    depth = round(raw * INCH_M, 4)
                    with_depth += 1
                elif not warned:
                    print(f"  WARNING {path.name}: DEPTH column present but unit not in file name - depth ignored")
                    warned = True
            oid = props.get("OBJECTID") or props.get("OBJECTID_1") or str(total)
            pid = f"{source}-{oid}"
            while pid in seen:
                pid += "x"
            seen.add(pid)
            out.append({"id": pid, "lon": round(lon, 7), "lat": round(lat, 7),
                        "source": source, "reportedDepthM": depth, "year": year})
        if total == 0:
            print(f"{path.name}: no point features - skipped")
            continue
        print(f"{source}: {total} points, {inside} inside box, {total - inside} outside, "
              f"{with_depth} with depth, year={year}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(out)} points -> {OUT.relative_to(ROOT)}")
    skipped = [p.name for p in VAL_DIR.iterdir() if p.is_file() and p.suffix.lower() not in READERS]
    if skipped:
        print("Ignored (unsupported type):", ", ".join(skipped))


if __name__ == "__main__":
    main()
