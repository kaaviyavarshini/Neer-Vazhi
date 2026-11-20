/**
 * web/js/pooling.js
 * Visualizes the water depth layer over the 10x exaggerated terrain slab.
 *
 * Runs pooling.worker.js off the main thread.
 * Draws cells with depth > 5 cm (0.05 m) as colored square primitives on the slab:
 * - Color: light blue (#80d8ff, shallow) to deep blue (#0d47a1, over 1 m).
 * - Animation: water level rises smoothly over 5 seconds.
 */

import { grid, getHeightAt, getExaggeration, getMatrix } from './terrain.js';

// Color gradient for water depth
// Shallow: #80d8ff (alpha 0.65) -> Deep: #0d47a1 (alpha 0.90)
const COLOR_SHALLOW = Cesium.Color.fromCssColorString('#80d8ff').withAlpha(0.65);
const COLOR_DEEP    = Cesium.Color.fromCssColorString('#0d47a1').withAlpha(0.90);
const COLOR_MID     = Cesium.Color.fromCssColorString('#0091ea').withAlpha(0.80);

const DEPTH_THRESHOLD_M = 0.05; // 5 cm threshold
const ANIM_DURATION_MS = 5000.0; // 5-second rise animation

let viewer = null;
let worker = null;
let currentPrimitive = null;
let waterDepthArray = null;
let animStartTime = 0;
let animReqId = null;

/**
 * Initializes the pooling subsystem and worker.
 */
export function initPooling(v) {
  viewer = v;
  if (!worker) {
    worker = new Worker('/js/pooling.worker.js', { type: 'module' });
  }
}

/**
 * Solves water pooling using the background Web Worker.
 *
 * @param {Object} options
 * @param {number} [options.rainfallMm=100] - Rainfall depth in mm
 * @param {number} [options.runoffCoeff=0.8] - Runoff coefficient
 * @returns {Promise<Float32Array>}
 */
export function computePooling({ rainfallMm = 100, runoffCoeff = 0.8 } = {}) {
  return new Promise((resolve, reject) => {
    if (!grid) {
      return reject(new Error('Terrain grid not initialized'));
    }

    if (!worker) {
      worker = new Worker('/js/pooling.worker.js', { type: 'module' });
    }

    const reqId = Date.now();

    const cleanup = () => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      clearTimeout(timeoutId);
    };

    const handleMessage = (e) => {
      if (e.data.id === reqId) {
        cleanup();
        if (e.data.status === 'ok') {
          waterDepthArray = e.data.depth;
          resolve(waterDepthArray);
        } else {
          reject(new Error(e.data.error || 'Pooling computation failed'));
        }
      }
    };

    const handleError = (err) => {
      cleanup();
      reject(err);
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Pooling calculation timed out'));
    }, 10000);

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    worker.postMessage({
      id: reqId,
      heights: grid.heights,
      cols: grid.cols,
      rows: grid.rows,
      cellSizeM: grid.cellSizeM || 30,
      rainfallMm,
      runoffCoeff,
    });
  });
}

/**
 * Renders the computed water depth onto the terrain slab, animating rise over 5s.
 */
export async function showPooling({ rainfallMm = 100, runoffCoeff = 0.8 } = {}) {
  hidePooling();

  console.log(`[Pooling] Computing water model: ${rainfallMm} mm rain (C=${runoffCoeff})...`);
  const depth = await computePooling({ rainfallMm, runoffCoeff });

  const { west, east, south, north, cols, rows, heights } = grid;
  const dLon = (east - west) / cols;
  const dLat = (north - south) / rows;
  const halfLon = dLon * 0.48;
  const halfLat = dLat * 0.48;

  // Identify all flooded cells with depth > 5 cm
  const wetCells = [];
  for (let r = 0; r < rows; r++) {
    const lat = north - (r + 0.5) * dLat;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const d = depth[idx];
      if (d > DEPTH_THRESHOLD_M) {
        const lon = west + (c + 0.5) * dLon;
        wetCells.push({
          idx,
          lon,
          lat,
          baseH: heights[idx],
          maxDepth: d,
        });
      }
    }
  }

  console.log(`[Pooling] Flooded cells (>5cm): ${wetCells.length} / ${cols * rows}`);

  if (wetCells.length === 0) return;

  // Build instanced point collection / geometric quads for water cells
  const instances = [];
  const colorScratch = new Cesium.Color();

  for (let i = 0; i < wetCells.length; i++) {
    const cell = wetCells[i];
    const t = Math.min(Math.max((cell.maxDepth - 0.05) / 1.0, 0.0), 1.0); // 0 at 5cm, 1 at >= 1.0m

    // Lerp from light blue (shallow) to deep blue (>1m)
    let cellColor;
    if (t < 0.5) {
      cellColor = Cesium.Color.lerp(COLOR_SHALLOW, COLOR_MID, t * 2.0, colorScratch);
    } else {
      cellColor = Cesium.Color.lerp(COLOR_MID, COLOR_DEEP, (t - 0.5) * 2.0, colorScratch);
    }

    const rect = Cesium.Rectangle.fromDegrees(
      cell.lon - halfLon,
      cell.lat - halfLat,
      cell.lon + halfLon,
      cell.lat + halfLat
    );

    // Initial ground geometry
    instances.push(new Cesium.GeometryInstance({
      geometry: new Cesium.RectangleGeometry({
        rectangle: rect,
        height: 0, // Animated dynamically
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(cellColor),
      },
      id: cell,
    }));
  }

  // Create single Cesium Primitive with PerInstanceColorAppearance
  // Note: For real-time animated vertical rise, we use PointPrimitiveCollection or PolylineCollection
  // Here we use PointPrimitiveCollection with square/disc markers on the exaggerated surface
  const pointCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection({
    blendOption: Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT,
  }));
  currentPrimitive = pointCollection;

  const points = [];
  for (let i = 0; i < wetCells.length; i++) {
    const cell = wetCells[i];
    const t = Math.min(Math.max((cell.maxDepth - 0.05) / 1.0, 0.0), 1.0);

    let cellColor = new Cesium.Color();
    if (t < 0.5) {
      Cesium.Color.lerp(COLOR_SHALLOW, COLOR_MID, t * 2.0, cellColor);
    } else {
      Cesium.Color.lerp(COLOR_MID, COLOR_DEEP, (t - 0.5) * 2.0, cellColor);
    }

    const pt = pointCollection.add({
      position: Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat, 0),
      color: cellColor,
      pixelSize: 6.0,
      show: true,
    });
    points.push({ pt, cell });
  }

  // Animate water rise over 5 seconds
  animStartTime = performance.now();
  const exag = getExaggeration() || 10.0;
  const scratchPos = new Cesium.Cartesian3();

  function animateRise(now) {
    const elapsed = now - animStartTime;
    const progress = Math.min(elapsed / ANIM_DURATION_MS, 1.0);
    // Smooth quadratic ease-out
    const eased = 1.0 - (1.0 - progress) * (1.0 - progress);

    for (let i = 0; i < points.length; i++) {
      const { pt, cell } = points[i];
      const curDepth = cell.maxDepth * eased;
      // Exaggerated elevation: (baseTerrain + waterDepth) * exaggeration
      const elev = (cell.baseH + curDepth) * exag + 0.5;

      Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat, elev, Cesium.Ellipsoid.WGS84, scratchPos);
      pt.position = scratchPos;
      // Expand point size as depth grows
      pt.pixelSize = 5.0 + Math.min(cell.maxDepth * 4.0, 8.0);
    }

    if (progress < 1.0) {
      animReqId = requestAnimationFrame(animateRise);
    }
  }

  animReqId = requestAnimationFrame(animateRise);
}

/**
 * Hides and removes the water layer.
 */
export function hidePooling() {
  if (animReqId) {
    cancelAnimationFrame(animReqId);
    animReqId = null;
  }
  if (currentPrimitive) {
    viewer.scene.primitives.remove(currentPrimitive);
    currentPrimitive = null;
  }
}

/**
 * Gets raw water depth array from last computation.
 * @returns {Float32Array|null}
 */
export function getWaterDepth() {
  return waterDepthArray;
}
