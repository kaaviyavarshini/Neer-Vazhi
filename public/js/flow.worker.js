/**
 * web/js/flow.worker.js
 * Web Worker wrapper for flow-core.js time-stepping model.
 *
 * Incoming message:
 * {
 *   type: 'run',
 *   heights: Float32Array,       // transferred
 *   cols: number,
 *   rows: number,
 *   rainSeries: number[],        // mm per hour
 *   runoffCoeff: number,
 *   outletCells: number[],       // flat cell indices
 *   subSteps: number,            // default 60
 *   marshFull: boolean
 * }
 *
 * Outgoing messages (per hour, transferable):
 * { type: 'hour', hour: N, depth: Float32Array }
 *
 * Final message:
 * { type: 'done', totalHours: N }
 *
 * Error:
 * { type: 'error', message: string }
 */

import { initFlowState, stepHour, getSnapshot } from './flow-core.js';

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

self.addEventListener('message', (evt) => {
  const msg = evt.data;
  if (msg.type !== 'run') return;

  try {
    const {
      heights,
      cols,
      rows,
      rainSeries,
      runoffCoeff = 0.8,
      outletCells = [],
      subSteps = 60,
      marshFull = false,
    } = msg;

    const bytesPerSnap = cols * rows * 4;
    const totalBytes = bytesPerSnap * rainSeries.length;
    const downsample = totalBytes > MAX_SNAPSHOT_BYTES;

    const state = initFlowState(heights, cols, rows);

    for (let h = 0; h < rainSeries.length; h++) {
      stepHour(state, rainSeries[h], runoffCoeff, outletCells, subSteps, marshFull);

      const keep = downsample ? h % 2 === 0 : true;
      if (keep) {
        const snap = getSnapshot(state);
        // Transfer the buffer to avoid copying
        self.postMessage({ type: 'hour', hour: h, depth: snap }, [snap.buffer]);
      }
    }

    self.postMessage({ type: 'done', totalHours: rainSeries.length });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
});
