/**
 * web/js/roads.js
 * Visualizes the draped flood water layer, natural marshland basin,
 * and depth-colored road network on top of Google Photorealistic 3D Tiles / Terrain.
 *
 * Requirements:
 * 1. Animate exaggeration back to 0, fade out colored slab, keep only water & natural marsh.
 * 2. Drape water on Google 3D Tiles / Terrain as ground-classified polygons (merged runs per row),
 *    coloured by depth as before, at 0.75 opacity.
 * 3. Render Pallikaranai marshland as a natural low-lying wetland body (not as flooded roads).
 * 4. Color road segments by sampled flood depth:
 *    - < 15 cm : hidden
 *    - 15-30 cm: yellow (#ffeb3b)
 *    - 30-60 cm: orange (#ff9800)
 *    - > 60 cm : red    (#f44336)
 *    - Ground-clamped polylines, wider for trunk / primary roads (e.g. OMR, Radial Road).
 * 5. Export toggleWaterLayer(show), toggleRoadsLayer(show), initRoads(viewer).
 * 6. Compute live stat: "X km of road under more than 15 cm of water".
 * 7. Dynamic updateRainfall() re-runs pooling and updates layers in real time (<1s).
 */

import { grid, setExaggeration, hide as hideTerrain } from './terrain.js';
import { getWaterDepth, computePooling, hidePooling } from './pooling.js';

// Depth color categories for flooded roads
const COLOR_YELLOW = Cesium.Color.fromCssColorString('#ffeb3b'); // 15-30 cm
const COLOR_ORANGE = Cesium.Color.fromCssColorString('#ff9800'); // 30-60 cm
const COLOR_RED    = Cesium.Color.fromCssColorString('#f44336'); // > 60 cm

// Water classification polygon colors (shallow to deep)
const WATER_SHALLOW = Cesium.Color.fromCssColorString('#80d8ff').withAlpha(0.75);
const WATER_MID     = Cesium.Color.fromCssColorString('#00b0ff').withAlpha(0.75);
const WATER_DEEP    = Cesium.Color.fromCssColorString('#0d47a1').withAlpha(0.75);

// Natural marshland water body color (teal/wetland)
const MARSH_COLOR   = Cesium.Color.fromCssColorString('#00695c').withAlpha(0.65);

let viewer = null;
// Batched primitives (one draw batch each) instead of thousands of Entities.
let waterPrim = null;
let roadPrim = null;
let marshPrim = null;
let waterCount = 0;
let roadCount = 0;
let buildGeneration = 0; // bumps on every rebuild so stale async builds get discarded
let roadsData = null;
let marshData = null;

let isWaterLayerActive = true;
let isRoadsLayerActive = true;
let totalFloodedKm = 0.0;

/**
 * Great-circle distance between two lon/lat coordinates in metres.
 */
function haversineDistanceM(lon1, lat1, lon2, lat2) {
  const R = 6371008.8; // Earth radius in metres
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Quantize water depth to 8 bins to enable contiguous run merging per row.
 */
function getDepthBin(d) {
  if (d <= 0.08) return -1;
  if (d < 0.25) return 0;
  if (d < 0.60) return 1;
  if (d < 1.20) return 2;
  return 3;
}

function getWaterColorForDepth(d) {
  const t = Math.min(Math.max((d - 0.05) / 1.0, 0.0), 1.0);
  const colorScratch = new Cesium.Color();
  if (t < 0.5) {
    return Cesium.Color.lerp(WATER_SHALLOW, WATER_MID, t * 2.0, colorScratch);
  } else {
    return Cesium.Color.lerp(WATER_MID, WATER_DEEP, (t - 0.5) * 2.0, colorScratch);
  }
}

/**
 * Initializes the roads, marsh, and draped flood layers.
 */
export async function initRoads(v) {
  viewer = v;
  if (!roadsData) {
    const res = await fetch('data/roads.json');
    if (!res.ok) throw new Error(`Failed to load data/roads.json: HTTP ${res.status}`);
    roadsData = await res.json();
  }
  if (!marshData) {
    try {
      const res = await fetch('data/marsh.json');
      if (res.ok) {
        marshData = await res.json();
        renderMarshlandLayer();
      }
    } catch (e) {
      console.warn('Could not load marsh.json:', e);
    }
  }
}

/**
 * Renders the Pallikaranai marshland polygons as ONE batched ground primitive.
 */
function renderMarshlandLayer() {
  if (!viewer || !marshData || marshPrim) return;
  const instances = [];

  for (const feat of marshData.features || []) {
    const geom = feat.geometry;
    if (!geom || geom.type !== 'Polygon' || !geom.coordinates) continue;
    const coords = geom.coordinates[0];
    if (!coords || coords.length < 3) continue;

    const flatDegrees = [];
    for (const [lon, lat] of coords) flatDegrees.push(lon, lat);
    instances.push(new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flatDegrees)),
      }),
      attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(MARSH_COLOR) },
    }));
  }
  if (instances.length === 0) return;

  marshPrim = viewer.scene.primitives.add(new Cesium.GroundPrimitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
    classificationType: Cesium.ClassificationType.BOTH,
    releaseGeometryInstances: true,
    show: isWaterLayerActive,
  }));
}

/**
 * Samples water depth at a given lon/lat from the grid (nearest cell).
 */
export function getWaterDepthAt(lon, lat, depthArray) {
  if (!grid || !depthArray) return 0.0;
  const { west, east, south, north, cols, rows } = grid;
  if (lon < west || lon > east || lat < south || lat > north) return 0.0;

  const fc = ((lon - west) / (east - west)) * cols - 0.5;
  const fr = ((north - lat) / (north - south)) * rows - 0.5;

  const c = Math.max(0, Math.min(cols - 1, Math.round(fc)));
  const r = Math.max(0, Math.min(rows - 1, Math.round(fr)));
  return depthArray[r * cols + c] || 0.0;
}

/**
 * Adds `newPrim` and removes `oldPrim` only once the new one has finished its
 * off-thread geometry build, so the layer never blinks off during a rebuild.
 * If a newer rebuild started meanwhile, the stale primitive is discarded instead.
 */
function swapPrimitive(oldPrim, newPrim, generation, assign) {
  const scene = viewer.scene;
  scene.primitives.add(newPrim);
  assign(newPrim);
  const done = () => {
    if (generation !== buildGeneration) {
      if (!newPrim.isDestroyed()) scene.primitives.remove(newPrim);
    } else if (oldPrim && !oldPrim.isDestroyed()) {
      scene.primitives.remove(oldPrim);
    }
  };
  // readyPromise exists on Cesium 1.117 primitives; fall back to immediate swap.
  if (newPrim.readyPromise) newPrim.readyPromise.then(done, done);
  else done();
}

/**
 * Internal renderer: builds draped water rectangles and colored road polylines
 * from a computed depth array, as two batched primitives (not thousands of Entities).
 */
function renderDrapedLayers(depth, onStatsUpdate = null) {
  if (!viewer || !grid) return;

  const generation = ++buildGeneration;
  const { west, east, south, north, cols, rows } = grid;
  const dLon = (east - west) / cols;
  const dLat = (north - south) / rows;
  const halfLat = dLat * 0.5;

  // 1. Water: merged runs per row -> one GeometryInstance each, a single GroundPrimitive
  const waterInstances = [];
  for (let r = 0; r < rows; r++) {
    const lat = north - (r + 0.5) * dLat;
    let runStartCol = -1;
    let runBin = -1;
    let runSumDepth = 0;
    let runCount = 0;

    for (let c = 0; c <= cols; c++) {
      const d = c < cols ? depth[r * cols + c] : 0.0;
      const bin = getDepthBin(d);

      if (bin === runBin && bin !== -1) {
        runSumDepth += d;
        runCount++;
      } else {
        if (runBin !== -1 && runCount > 0) {
          const westDeg = west + runStartCol * dLon;
          const eastDeg = west + (runStartCol + runCount) * dLon;
          waterInstances.push(new Cesium.GeometryInstance({
            geometry: new Cesium.RectangleGeometry({
              rectangle: Cesium.Rectangle.fromDegrees(westDeg, lat - halfLat, eastDeg, lat + halfLat),
              vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                getWaterColorForDepth(runSumDepth / runCount)
              ),
            },
          }));
        }
        runBin = bin;
        runStartCol = c;
        runSumDepth = d;
        runCount = 1;
      }
    }
  }

  // 2. Roads: contiguous same-category runs -> one GroundPolylineGeometry each, one primitive
  totalFloodedKm = 0.0;
  const roadInstances = [];
  const colorFor = (cat) => (cat === 'yellow' ? COLOR_YELLOW : cat === 'orange' ? COLOR_ORANGE : COLOR_RED);

  if (roadsData) {
    for (const road of roadsData) {
      const coords = road.coords;
      if (!coords || coords.length < 2) continue;

      const isMajor = road.highway === 'primary' || road.highway === 'trunk' || road.highway === 'secondary';
      const baseWidth = isMajor ? 5.5 : 3.0;

      let currentCategory = null;
      let currentLinePositions = [];

      const flush = () => {
        if (currentLinePositions.length >= 4) {
          roadInstances.push(new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(currentLinePositions),
              width: baseWidth,
            }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorFor(currentCategory)) },
          }));
        }
      };

      for (let i = 0; i < coords.length - 1; i++) {
        const [lon1, lat1] = coords[i];
        const [lon2, lat2] = coords[i + 1];
        const d = getWaterDepthAt((lon1 + lon2) * 0.5, (lat1 + lat2) * 0.5, depth);

        const cat = d >= 0.60 ? 'red' : d >= 0.30 ? 'orange' : d >= 0.15 ? 'yellow' : null;

        if (cat) {
          totalFloodedKm += haversineDistanceM(lon1, lat1, lon2, lat2) / 1000.0;
          if (cat === currentCategory) {
            currentLinePositions.push(lon2, lat2);
          } else {
            flush();
            currentCategory = cat;
            currentLinePositions = [lon1, lat1, lon2, lat2];
          }
        } else {
          flush();
          currentCategory = null;
          currentLinePositions = [];
        }
      }
      flush();
    }
  }

  waterCount = waterInstances.length;
  roadCount = roadInstances.length;

  if (waterInstances.length > 0) {
    swapPrimitive(waterPrim, new Cesium.GroundPrimitive({
      geometryInstances: waterInstances,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
      classificationType: Cesium.ClassificationType.BOTH,
      releaseGeometryInstances: true,
      show: isWaterLayerActive,
    }), generation, (p) => { waterPrim = p; });
  } else if (waterPrim) {
    viewer.scene.primitives.remove(waterPrim);
    waterPrim = null;
  }

  if (roadInstances.length > 0 && Cesium.GroundPolylinePrimitive.isSupported(viewer.scene)) {
    swapPrimitive(roadPrim, new Cesium.GroundPolylinePrimitive({
      geometryInstances: roadInstances,
      appearance: new Cesium.PolylineColorAppearance({ translucent: false }),
      classificationType: Cesium.ClassificationType.BOTH,
      releaseGeometryInstances: true,
      show: isRoadsLayerActive,
    }), generation, (p) => { roadPrim = p; });
  } else if (roadPrim) {
    viewer.scene.primitives.remove(roadPrim);
    roadPrim = null;
  }

  if (onStatsUpdate) {
    onStatsUpdate({
      floodedRoadKm: totalFloodedKm.toFixed(2),
      waterEntities: waterCount,
      roadEntities: roadCount,
    });
  }
}

/**
 * Transition scene: eases vertical exaggeration to 0 over 2s,
 * removes terrain slab, keeps water layer, and renders draped flood features.
 */
export async function showRealMapScene({
  rainfallMm = 150,
  runoffCoeff = 0.8,
  onStatsUpdate = null,
} = {}) {
  clearDrapedLayers();

  // 1. Smoothly ease exaggeration to 0 over 2 seconds
  await new Promise((resolve) => {
    const t0 = performance.now();
    const duration = 2000;
    const initialExag = 10.0;

    function step(now) {
      const elapsed = now - t0;
      const progress = Math.min(elapsed / duration, 1.0);
      const eased = 1.0 - progress; // ease down to 0
      setExaggeration(initialExag * eased);

      if (progress < 1.0) {
        requestAnimationFrame(step);
      } else {
        setExaggeration(0);
        hideTerrain();
        hidePooling();
        resolve();
      }
    }
    requestAnimationFrame(step);
  });

  // 2. Ensure water depth is calculated
  let depth = getWaterDepth();
  if (!depth) {
    depth = await computePooling({ rainfallMm, runoffCoeff });
  }

  // 3. Render draped layers
  renderDrapedLayers(depth, onStatsUpdate);

  return {
    floodedRoadKm: totalFloodedKm,
    waterEntitiesCount: waterCount,
    roadEntitiesCount: roadCount,
  };
}

/**
 * Re-runs water pooling with new rainfall and re-drapes water and road layers
 * without transitioning the camera. Executes in <100ms.
 */
export async function updateRainfall({
  rainfallMm = 150,
  runoffCoeff = 0.8,
  onStatsUpdate = null,
} = {}) {
  const depth = await computePooling({ rainfallMm, runoffCoeff });
  renderDrapedLayers(depth, onStatsUpdate);

  return {
    floodedRoadKm: totalFloodedKm,
    waterEntitiesCount: waterCount,
    roadEntitiesCount: roadCount,
  };
}

/**
 * Toggles the draped water layer on Google 3D Tiles.
 */
export function toggleWaterLayer(show) {
  isWaterLayerActive = show !== undefined ? show : !isWaterLayerActive;
  if (waterPrim) waterPrim.show = isWaterLayerActive;
  if (marshPrim) marshPrim.show = isWaterLayerActive;
  return isWaterLayerActive;
}

/**
 * Toggles the flooded roads layer on Google 3D Tiles.
 */
export function toggleRoadsLayer(show) {
  isRoadsLayerActive = show !== undefined ? show : !isRoadsLayerActive;
  if (roadPrim) roadPrim.show = isRoadsLayerActive;
  return isRoadsLayerActive;
}

/**
 * Clears and removes the draped flood and road primitives.
 */
export function clearDrapedLayers() {
  buildGeneration++; // invalidate any in-flight async build
  if (viewer) {
    if (waterPrim && !waterPrim.isDestroyed()) viewer.scene.primitives.remove(waterPrim);
    if (roadPrim && !roadPrim.isDestroyed()) viewer.scene.primitives.remove(roadPrim);
  }
  waterPrim = null;
  roadPrim = null;
  waterCount = 0;
  roadCount = 0;
  totalFloodedKm = 0.0;
}

export function getFloodedRoadKm() {
  return totalFloodedKm;
}

export function isWaterVisible() {
  return isWaterLayerActive;
}

export function isRoadsVisible() {
  return isRoadsLayerActive;
}

/**
 * Update draped layers from a pre-computed depth array (time-step mode).
 * Skips the pooling worker — directly renders the given Float32Array.
 *
 * @param {Object} options
 * @param {Float32Array} options.depth - Water depth per cell in metres
 * @param {Function} [options.onStatsUpdate] - Callback with { floodedRoadKm }
 */
export async function updateFromDepth({ depth, onStatsUpdate = null } = {}) {
  if (!depth) return;
  renderDrapedLayers(depth, onStatsUpdate);
  return {
    floodedRoadKm: totalFloodedKm,
    waterEntitiesCount: waterCount,
    roadEntitiesCount: roadCount,
  };
}
