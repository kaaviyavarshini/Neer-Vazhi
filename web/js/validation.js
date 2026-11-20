/**
 * web/js/validation.js
 * Reality-check layer: known waterlogging points drawn as small rings on the map,
 * coloured green (model caught it) or red (missed) after each simulation run,
 * plus a score card in the panel. Toggled by the VALIDATE button.
 *
 * Scoring maths lives in validation-core.js (shared with scripts/score_presets.mjs).
 * Validation data is for scoring only; it never feeds the water model.
 */
import { grid } from './terrain.js';
import { getWaterDepth } from './pooling.js';
import { scorePoints, scoreZones } from './validation-core.js';

const RING_M = 28;                 // ring radius on the ground, metres
const SEGMENTS = 20;
const GREY = '#e0e0e0', GREEN = '#00e676', RED = '#ff1744';

let viewer = null;
let points = [];
let rings = [];                    // Cesium entities, same order as points
let visible = false;
let loaded = false;
let zones = null;                  // flood-zone raster (optional; card still works without it)

function ringPositions(lon, lat) {
  const dLat = RING_M / 111320;
  const dLon = RING_M / (111320 * Math.cos((lat * Math.PI) / 180));
  const flat = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * 2 * Math.PI;
    flat.push(lon + dLon * Math.cos(a), lat + dLat * Math.sin(a));
  }
  return Cesium.Cartesian3.fromDegreesArray(flat);
}

function sourceLabel(s) {
  return /inundation/i.test(s) ? 'GCC inundation' : /stagnation/i.test(s) ? 'GCC stagnation 2015' : s;
}

/** Loads data/validation.json and builds the (hidden) rings. Reports failures on screen. */
export async function initValidation(v) {
  viewer = v;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000); // fetch timeout (Phase 2 rule 4)
    const res = await fetch('data/validation.json', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    points = await res.json();
  } catch (e) {
    showCard(`Could not load data/validation.json (${e.message}). Run: python scripts/build_validation.py`, true);
    return;
  }
  try {
    const zr = await fetch('data/validation_zones.json');
    if (zr.ok) zones = await zr.json();
  } catch (e) { zones = null; }
  rings = points.map((p) => viewer.entities.add({
    show: false,
    polyline: {
      positions: ringPositions(p.lon, p.lat),
      width: 3.5,
      clampToGround: true,
      classificationType: Cesium.ClassificationType.BOTH,
      material: Cesium.Color.fromCssColorString(GREY),
    },
    description: `${sourceLabel(p.source)}${p.reportedDepthM != null ? ` — reported ${(p.reportedDepthM * 100).toFixed(0)} cm` : ''}${p.year ? ` (${p.year})` : ''}`,
  }));
  loaded = true;
  refreshValidation();
}

function showCard(html, isError = false) {
  const el = document.getElementById('validation-card');
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle('error', isError);
  el.hidden = !(visible || isError);
}

/** Re-scores against the latest water depth; call after every simulation run. */
export function refreshValidation() {
  if (!loaded) return;
  const depth = getWaterDepth();
  if (!depth || !grid) return;
  const s = scorePoints(points, depth, grid);
  s.perPoint.forEach((r, i) => {
    rings[i].polyline.material = Cesium.Color.fromCssColorString(r.hit ? GREEN : RED);
  });
  const err = s.depthErrCm == null ? '' :
    `<div class="vc-line">Average depth error: <b>${s.depthErrCm.toFixed(0)} cm</b> over ${s.depthN} spots with a reported depth</div>`;
  let zl = '';
  if (zones && zones.codes.length === depth.length) {
    const z = scoreZones(depth, zones);
    zl = `<div class="vc-line">Flood-zone map: model floods <b>${z.highCaught.toFixed(0)}%</b> of Very High/High zones and <b>${z.lowFlooded.toFixed(0)}%</b> of Very Low zones</div>`;
  }
  showCard(
    `<div class="vc-head">Model caught <b>${s.hits}</b> of <b>${s.total}</b> known waterlogging spots (<b>${s.hitRate.toFixed(0)}%</b>)</div>` +
    `<div class="vc-line">Wet area: <b>${s.wetPct.toFixed(1)}%</b> of the box</div>${err}${zl}` +
    `<div class="vc-note">Hit = more than 15 cm within one cell (30 m) of the spot. Point locations are approximate.</div>`
  );
}

/** Toggles rings and score card. Returns the new visibility. */
export function toggleValidation(show = !visible) {
  visible = !!show;
  rings.forEach((e) => { e.show = visible; });
  const el = document.getElementById('validation-card');
  if (el) el.hidden = !visible && !el.classList.contains('error');
  if (visible) refreshValidation();
  return visible;
}

export const isValidationVisible = () => visible;
