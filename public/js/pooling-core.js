/**
 * web/js/pooling-core.js
 * Pure functions for Priority-Flood depression filling (Barnes et al., 2014)
 * and level-pool volume filling with catchment runoff accumulation.
 *
 * Works in both Node.js (ESM) and the browser.
 * Zero external dependencies.
 */

/**
 * Binary Min-Heap Priority Queue holding cell indices ordered by key elevation.
 */
export class MinHeap {
  constructor(initialCapacity = 1024) {
    this.indices = new Int32Array(initialCapacity);
    this.keys = new Float32Array(initialCapacity);
    this.size = 0;
  }

  _grow() {
    const newCap = this.indices.length * 2;
    const newIndices = new Int32Array(newCap);
    const newKeys = new Float32Array(newCap);
    newIndices.set(this.indices);
    newKeys.set(this.keys);
    this.indices = newIndices;
    this.keys = newKeys;
  }

  push(idx, key) {
    if (this.size >= this.indices.length) this._grow();
    let i = this.size++;
    this.indices[i] = idx;
    this.keys[i] = key;

    // Sift up
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[i] < this.keys[p]) {
        const ti = this.indices[i];
        const tk = this.keys[i];
        this.indices[i] = this.indices[p];
        this.keys[i] = this.keys[p];
        this.indices[p] = ti;
        this.keys[p] = tk;
        i = p;
      } else {
        break;
      }
    }
  }

  pop() {
    if (this.size === 0) return -1;
    const minIdx = this.indices[0];
    const last = --this.size;
    if (last > 0) {
      this.indices[0] = this.indices[last];
      this.keys[0] = this.keys[last];

      // Sift down
      let i = 0;
      while (true) {
        let best = i;
        const l = (i << 1) + 1;
        const r = l + 1;
        if (l < this.size && this.keys[l] < this.keys[best]) best = l;
        if (r < this.size && this.keys[r] < this.keys[best]) best = r;
        if (best !== i) {
          const ti = this.indices[i];
          const tk = this.keys[i];
          this.indices[i] = this.indices[best];
          this.keys[i] = this.keys[best];
          this.indices[best] = ti;
          this.keys[best] = tk;
          i = best;
        } else {
          break;
        }
      }
    }
    return minIdx;
  }
}

/**
 * 1. Priority-Flood algorithm (Barnes et al., 2014)
 * Computes filled[i] = level water would reach if every depression filled to its spill point.
 * Grid boundary cells are treated as the outside outlet / ocean.
 *
 * @param {Float32Array|number[]} heights - Elevation array (row-major)
 * @param {number} cols - Number of grid columns
 * @param {number} rows - Number of grid rows
 * @returns {Float32Array} filled - Elevation of water spill surface
 */
export function priorityFlood(heights, cols, rows) {
  const n = cols * rows;
  const filled = new Float32Array(n);
  const visited = new Uint8Array(n);
  const pq = new MinHeap(Math.max(1024, (cols + rows) * 2));

  // Initialize boundary cells into the min-heap
  for (let c = 0; c < cols; c++) {
    const top = c;
    const bot = (rows - 1) * cols + c;
    visited[top] = 1;
    filled[top] = heights[top];
    pq.push(top, heights[top]);

    if (rows > 1) {
      visited[bot] = 1;
      filled[bot] = heights[bot];
      pq.push(bot, heights[bot]);
    }
  }

  for (let r = 1; r < rows - 1; r++) {
    const left = r * cols;
    const right = left + (cols - 1);
    visited[left] = 1;
    filled[left] = heights[left];
    pq.push(left, heights[left]);

    visited[right] = 1;
    filled[right] = heights[right];
    pq.push(right, heights[right]);
  }

  // 8-neighborhood offsets
  const dr = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dc = [-1, 0, 1, -1, 1, -1, 0, 1];

  while (pq.size > 0) {
    const idx = pq.pop();
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const floodLvl = filled[idx];

    for (let i = 0; i < 8; i++) {
      const nr = r + dr[i];
      const nc = c + dc[i];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;

      const nIdx = nr * cols + nc;
      if (visited[nIdx] === 0) {
        visited[nIdx] = 1;
        const nh = heights[nIdx];
        const nSpill = Math.max(nh, floodLvl);
        filled[nIdx] = nSpill;
        pq.push(nIdx, nSpill);
      }
    }
  }

  return filled;
}

/**
 * 2. Level-pool water accumulation based on rainfall R (mm) and runoff coefficient C.
 * Routes runoff to depressions and fills them from bottom up (with overflow cascading).
 *
 * @param {Object} options
 * @param {Float32Array|number[]} options.heights - Original terrain heights (m)
 * @param {Float32Array} [options.filled] - Output from priorityFlood (optional, computed if missing)
 * @param {number} options.cols - Grid columns
 * @param {number} options.rows - Grid rows
 * @param {number} options.cellSizeM - Grid cell dimension in metres (e.g. 30)
 * @param {number} options.rainfallMm - Total rainfall depth in mm
 * @param {number} options.runoffCoeff - Runoff coefficient C (e.g. 0.8)
 * @returns {Float32Array} depth - Water depth per cell in metres
 */
export function computeWaterDepth({
  heights,
  filled,
  cols,
  rows,
  cellSizeM = 30,
  rainfallMm = 100,
  runoffCoeff = 0.8,
}) {
  const n = cols * rows;
  const H = heights instanceof Float32Array ? heights : new Float32Array(heights);
  const F = filled || priorityFlood(H, cols, rows);

  const cellAreaM2 = cellSizeM * cellSizeM;
  // Volume produced per cell in m^3: (rainfall_mm / 1000) * runoffCoeff * cellArea
  const rainWaterVolPerCell = (rainfallMm / 1000.0) * runoffCoeff * cellAreaM2;

  // D8 steepest descent on terrain to route runoff
  const dr = [-1, -1, -1, 0, 0, 1, 1, 1];
  const dc = [-1, 0, 1, -1, 1, -1, 0, 1];
  const SQRT2 = Math.SQRT2;
  const dist = [SQRT2, 1, SQRT2, 1, 1, SQRT2, 1, SQRT2];

  const d8Downstream = new Int32Array(n);
  d8Downstream.fill(-1);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) continue;

      let maxSlope = 0.0;
      let steepest = -1;
      const h0 = H[idx];

      for (let i = 0; i < 8; i++) {
        const nr = r + dr[i];
        const nc = c + dc[i];
        const nIdx = nr * cols + nc;
        const s = (h0 - H[nIdx]) / dist[i];
        if (s > maxSlope) {
          maxSlope = s;
          steepest = nIdx;
        }
      }
      d8Downstream[idx] = maxSlope > 0 ? steepest : -1;
    }
  }

  // Identify depressions: connected components of cells where F[i] > H[i]
  // Group cells into depression basins using BFS / Flood-Fill
  const depressionId = new Int32Array(n);
  depressionId.fill(-1);
  const basins = []; // Array of { id, cells: [], spillHeight, minH, maxCapacityVol, inflowVol }

  for (let i = 0; i < n; i++) {
    if (F[i] > H[i] + 1e-4 && depressionId[i] === -1) {
      const bId = basins.length;
      const cells = [];
      const queue = [i];
      depressionId[i] = bId;

      let minElev = H[i];
      const targetSpill = F[i];

      while (queue.length > 0) {
        const curr = queue.pop();
        cells.push(curr);
        if (H[curr] < minElev) minElev = H[curr];

        const cr = Math.floor(curr / cols);
        const cc = curr % cols;

        for (let k = 0; k < 8; k++) {
          const nr = cr + dr[k];
          const nc = cc + dc[k];
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const nIdx = nr * cols + nc;

          // Same depression basin if water spill elevation is equal and inundated
          if (depressionId[nIdx] === -1 && F[nIdx] > H[nIdx] + 1e-4 && Math.abs(F[nIdx] - targetSpill) < 1e-3) {
            depressionId[nIdx] = bId;
            queue.push(nIdx);
          }
        }
      }

      // Compute total basin storage capacity (m^3)
      let maxCap = 0;
      for (let k = 0; k < cells.length; k++) {
        maxCap += (F[cells[k]] - H[cells[k]]) * cellAreaM2;
      }

      basins.push({
        id: bId,
        cells,
        spillHeight: targetSpill,
        minH: minElev,
        maxCapacityVol: maxCap,
        inflowVol: 0.0,
      });
    }
  }

  // Catchment accumulation: order all cells topologically (highest to lowest)
  // Each cell generates rainWaterVolPerCell and passes it downstream
  const cellWaterVol = new Float64Array(n);
  cellWaterVol.fill(rainWaterVolPerCell);

  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => H[b] - H[a]); // Descending elevation

  for (let i = 0; i < n; i++) {
    const idx = order[i];
    const bId = depressionId[idx];
    if (bId !== -1) {
      // Direct accumulation to this basin
      basins[bId].inflowVol += cellWaterVol[idx];
    } else {
      // Overland routing along steepest descent
      const nxt = d8Downstream[idx];
      if (nxt !== -1) {
        cellWaterVol[nxt] += cellWaterVol[idx];
      }
    }
  }

  // Level-pool filling for each basin
  const depth = new Float32Array(n);

  for (let b = 0; b < basins.length; b++) {
    const basin = basins[b];
    const cells = basin.cells;
    const vol = basin.inflowVol;

    if (vol <= 0) continue;

    if (vol >= basin.maxCapacityVol) {
      // Basin is 100% full to spill point
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        depth[c] = Math.max(0, F[c] - H[c]);
      }
    } else {
      // Partial level-pool filling from bottom up
      // Sort basin cells by elevation ascending
      const sortedCells = Array.from(cells).sort((a, b) => H[a] - H[b]);
      const cellElevs = sortedCells.map(c => H[c]);
      const m = sortedCells.length;

      // Binary search for water surface elevation h_water such that:
      // sum(max(0, h_water - H[c]) * cellAreaM2) = vol
      let low = basin.minH;
      let high = basin.spillHeight;

      for (let iter = 0; iter < 40; iter++) {
        const mid = (low + high) * 0.5;
        let v = 0;
        for (let k = 0; k < m; k++) {
          if (cellElevs[k] >= mid) break;
          v += (mid - cellElevs[k]) * cellAreaM2;
        }
        if (v < vol) {
          low = mid;
        } else {
          high = mid;
        }
      }

      const waterLevel = (low + high) * 0.5;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        if (waterLevel > H[c]) {
          depth[c] = Math.max(0, waterLevel - H[c]);
        }
      }
    }
  }

  return depth;
}
