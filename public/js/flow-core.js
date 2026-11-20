/**
 * web/js/flow-core.js
 * Pure time-stepping shallow-water model (no DOM, no imports).
 * Runs inside a Web Worker and in Node.js tests.
 *
 * Algorithm (per sub-step):
 *  1. Add rain × runoffCoeff uniformly to every cell.
 *  2. For each interior cell: move water towards lower neighbours
 *     proportional to water-surface height difference, capped so it
 *     cannot reverse the slope or drain more than the cell holds.
 *  3. Drain outlet cells (unless marshFull).
 *
 * State shape:
 *   { depth: Float32Array, heights: Float32Array,
 *     cols: number, rows: number, totalRainMm: number }
 *
 * Memory budget: snapshots are stored as Float32Array per hour.
 * If cumulative byte count > MAX_SNAPSHOT_BYTES, only every 2nd hour
 * is kept (downsample by step=2 is applied from that point forward).
 */

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Initialise simulation state.
 * @param {Float32Array} heights - Terrain elevation per cell (m), row-major
 * @param {number} cols
 * @param {number} rows
 * @returns {Object} state
 */
export function initFlowState(heights, cols, rows) {
  return {
    depth: new Float32Array(cols * rows),
    heights: heights instanceof Float32Array ? heights : new Float32Array(heights),
    cols,
    rows,
    totalRainMm: 0,
  };
}

/**
 * Advance state by one hour (internally split into subSteps sub-steps).
 * Mutates state.depth in place.
 *
 * @param {Object}  state
 * @param {number}  rainMm        - Rainfall for this hour in mm
 * @param {number}  runoffCoeff   - Runoff coefficient (0–1)
 * @param {Array}   outletCells   - Array of flat indices that drain freely
 * @param {number}  [subSteps=60] - Sub-steps per hour
 * @param {boolean} [marshFull]   - If true, outlet is blocked
 */
export function stepHour(state, rainMm, runoffCoeff, outletCells, subSteps = 60, marshFull = false) {
  const { depth, heights, cols, rows } = state;
  const n = cols * rows;

  // Rain added per sub-step (m)
  const rainPerStep = (rainMm / 1000.0) * runoffCoeff / subSteps;

  // 4-neighbourhood offsets (row-major flat index)
  const N4 = [-cols, +cols, -1, +1];

  // Outlet set for O(1) lookup
  const outletSet = new Set(outletCells);

  for (let s = 0; s < subSteps; s++) {
    // 1. Add rain everywhere
    for (let i = 0; i < n; i++) {
      depth[i] += rainPerStep;
    }

    // 2. Route water to lower neighbours
    // We use a simple explicit scheme: iterate cells in row-major order,
    // compute transfer fraction from water-surface difference.
    // Transfer coefficient α = 0.25 keeps the scheme stable (limits flux to
    // 1/4 of the surplus per sub-step, one direction at a time).
    const ALPHA = 0.25;

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (depth[i] <= 0) continue;

        const ws_i = heights[i] + depth[i]; // water surface at i

        for (let k = 0; k < 4; k++) {
          const j = i + N4[k];
          // Guard against row wrap-around for horizontal neighbours
          if (k >= 2) { // left / right
            const jc = j % cols;
            if (jc < 0 || jc >= cols) continue;
          }

          const ws_j = heights[j] + depth[j];
          const diff = ws_i - ws_j;
          if (diff <= 0) continue; // j is higher or equal, skip

          // Transfer: fraction of depth proportional to difference,
          // but no more than half of depth[i] per sub-step
          const transfer = Math.min(ALPHA * diff, depth[i] * 0.5);
          depth[i] -= transfer;
          depth[j] += transfer;
        }
      }
    }

    // 3. Drain outlets
    if (!marshFull && outletSet.size > 0) {
      for (const idx of outletSet) {
        depth[idx] = 0;
      }
    }

    // 4. Clamp negatives (floating-point underflow guard)
    for (let i = 0; i < n; i++) {
      if (depth[i] < 0) depth[i] = 0;
    }
  }

  state.totalRainMm += rainMm;
}

/**
 * Returns a snapshot (copy) of the current depth array.
 * @param {Object} state
 * @returns {Float32Array}
 */
export function getSnapshot(state) {
  return new Float32Array(state.depth);
}

/**
 * Run the full simulation for a rain series, returning hourly snapshots.
 * Automatically downsamples to every 2nd hour if memory > MAX_SNAPSHOT_BYTES.
 *
 * @param {Object} options
 * @param {Float32Array} options.heights
 * @param {number}       options.cols
 * @param {number}       options.rows
 * @param {number[]}     options.rainSeries   - mm per hour array
 * @param {number}       [options.runoffCoeff=0.8]
 * @param {number[]}     [options.outletCells=[]]
 * @param {number}       [options.subSteps=60]
 * @param {boolean}      [options.marshFull=false]
 * @param {Function}     [options.onHour]     - callback(hour, depth) for streaming
 * @returns {{ snapshots: Float32Array[], hourCount: number }}
 */
export function runSimulation({
  heights,
  cols,
  rows,
  rainSeries,
  runoffCoeff = 0.8,
  outletCells = [],
  subSteps = 60,
  marshFull = false,
  onHour = null,
}) {
  const state = initFlowState(heights, cols, rows);
  const snapshots = [];
  let totalBytes = 0;
  let downsample = false;
  const bytesPerSnapshot = cols * rows * 4; // Float32

  for (let h = 0; h < rainSeries.length; h++) {
    stepHour(state, rainSeries[h], runoffCoeff, outletCells, subSteps, marshFull);

    // Downsample decision
    totalBytes += bytesPerSnapshot;
    if (totalBytes > MAX_SNAPSHOT_BYTES && !downsample) {
      downsample = true;
    }

    const keep = downsample ? h % 2 === 0 : true;
    if (keep) {
      const snap = getSnapshot(state);
      snapshots.push(snap);
    }

    if (onHour) onHour(h, state.depth);
  }

  return { snapshots, hourCount: rainSeries.length };
}
