# Data sources

The single record of every dataset this project uses. **Phase 2 rule: no dataset may be added to the project unless it has a row here** (name, URL, date downloaded, licence, notes). If something is not known, it is written as *not recorded* — never guessed.

Dates are `YYYY-MM-DD`. "Re-fetched" means the file was downloaded again and compared byte-for-byte with the previous copy.

---

## 1. Datasets in use

| # | Name | URL | Date downloaded | Licence | Notes |
|:-:|---|---|---|---|---|
| 1 | **Copernicus GLO-30 DEM** (`COP30`) via OpenTopography | API: `https://portal.opentopography.org/API/globaldem` with `demtype=COP30`, `outputFormat=GTiff` and the padded study box below. Dataset page: <https://portal.opentopography.org/datasetMetadata?otCollectionID=OT.032021.4326.1> | **2026-11-20** (re-fetched; byte-identical to the earlier copy). First download date: *not recorded*. | Copernicus licence — free to the general public (see dataset page). Attribution: © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved. Cite: *European Space Agency (2024). Copernicus Global Digital Elevation Model. Distributed by OpenTopography.* <https://doi.org/10.5069/G9028PQB> | File `data/raw/dem_COP30.tif` (478,872 bytes, 324 × 396 cells, heights −12.41 m to 77.59 m, no NoData cells). Requested box: south 12.885, west 80.185, north 12.995, east 80.275 (the study area padded by 0.005°). It is a **surface** model (rooftops, tree canopy). `build_grid.py` records the datum as `EGM2008_orthometric`. Fetched by `scripts/fetch_dem.py`; needs `OPENTOPO_KEY`. |
| 2 | **OpenStreetMap — roads, localities, wetland** | `https://overpass-api.de/api/interpreter`. Query (box = study area): `way["highway"]`, `node["place"~"suburb\|neighbourhood\|quarter"]["name"]`, `way["natural"="wetland"]`, `relation["natural"="wetland"]` (exact text in `scripts/fetch_roads.py`). Copyright page: <https://www.openstreetmap.org/copyright> | **2026-11-20** (re-fetched; byte-identical to the earlier copy). First download date: *not recorded*. | Open Database Licence (ODbL). Attribution: "© OpenStreetMap contributors" (guidelines: <https://osmfoundation.org/wiki/Licence/Attribution_Guidelines>). Derived files carry the ODbL terms. | Files `data/raw/roads.geojson` (12,756 features, 2,978,436 bytes) and `data/raw/labels.geojson` (85 places). OSM changes continuously, so a later fetch may differ. Fetched by `scripts/fetch_roads.py` (Overpass is a shared public service; it returned HTTP 502 once and succeeded on the script's retry). |
| 3 | **Open-Meteo historical weather — hourly precipitation** | `https://archive-api.open-meteo.com/v1/archive` with `latitude=12.94`, `longitude=80.23` (centre of the study area), `hourly=precipitation`, `timezone=Asia/Kolkata`. Two requests: `2023-12-02` to `2023-12-06` (preset `michaung_2023`) and `2015-11-30` to `2015-12-03` (preset `nov_dec_2015`). Docs: <https://open-meteo.com/en/docs/historical-weather-api> | **2026-11-20** (re-fetched; `web/data/rain.json` byte-identical to the committed copy, first committed 2026-11-19 in `34af0e9`). First download date: *not recorded*. | CC BY 4.0 ([terms](https://open-meteo.com/en/terms)); free API is for non-commercial use. Cite: *Zippenfenig, P. (2023). Open-Meteo.com Weather API.* <https://doi.org/10.5281/ZENODO.7970649>. Open-Meteo's published acknowledgement: "Generated using Copernicus Climate Change Service information 2022." | Reanalysis (ERA5 / ERA5-Land family), roughly 11–25 km cells: a regional average that under-records short intense bursts. The request does not name a model, so Open-Meteo chooses its default. Totals: 257.7 mm (`michaung_2023`), 142.1 mm (`nov_dec_2015`). **One point only** (the study-area centre). Fetched by `scripts/fetch_rain.py`. |
| 4 | **GCC flood inundation points, with depth** (file `data/validation/chennai_flood_inundation_inches.kml`) | OpenCity (Greater Chennai Corporation data). Exact dataset page URL: *not recorded* (file came from a KML export named `814ca028-4c84-4bd0-aa67-6dbaeb9b6ba5.kml`); portal: <https://opencity.in> | **2026-11-20** (file timestamp in Downloads; first download date otherwise *not recorded*) | *Not recorded* - check the OpenCity dataset page before redistributing | 192 points, 71 inside the study box. `DEPTH` is in **inches** (converted x0.0254 to m by `build_validation.py`). Survey year *not recorded*, so `year` is null. Locations are approximate. **Scoring only - never a model input.** |
| 5 | **GCC water stagnation locations 2015** (file `data/validation/chennai_water_stagnation_2015.kml`) | OpenCity (Greater Chennai Corporation data). Exact dataset page URL: *not recorded* (KML export `93d2905a-a580-482d-96b0-4d9ccf5273ef.kml`); portal: <https://opencity.in> | **2026-11-20** (file timestamp; first download date otherwise *not recorded*) | *Not recorded* - check the OpenCity dataset page before redistributing | 753 points, 96 inside the study box. No depth. Year 2015 taken from the file name. **Scoring only.** |
| 6 | **GCC flood inundation zones** (`7f29da20-6621-4b49-b0cf-28b9d1de232b.kml`, 7,453 polygon features, 40 MB) | OpenCity | 2026-11-20 (file timestamp) | *Not recorded* | Copied to `data/validation/chennai_flood_inundation_zones.kml` (OVERLAY__1 1=Very High ... 5=Very Low). Rasterised to the 30 m grid by `scripts/build_validation_zones.py` -> `web/data/validation_zones.json`; where polygons overlap the most severe wins (assumption). **Scoring only.** |

### Files built from the above (derived, reproducible)

`python scripts/build_grid.py` turns datasets 1 and 2 into the files the browser loads. On 2026-11-20 the whole pipeline (`fetch_dem` → `fetch_roads` → `fetch_rain` → `build_grid`) was re-run and **every output was byte-identical** to the files already in `web/data/`.

| File | Built from | Contents |
|---|---|---|
| `web/data/grid.json` | #1 | 289 × 369 grid of 30 m cells, 3 × 3 median-filtered heights (`heights`) and unfiltered heights (`heightsRaw`) |
| `web/data/roads.json` | #2 | 3,170 road segments clipped to the study area and densified to at most one cell |
| `web/data/labels.json` | #2 | 85 locality labels |
| `web/data/marsh.json` | #2 | 17 wetland polygons (`natural=wetland`) |
| `web/data/rain.json` | #3 (+ section 3 below) | Four rain presets |
| `web/data/area.json` | `config/area.json` | Copy made by `scripts/write_config.py` |

---

## 2. Runtime services (streamed into the page, not downloaded or stored)

| Name | URL | Licence / terms | Notes |
|---|---|---|---|
| **Google Photorealistic 3D Tiles** (Map Tiles API) | `https://tile.googleapis.com/v1/3dtiles/root.json` (needs `GOOGLE_MAPS_KEY`) | [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies) | Visual backdrop only. Google's terms forbid pre-fetching, storing, bulk-downloading or deriving data from the tiles, so **no model input may come from them**. The Google Maps logo must stay visible. |
| **Esri World Imagery** | `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer` | *Esri terms — not yet checked; verify before wider use* | Fallback backdrop shown only when the Google tiles are unavailable. |
| CesiumJS 1.117, Three.js r160, Oswald and Fira Code fonts | jsDelivr / Google Fonts CDNs | Apache-2.0 / MIT / SIL OFL | Code and fonts, not data. |

---

## 3. Synthetic or assumed inputs (NOT downloaded data)

These are produced by code, not fetched from anywhere. Under the Phase 2 rules they count as **assumptions** and belong in `config/area.json` with an explanation (not yet done).

| Item | Where it comes from | Status |
|---|---|---|
| Preset `heavy_day`: 200 mm over 24 h, triangular rain curve peaking at hour 10 | Hard-coded in `scripts/fetch_rain.py` | **Assumption.** Label already says "Synthetic". Needs to move to `config/area.json` with a stated reason. |
| Preset `gauge_440`: 440 mm over 36 h, triangular curve peaking at hour 18, labelled "Perungudi gauge reference" for Cyclone Michaung | Hard-coded in `scripts/fetch_rain.py` | **UNSOURCED.** The code and label say it is a rain-gauge total reported for Cyclone Michaung, but **no URL, document or date for that figure exists anywhere in the project.** The curve shape is invented. It must be given a citable source or be removed / clearly relabelled as an assumption. |
| Runoff coefficient `0.8` | `config/area.json` (`runoffCoeff`) | **Assumption with no recorded justification.** Needs a `_notes` entry saying why 0.8. |
| Study-area box (12.89–12.99 °N, 80.19–80.27 °E) and 30 m cell size | `config/area.json` | Choices, not data. Fine, but they should carry `_notes` entries too. |
| Drain capacity, outlet capacity | — | Not modelled yet. When added, each value needs a source or a clearly marked assumption. |

---

## 4. Not in the project yet

| Item | State |
|---|---|
| ~~Validation data~~ | Added 2026-11-20: rows 4-5 above. Derived file `web/data/validation.json` is built by `python -I scripts/build_validation.py`. |
| **Complaint data** | None present. |

Both are for **scoring the model only** and must never feed the model (Phase 2 rule 3).

---

## 5. Provenance gaps to resolve

1. **`data/raw/dem_SRTMGL1_E.tif`** (127,910 bytes, file dated 2026-11-19 17:45) — downloaded with `fetch_dem.py --demtype SRTMGL1_E`. **Nothing uses it**, and its licence has not been checked. Either record the licence here or delete it.
2. **`web/data/dem.json`** — an 80 × 60 grid over a *smaller area* than the current study box (west 80.195, south 12.9, heights −12.41 m to 29.60 m). Its values look like elevation data, but **the script that produced it is no longer in the repository**, so its origin is not recorded. Only the legacy `elevation-layer.js` mentions it, and neither page loads that module. Treat it as unsourced; delete it or regenerate it from dataset #1.
3. **First-download dates** for datasets 1–3 were not recorded when the files were first fetched. The dates above are the dates of the verified re-fetch.
4. **`gauge_440`** — see section 3.

---

## How to add a dataset

1. Download it from a real URL or file. If you cannot, stop and say what is missing.
2. Save the raw file under `data/raw/` (or `data/validation/` for scoring data).
3. Add a row to this file **before** using it: name, URL, date downloaded, licence (read from the provider's own page), notes.
4. Add the licence attribution to the README's "Data sources and attribution" table.
