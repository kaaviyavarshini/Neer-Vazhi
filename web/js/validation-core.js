/**
 * web/js/validation-core.js
 * Pure scoring of model water depth against known waterlogging points.
 * Works in the browser and Node. Scoring only: never feeds back into the model.
 *
 * Grid convention (same as pooling.js / roads.js): row-major, row 0 = north.
 * Units: metres, WGS84 lon/lat.
 */

export const HIT_DEPTH_M = 0.15; // "waterlogged" = more than 15 cm

/**
 * Deepest model water within one cell (the 3x3 block) of a lon/lat.
 * Locations in the source data are approximate, hence the neighbourhood.
 * Returns null if the point is outside the grid.
 */
export function maxDepthNear(depth, grid, lon, lat) {
  const { west, east, south, north, cols, rows } = grid;
  const c0 = Math.floor(((lon - west) / (east - west)) * cols);
  const r0 = Math.floor(((north - lat) / (north - south)) * rows);
  if (c0 < 0 || c0 >= cols || r0 < 0 || r0 >= rows) return null;
  let best = 0;
  for (let r = Math.max(0, r0 - 1); r <= Math.min(rows - 1, r0 + 1); r++) {
    for (let c = Math.max(0, c0 - 1); c <= Math.min(cols - 1, c0 + 1); c++) {
      const d = depth[r * cols + c];
      if (d > best) best = d;
    }
  }
  return best;
}

/**
 * @param {Array} points  validation.json records
 * @param {Float32Array} depth  model water depth (m)
 * @param {Object} grid  {west,east,south,north,cols,rows}
 * @returns {{hits,misses,total,hitRate,wetPct,depthErrCm,depthN,perPoint}}
 *   hitRate and wetPct are percentages (0-100). depthErrCm is the mean absolute
 *   difference (cm) between model depth (3x3 max) and reported depth, over the
 *   points that have a reported depth (null if none).
 */
export function scorePoints(points, depth, grid) {
  let hits = 0, errSum = 0, errN = 0;
  const perPoint = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const m = maxDepthNear(depth, grid, p.lon, p.lat);
    const hit = m !== null && m > HIT_DEPTH_M;
    if (hit) hits++;
    if (m !== null && p.reportedDepthM != null) {
      errSum += Math.abs(m - p.reportedDepthM) * 100;
      errN++;
    }
    perPoint[i] = { hit, modelDepthM: m };
  }
  const total = points.length;
  let wet = 0;
  for (let i = 0; i < depth.length; i++) if (depth[i] > HIT_DEPTH_M) wet++;
  return {
    hits,
    misses: total - hits,
    total,
    hitRate: total ? (100 * hits) / total : 0,
    wetPct: (100 * wet) / depth.length,
    depthErrCm: errN ? errSum / errN : null,
    depthN: errN,
    perPoint,
  };
}

/**
 * Compares model wet cells (> 15 cm) with the GCC flood-zone map rasterised on the
 * same grid (validation_zones.json). Scoring only.
 *  highCaught  : % of Very High + High zone cells the model floods
 *  lowFlooded  : % of Very Low zone cells the model floods (false alarms; lower is better)
 *  wetInHigh   : % of all wet cells that sit in Very High + High zones
 */
export function scoreZones(depth, zones) {
  const codes = zones.codes;
  let hi = 0, hiWet = 0, lo = 0, loWet = 0, wet = 0, wetHi = 0;
  for (let i = 0; i < depth.length; i++) {
    const c = codes.charCodeAt(i) - 48, w = depth[i] > HIT_DEPTH_M;
    if (w) wet++;
    if (c === 1 || c === 2) { hi++; if (w) { hiWet++; wetHi++; } }
    else if (c === 5) { lo++; if (w) loWet++; }
  }
  return {
    highCaught: hi ? (100 * hiWet) / hi : 0,
    lowFlooded: lo ? (100 * loWet) / lo : 0,
    wetInHigh: wet ? (100 * wetHi) / wet : 0,
  };
}
