/**
 * web/js/workers/rain-worker.js
 * Web Worker — runs the particle physics loop off the main thread.
 * Uses only typed arrays; no DOM, no Cesium.
 *
 * Particle state (all Float32Arrays, N elements each):
 *   lon, lat, alt   – WGS84 degrees / metres above WGS84 ellipsoid
 *   vlon, vlat, valt – velocity in deg/s, deg/s, m/s
 *   pooled           – 0 = falling/rolling, 1 = pooled (Uint8Array)
 *   stuckTicks       – how many ticks the particle hasn't moved (Uint16Array)
 *
 * Heights are queried from a simple grid DEM (bilinear interpolation).
 *
 * Datum note:
 *   DEM heights are EGM2008-referenced orthometric.
 *   For visualisation we treat them as metres above the WGS84 ellipsoid —
 *   the geoid undulation in this region is ~-96 m but we do NOT apply it
 *   because Cesium's Google tiles already render at ellipsoid height; this
 *   offset would just shift all points downward uniformly, which is visually
 *   unimportant for a 10×-exaggerated artistic demo.
 */

const MAX_PARTICLES = 4000;
const G_ALT = -9.8;          // m/s² gravity component (vertical)
const DT    = 1.0;            // seconds per tick (simulation)
const POOL_TICKS = 12;        // ticks without motion → pooled
const FALL_ALT   = 80;        // metres above terrain to spawn drops

// ── State arrays ────────────────────────────────────────────────────────────
const lon    = new Float32Array(MAX_PARTICLES);
const lat    = new Float32Array(MAX_PARTICLES);
const alt    = new Float32Array(MAX_PARTICLES);
const valt   = new Float32Array(MAX_PARTICLES);   // m/s vertical
const pooled = new Uint8Array  (MAX_PARTICLES);
const stuck  = new Uint16Array (MAX_PARTICLES);
let   nParts = 0;

// ── DEM grid ────────────────────────────────────────────────────────────────
let dem = null;   // { cols, rows, west, south, cellLon, cellLat, heights Float32Array }

// ── Config ───────────────────────────────────────────────────────────────────
let cfg    = null;
let bbox   = null;

// ── Helper: sample DEM at lon/lat (bilinear) ─────────────────────────────────
function sampleH(lo, la) {
  if (!dem) return 5;
  const ci = (lo - dem.west)  / dem.cellLon - 0.5;
  const ri = (la - dem.south) / dem.cellLat - 0.5;
  const c0 = Math.max(0, Math.min(dem.cols - 2, Math.floor(ci)));
  const r0 = Math.max(0, Math.min(dem.rows - 2, Math.floor(ri)));
  const fc = ci - c0, fr = ri - r0;
  const h00 = dem.heights[ r0      * dem.cols + c0     ];
  const h10 = dem.heights[ r0      * dem.cols + c0 + 1 ];
  const h01 = dem.heights[(r0 + 1) * dem.cols + c0     ];
  const h11 = dem.heights[(r0 + 1) * dem.cols + c0 + 1 ];
  return h00 * (1-fc) * (1-fr) + h10 * fc * (1-fr)
       + h01 * (1-fc) * fr     + h11 * fc * fr;
}

// Gradient (central differences) in lon/lat degree-space → returns [dh/dlon, dh/dlat]
function gradient(lo, la) {
  const eps = 0.0002;   // ~22 m at equator
  return [
    (sampleH(lo + eps, la) - sampleH(lo - eps, la)) / (2 * eps),
    (sampleH(lo, la + eps) - sampleH(lo, la - eps)) / (2 * eps),
  ];
}

// ── Build synthetic DEM ───────────────────────────────────────────────────────
function buildSyntheticDem(bb) {
  const cols = 60, rows = 50;
  const cellLon = (bb.east - bb.west)   / cols;
  const cellLat = (bb.north - bb.south) / rows;
  const heights = new Float32Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lo = bb.west  + (c + 0.5) * cellLon;
      const la = bb.south + (r + 0.5) * cellLat;

      let h = 6 + (la - bb.south) / (bb.north - bb.south) * 4;

      // Pallikaranai marsh depression
      const dLon = (lo - 80.218) / 0.03;
      const dLat = (la - 12.918) / 0.025;
      const dist  = Math.sqrt(dLon * dLon + dLat * dLat);
      if (dist < 1) h -= 3.5 * Math.pow(1 - dist, 1.8);

      // OMR road ridge
      const roadD = Math.abs(lo - 80.233) / 0.004;
      if (roadD < 1) h += 1.2 * Math.pow(1 - roadD, 2);

      // Perungudi low-lying
      const pD = Math.sqrt(Math.pow((lo-80.247)/0.015,2) + Math.pow((la-12.934)/0.015,2));
      if (pD < 1) h -= 2 * Math.pow(1 - pD, 1.5);

      // Thoraipakkam hollow
      const tD = Math.sqrt(Math.pow((lo-80.223)/0.012,2) + Math.pow((la-12.912)/0.012,2));
      if (tD < 1) h -= 1.5 * Math.pow(1 - tD, 1.5);

      h += 0.3 * Math.sin(lo * 500) * Math.cos(la * 400);
      heights[r * cols + c] = Math.max(0, h);
    }
  }
  return { cols, rows, west: bb.west, south: bb.south, cellLon, cellLat, heights };
}

// ── Spawn particles ───────────────────────────────────────────────────────────
function spawnParticles(count) {
  const bb = bbox;
  for (let i = 0; i < count && nParts < MAX_PARTICLES; i++) {
    const lo = bb.west  + Math.random() * (bb.east  - bb.west);
    const la = bb.south + Math.random() * (bb.north - bb.south);
    const h  = sampleH(lo, la);

    lon[nParts]    = lo;
    lat[nParts]    = la;
    alt[nParts]    = h + FALL_ALT;   // spawn above terrain
    valt[nParts]   = 0;
    pooled[nParts] = 0;
    stuck[nParts]  = 0;
    nParts++;
  }
}

// ── Physics tick ─────────────────────────────────────────────────────────────
function tick() {
  for (let i = 0; i < nParts; i++) {
    if (pooled[i]) continue;

    const terrH = sampleH(lon[i], lat[i]);
    const above  = alt[i] - terrH;

    if (above > 0.5) {
      // ── Falling phase ──────────────────────────────────────────────────
      valt[i] += G_ALT * DT;
      alt[i]  += valt[i] * DT;
      if (alt[i] < terrH) { alt[i] = terrH; valt[i] = 0; }
    } else {
      // ── Rolling phase: follow steepest descent ────────────────────────
      alt[i] = terrH;
      valt[i] = 0;

      const [gLon, gLat] = gradient(lon[i], lat[i]);
      // Speed proportional to slope; convert deg-gradient to movement
      // 1 degree lat ≈ 111 000 m; 1 degree lon ≈ 111 000 * cos(lat) m
      const cosLat = Math.cos(lat[i] * Math.PI / 180);
      const speed  = 0.0000015;   // deg/tick — tuned for visual appeal
      const mag    = Math.sqrt(gLon * gLon + gLat * gLat) + 1e-9;

      lon[i] -= (gLon / mag) * speed;
      lat[i] -= (gLat / mag) * speed;

      // Clamp to bbox
      lon[i] = Math.max(bbox.west,  Math.min(bbox.east,  lon[i]));
      lat[i] = Math.max(bbox.south, Math.min(bbox.north, lat[i]));

      // Check stall
      if (mag < 0.0001) {
        stuck[i]++;
        if (stuck[i] > POOL_TICKS) pooled[i] = 1;
      } else {
        stuck[i] = 0;
      }
    }
  }
}

// ── Compose & post frame ─────────────────────────────────────────────────────
function postFrame() {
  const positions = new Float32Array(nParts * 3);
  const pooledOut = new Uint8Array(nParts);
  let   active    = 0;

  for (let i = 0; i < nParts; i++) {
    positions[i * 3]     = lon[i];
    positions[i * 3 + 1] = lat[i];
    positions[i * 3 + 2] = alt[i];
    pooledOut[i]          = pooled[i];
    if (!pooled[i]) active++;
  }

  self.postMessage({
    type:      'frame',
    positions,
    pooled:    pooledOut,
    active,
    addedMm:   0.05,   // ~0.1 mm per tick, artistic
  }, [positions.buffer, pooledOut.buffer]);
}

// ── Message handler ──────────────────────────────────────────────────────────
self.onmessage = function(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      cfg  = msg.cfg;
      bbox = cfg.bbox;
      if (msg.demData?.heights) {
        dem = msg.demData;
        // Ensure heights is Float32Array (may arrive as plain array after transfer)
        if (!(dem.heights instanceof Float32Array)) {
          dem.heights = new Float32Array(dem.heights);
        }
      } else {
        dem = buildSyntheticDem(bbox);
      }
      break;

    case 'spawn':
      spawnParticles(msg.count ?? 100);
      break;

    case 'tick':
      tick();
      postFrame();
      break;
  }
};
