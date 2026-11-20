/**
 * web/js/rain.js
 * High-performance raindrop simulation over exaggerated terrain slab.
 *
 * Requirements:
 * - Spawn N drops ("drops" in area.json, default 3000) at random grid cells.
 * - Phase 1 (falling): falls from 400 m above the slab to its surface.
 * - Phase 2 (rolling): D8 steepest descent, sliding smoothly between cell centres
 *   at ~1 cell per 80 ms, like a marble. Stops in a pit or grid edge, then respawns.
 * - Draw drops as small light-blue points on exaggerated surface (via terrain height).
 * - Keep Uint32Array of arrivals per cell.
 * - Export getArrivals(), start(), stop().
 * - Single PointPrimitiveCollection, requestAnimationFrame, zero allocations in loop.
 * - Measure & report FPS (Target: >= 45 FPS).
 */

import { grid, getHeightAt, getExaggeration, getMatrix } from './terrain.js';

// Configuration constants
const FALL_ALTITUDE_M = 400.0;
const FALL_SPEED_MPS = 500.0;     // Metres per second vertical fall
const ROLL_MS_PER_CELL = 80.0;    // ~80 ms to cross one cell
const SETTLE_DURATION_MS = 600.0; // Stay in pit briefly before respawn

// Colors (preallocated)
const COLOR_FALLING = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.9);
const COLOR_ROLLING = Cesium.Color.fromCssColorString('#80d8ff').withAlpha(0.95);
const COLOR_POOLED  = Cesium.Color.fromCssColorString('#00b0ff').withAlpha(0.95);

// Simulation State
let viewer = null;
let pointCollection = null;
let numDrops = 3000;
let isRunning = false;
let animFrameId = null;
let lastTimestamp = 0;

// Precomputed D8 Flow Graph & Surface Lookup
let d8NextCell = null;   // Int32Array(cols * rows) -> index of downhill neighbor, or -1
let arrivals = null;     // Uint32Array(cols * rows) -> counts of drops trapped per cell
let cellCoords = null;   // Float64Array(cols * rows * 2) -> precalculated [lon, lat] per cell

// Pre-allocated Particle State Arrays (Length = numDrops)
let pPhase = null;       // Uint8Array: 0=inactive, 1=falling, 2=rolling, 3=settling
let pCurrR = null;       // Int16Array
let pCurrC = null;       // Int16Array
let pNextR = null;       // Int16Array
let pNextC = null;       // Int16Array
let pFallH = null;       // Float32Array: current drop altitude offset above surface (m)
let pRollT = null;       // Float32Array: progress along current cell-to-cell segment [0, 1]
let pSettleT = null;     // Float32Array: elapsed time settled in pit (ms)

// Reusable scratch objects (Strictly zero allocations in frame loop)
const scratchPosCartographic = new Cesium.Cartographic();
const scratchCartesian3 = new Cesium.Cartesian3();

// FPS Telemetry
let fps = 60.0;
let frameCount = 0;
let fpsLastTime = 0;

/**
 * Precomputes D8 steepest descent lookup table for every cell.
 */
function buildD8Graph() {
  const { cols, rows, heights } = grid;
  const n = cols * rows;
  d8NextCell = new Int32Array(n);
  arrivals = new Uint32Array(n);
  cellCoords = new Float64Array(n * 2);

  const { west, east, south, north } = grid;
  const dLon = (east - west) / cols;
  const dLat = (north - south) / rows;

  // Precalculate cell center geographic coordinates
  for (let r = 0; r < rows; r++) {
    const lat = north - (r + 0.5) * dLat;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      cellCoords[idx * 2]     = west + (c + 0.5) * dLon;
      cellCoords[idx * 2 + 1] = lat;
    }
  }

  // D8 neighbor offsets (dr, dc, distance metric)
  const SQRT2 = Math.SQRT2;
  const neighbors = [
    [-1,  0, 1.0],   // North
    [ 1,  0, 1.0],   // South
    [ 0, -1, 1.0],   // West
    [ 0,  1, 1.0],   // East
    [-1, -1, SQRT2], // North-West
    [-1,  1, SQRT2], // North-East
    [ 1, -1, SQRT2], // South-West
    [ 1,  1, SQRT2], // South-East
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const h0 = heights[idx];

      let maxSlope = 0.0;
      let steepestIdx = -1;

      // Outer boundary drops leave grid
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) {
        d8NextCell[idx] = -1;
        continue;
      }

      for (let i = 0; i < 8; i++) {
        const nr = r + neighbors[i][0];
        const nc = c + neighbors[i][1];
        const dist = neighbors[i][2];
        const nIdx = nr * cols + nc;
        const hn = heights[nIdx];
        const slope = (h0 - hn) / dist;

        if (slope > maxSlope) {
          maxSlope = slope;
          steepestIdx = nIdx;
        }
      }

      // If maxSlope <= 0, cell is a local sink/pit
      d8NextCell[idx] = maxSlope > 0 ? steepestIdx : -1;
    }
  }
}

/**
 * Respawns a particle at a random grid cell.
 */
function spawnDrop(i) {
  const { cols, rows } = grid;
  const r = 1 + Math.floor(Math.random() * (rows - 2));
  const c = 1 + Math.floor(Math.random() * (cols - 2));

  pCurrR[i] = r;
  pCurrC[i] = c;
  pNextR[i] = r;
  pNextC[i] = c;
  pFallH[i] = FALL_ALTITUDE_M;
  pRollT[i] = 0.0;
  pSettleT[i] = 0.0;
  pPhase[i] = 1; // Falling phase

  const pt = pointCollection.get(i);
  pt.color = COLOR_FALLING;
  pt.pixelSize = 4.0;
  pt.show = true;
}

/**
 * Initializes the rain subsystem.
 */
export async function initRain(v, dropCount = 3000) {
  viewer = v;
  numDrops = dropCount;

  if (!grid) {
    throw new Error('terrain.grid must be initialized before initRain');
  }

  buildD8Graph();

  // Allocate particle typed arrays
  pPhase = new Uint8Array(numDrops);
  pCurrR = new Int16Array(numDrops);
  pCurrC = new Int16Array(numDrops);
  pNextR = new Int16Array(numDrops);
  pNextC = new Int16Array(numDrops);
  pFallH = new Float32Array(numDrops);
  pRollT = new Float32Array(numDrops);
  pSettleT = new Float32Array(numDrops);

  // Initialize PointPrimitiveCollection
  if (pointCollection) {
    viewer.scene.primitives.remove(pointCollection);
  }

  pointCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection({
    blendOption: Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT,
  }));

  for (let i = 0; i < numDrops; i++) {
    pointCollection.add({
      position: Cesium.Cartesian3.ZERO,
      color: COLOR_FALLING,
      pixelSize: 4.0,
      show: false,
    });
  }

  return true;
}

/**
 * Main simulation step executed every animation frame.
 */
function tick(timestamp) {
  if (!isRunning) return;

  if (!lastTimestamp) lastTimestamp = timestamp;
  const dtMs = Math.min(timestamp - lastTimestamp, 100.0); // Clamp delta
  lastTimestamp = timestamp;

  // FPS tracking
  frameCount++;
  if (timestamp - fpsLastTime >= 1000.0) {
    fps = Math.round((frameCount * 1000.0) / (timestamp - fpsLastTime));
    frameCount = 0;
    fpsLastTime = timestamp;
  }

  const { cols, rows } = grid;
  const currentExag = getExaggeration() || 1.0;
  const rollStep = dtMs / ROLL_MS_PER_CELL;
  const fallStep = (FALL_SPEED_MPS * dtMs) / 1000.0;

  for (let i = 0; i < numDrops; i++) {
    const phase = pPhase[i];
    if (phase === 0) continue;

    let pt = pointCollection.get(i);

    // ── Phase 1: Falling ───────────────────────────────────────────
    if (phase === 1) {
      pFallH[i] -= fallStep;
      const currIdx = pCurrR[i] * cols + pCurrC[i];
      const lon = cellCoords[currIdx * 2];
      const lat = cellCoords[currIdx * 2 + 1];

      // Base terrain surface height
      const rawH = getHeightAt(lon, lat) ?? 0.0;
      const surfaceH = rawH * currentExag;

      if (pFallH[i] <= 0.0) {
        // Impact ground -> transition to rolling
        pFallH[i] = 0.0;
        pPhase[i] = 2; // Rolling
        pt.color = COLOR_ROLLING;
        pt.pixelSize = 3.5;

        // Choose next downhill cell
        const nextIdx = d8NextCell[currIdx];
        if (nextIdx !== -1) {
          pNextR[i] = Math.floor(nextIdx / cols);
          pNextC[i] = nextIdx % cols;
          pRollT[i] = 0.0;
        } else {
          // Immediately a pit
          pPhase[i] = 3;
          arrivals[currIdx]++;
          pt.color = COLOR_POOLED;
        }
      }

      // Compute visual Cartesian3 position
      Cesium.Cartesian3.fromDegrees(lon, lat, surfaceH + pFallH[i], Cesium.Ellipsoid.WGS84, scratchCartesian3);
      pt.position = scratchCartesian3;
      continue;
    }

    // ── Phase 2: Rolling (D8 Steepest Descent) ──────────────────────
    if (phase === 2) {
      pRollT[i] += rollStep;
      const cIdx = pCurrR[i] * cols + pCurrC[i];
      const nIdx = pNextR[i] * cols + pNextC[i];

      const cLon = cellCoords[cIdx * 2];
      const cLat = cellCoords[cIdx * 2 + 1];
      const nLon = cellCoords[nIdx * 2];
      const nLat = cellCoords[nIdx * 2 + 1];

      if (pRollT[i] >= 1.0) {
        // Reached destination cell center
        pCurrR[i] = pNextR[i];
        pCurrC[i] = pNextC[i];
        const arrivedIdx = pCurrR[i] * cols + pCurrC[i];
        const nextDownhill = d8NextCell[arrivedIdx];

        if (nextDownhill !== -1) {
          pNextR[i] = Math.floor(nextDownhill / cols);
          pNextC[i] = nextDownhill % cols;
          pRollT[i] = pRollT[i] - 1.0;
        } else {
          // Trapped in a sink/pit or exited boundary
          pPhase[i] = 3; // Settling
          pSettleT[i] = 0.0;
          arrivals[arrivedIdx]++;
          pt.color = COLOR_POOLED;
          pt.pixelSize = 4.0;
        }
      }

      // Smooth interpolation along segment
      const t = Math.min(Math.max(pRollT[i], 0.0), 1.0);
      const curLon = cLon + t * (nLon - cLon);
      const curLat = cLat + t * (nLat - cLat);
      const rawH = getHeightAt(curLon, curLat) ?? 0.0;
      const surfaceH = rawH * currentExag + 0.3; // Slight positive bias to avoid z-fighting

      Cesium.Cartesian3.fromDegrees(curLon, curLat, surfaceH, Cesium.Ellipsoid.WGS84, scratchCartesian3);
      pt.position = scratchCartesian3;
      continue;
    }

    // ── Phase 3: Settled in Pit ────────────────────────────────────
    if (phase === 3) {
      pSettleT[i] += dtMs;
      if (pSettleT[i] >= SETTLE_DURATION_MS) {
        // Respawn elsewhere on the grid
        spawnDrop(i);
      }
    }
  }

  animFrameId = requestAnimationFrame(tick);
}

/**
 * Starts the rain simulation.
 */
export function start() {
  if (isRunning) return;
  isRunning = true;
  lastTimestamp = 0;
  fpsLastTime = performance.now();
  frameCount = 0;

  // Stagger drop spawning initially across drops
  for (let i = 0; i < numDrops; i++) {
    spawnDrop(i);
    // Disperse initial heights between 0 and 400m
    pFallH[i] = Math.random() * FALL_ALTITUDE_M;
  }

  animFrameId = requestAnimationFrame(tick);
  console.log(`[Rain] Started simulation with ${numDrops} drops.`);
}

/**
 * Stops the rain simulation.
 */
export function stop() {
  isRunning = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (pointCollection) {
    for (let i = 0; i < numDrops; i++) {
      pointCollection.get(i).show = false;
      pPhase[i] = 0;
    }
  }
  console.log('[Rain] Stopped simulation.');
}

/**
 * Whether the rain simulation is currently running.
 * Exposed as a function because `isRunning` is a mutable module-local binding.
 * @returns {boolean}
 */
export function isRainRunning() {
  return isRunning;
}

/**
 * Returns the cell accumulation counts.
 * @returns {Uint32Array}
 */
export function getArrivals() {
  return arrivals;
}

/**
 * Returns current rendering FPS.
 * @returns {number}
 */
export function getFps() {
  return fps;
}
