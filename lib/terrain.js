/**
 * web/js/terrain.js
 * Scene 2: DEM elevation slab as ONE Cesium Primitive (triangle mesh,
 * per-vertex colours) with an animated vertical exaggeration.
 *
 * Mesh vertices are stored in a local East-North-Up frame (metres):
 *   x = east, y = north, z = (h - minH)   <- raw relief, NOT exaggerated
 * The Primitive's modelMatrix = ENU frame at baseHeight * scale(1,1,exag),
 * so  vertex height = baseHeight + (h - minH) * exaggeration  holds exactly
 * and animating exaggeration only touches one matrix (no mesh rebuild).
 */

const TARGET_EXAG = 10;      // full exaggeration (CLAUDE.md: 10x)
const ANIM_MS = 4000;
const CLEARANCE_M = 2;       // lowest cell sits this far above the tiles
const FALLBACK_TILE_H = -80; // TODO: rough Chennai ellipsoid height, only if sampling fails
const ALPHA = 0.9;
// deep teal -> green -> pale yellow
const RAMP = [[0.0, [0, 96, 100]], [0.5, [67, 160, 71]], [1.0, [255, 249, 196]]];

export let grid = null;      // set by initTerrain(); shared with other modules

let viewer = null, prim = null, outline = null;
let baseHeight = 0, minH = 0, enu = null;
let exag = 0, anim = 0, ready = null, localPos = null;

export async function initTerrain(v) {
  viewer = v;
  const res = await fetch('/data/grid.json');
  if (!res.ok) throw new Error(`Failed to load data/grid.json: HTTP ${res.status}`);
  grid = await res.json();
  let lo = Infinity, hi = -Infinity;
  for (const h of grid.heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
  minH = lo; grid.minH = lo; grid.maxH = hi;
  return grid;
}

/** DEM height (metres, unexaggerated, bilinear) at lon/lat; null outside the bbox. */
export function getHeightAt(lon, lat) {
  if (!grid) return null;
  const { west, east, south, north, cols, rows, heights } = grid;
  if (lon < west || lon > east || lat < south || lat > north) return null;
  // cell-centre sample coordinates; row 0 is the NORTH edge
  const fc = Math.min(Math.max((lon - west) / (east - west) * cols - 0.5, 0), cols - 1);
  const fr = Math.min(Math.max((north - lat) / (north - south) * rows - 0.5, 0), rows - 1);
  const c0 = Math.min(Math.floor(fc), cols - 2), r0 = Math.min(Math.floor(fr), rows - 2);
  const tc = fc - c0, tr = fr - r0, at = (r, c) => heights[r * cols + c];
  return (at(r0, c0) * (1 - tc) + at(r0, c0 + 1) * tc) * (1 - tr) +
         (at(r0 + 1, c0) * (1 - tc) + at(r0 + 1, c0 + 1) * tc) * tr;
}

function ramp(t) {
  t = Math.min(Math.max(t, 0), 1);
  const [t0, a] = t < RAMP[1][0] ? RAMP[0] : RAMP[1];
  const [t1, b] = t < RAMP[1][0] ? RAMP[1] : RAMP[2];
  const k = (t - t0) / (t1 - t0);
  return a.map((x, i) => Math.round(x + (b[i] - x) * k));
}

async function computeBaseHeight() {
  const lon = (grid.west + grid.east) / 2, lat = (grid.south + grid.north) / 2;
  let tileH;
  const has3DTiles = viewer.scene.primitives.length > 0 && !!viewer.scene.primitives.get(0)?.isCesium3DTileset;
  if (has3DTiles) {
    try {
      const res = await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(lon, lat)]);
      if (res && res.length > 0 && Number.isFinite(res[0].height)) {
        tileH = res[0].height;
      }
    } catch (e) {
      console.warn('sampleHeightMostDetailed failed:', e.message);
    }
  }
  if (!Number.isFinite(tileH)) {
    tileH = has3DTiles ? FALLBACK_TILE_H : 10.0;
    console.warn(`terrain: tile height unavailable, using fallback ${tileH} m`);
  }
  return tileH + CLEARANCE_M;
}

function build() {
  const { west, east, south, north, cols, rows, heights } = grid;
  const lon0 = (west + east) / 2, lat0 = (south + north) / 2;
  enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon0, lat0, baseHeight));
  const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  const n = cols * rows, pos = localPos = new Float64Array(n * 3), col = new Uint8Array(n * 4);
  const tmp = new Cesium.Cartesian3(), span = (grid.maxH - minH) || 1;
  for (let r = 0; r < rows; r++) {
    const lat = north - (r + 0.5) / rows * (north - south);   // row 0 = north
    for (let c = 0; c < cols; c++) {
      const lon = west + (c + 0.5) / cols * (east - west), i = r * cols + c;
      // horizontal placement only; height comes from relief so the modelMatrix can scale it
      Cesium.Matrix4.multiplyByPoint(inv, Cesium.Cartesian3.fromDegrees(lon, lat, baseHeight), tmp);
      pos.set([tmp.x, tmp.y, heights[i] - minH], i * 3);
      col.set([...ramp((heights[i] - minH) / span), Math.round(ALPHA * 255)], i * 4);
    }
  }
  const idx = Cesium.IndexDatatype.createTypedArray(n, (cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const nw = r * cols + c, ne = nw + 1, sw = nw + cols, se = sw + 1;
    idx.set([sw, se, ne, sw, ne, nw], k); k += 6;          // 2 triangles per cell
  }
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      color: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE, componentsPerAttribute: 4, normalize: true, values: col }),
    },
    indices: idx,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(pos),
  });
  prim = viewer.scene.primitives.add(new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
    asynchronous: false,
    show: false,
  }));

  // white outline along the slab's outer edge (same local frame / modelMatrix)
  const edge = [];
  const p = (r, c) => { const i = (r * cols + c) * 3; return new Cesium.Cartesian3(pos[i], pos[i + 1], pos[i + 2]); };
  for (let c = 0; c < cols; c++) edge.push(p(0, c));
  for (let r = 1; r < rows; r++) edge.push(p(r, cols - 1));
  for (let c = cols - 2; c >= 0; c--) edge.push(p(rows - 1, c));
  for (let r = rows - 2; r >= 0; r--) edge.push(p(r, 0));
  outline = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  outline.add({ positions: edge, width: 2, material: Cesium.Material.fromType('Color', { color: Cesium.Color.WHITE }) });
  outline.show = false;
  setExaggeration(exag);   // initialise modelMatrix (ENU frame, flat at exag 0)
}

export function setExaggeration(x) {
  exag = Math.max(x, 0);
  if (!prim) return;
  // scale floor avoids a singular matrix at exactly 0
  const m = Cesium.Matrix4.multiplyByScale(enu, new Cesium.Cartesian3(1, 1, Math.max(exag, 1e-3)), new Cesium.Matrix4());
  prim.modelMatrix = m;
  outline.modelMatrix = m;
}

export function tweenExaggeration(to, durationMs = ANIM_MS) {
  return new Promise((resolve) => {
    const from = exag, t0 = performance.now(), id = ++anim;
    const step = (now) => {
      if (id !== anim) return resolve();
      const f = Math.min((now - t0) / durationMs, 1);
      const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;   // ease-in-out cubic
      setExaggeration(from + (to - from) * e);
      if (f < 1) {
        requestAnimationFrame(step);
      } else {
        setExaggeration(to);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function tween(to, done) {
  tweenExaggeration(to, ANIM_MS).then(() => { if (done) done(); });
}

/** Build the mesh (hidden, flat) if needed, without showing it. */
export async function prepare() {
  if (!grid) await initTerrain(viewer);
  if (!prim) {
    ready ??= computeBaseHeight().then((h) => { baseHeight = h; build(); });
    await ready;
  }
}

/** Shows the slab flat (exaggeration = 0). */
export async function showFlat() {
  await prepare();
  setExaggeration(0);
  prim.show = outline.show = true;
}

/** Local ENU vertex positions [x,y,relief] per cell (row-major) and the unscaled ENU frame; null before prepare(). */
export const getFrame = () => (prim ? { pos: localPos, enu } : null);
/** Live local->world matrix (ENU frame * z-scale exaggeration). Same object until exaggeration changes. */
export const getMatrix = () => prim.modelMatrix;
export const getExaggeration = () => exag;

export async function show() {
  await prepare();
  prim.show = outline.show = true;
  tween(TARGET_EXAG);
}

export function hide() {
  if (!prim) return;
  tween(0, () => { prim.show = outline.show = false; });
}

export const isVisible = () => !!prim && prim.show;
