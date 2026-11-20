/**
 * web/js/rain-sim.js
 * Rain-drop particle simulation.
 * Heavy computation delegated to a Web Worker (workers/rain-worker.js).
 * Main thread keeps a Cesium PointPrimitiveCollection in sync.
 *
 * Particles:
 *  - Spawn randomly inside bbox at ~terrain height + small offset.
 *  - Each tick the worker integrates: v += g*dt; pos moves along steepest descent.
 *  - When a particle's elevation stops changing it has pooled.
 *
 * Units: metres, seconds.
 */

export class RainSim {
  constructor(cfg, demData) {
    this._cfg     = cfg;
    this._demData = demData;
    this._worker  = null;
    this._prim    = null;
    this._viewer  = null;
    this._running = false;

    // Public stats (read by scene-manager)
    this.totalMm    = 0;
    this.activeCount = 0;
  }

  start(viewer) {
    if (this._running) return;
    this._viewer  = viewer;
    this._running = true;

    // Create Cesium point collection
    this._prim = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    );

    // Start worker
    this._worker = new Worker('js/workers/rain-worker.js', { type: 'module' });
    this._worker.postMessage({
      type:    'init',
      cfg:     this._cfg,
      demData: this._serializeDem(),
    });

    this._worker.onmessage = (e) => this._onWorkerMsg(e.data);
    this._worker.onerror   = (e) => console.error('[rain-worker]', e.message);

    // Spawn first batch of drops
    this._worker.postMessage({ type: 'spawn', count: 300 });
  }

  stop() {
    this._running = false;
    if (this._worker) { this._worker.terminate(); this._worker = null; }
    if (this._prim)   {
      this._viewer.scene.primitives.remove(this._prim);
      this._prim = null;
    }
    this.totalMm    = 0;
    this.activeCount = 0;
  }

  // ── Handle worker messages ───────────────────────────────────────────────
  _onWorkerMsg(msg) {
    if (!this._running) return;

    switch (msg.type) {
      case 'frame': {
        this.activeCount = msg.active;
        this.totalMm    += msg.addedMm;

        // Sync point positions
        const pts = this._prim;
        if (!pts) return;

        // Grow collection if needed
        while (pts.length < msg.positions.length / 3) {
          pts.add({ pixelSize: 5, color: Cesium.Color.fromCssColorString('#80d8ff') });
        }

        const n = msg.positions.length / 3;
        for (let i = 0; i < pts.length; i++) {
          if (i < n) {
            const lon = msg.positions[i * 3];
            const lat = msg.positions[i * 3 + 1];
            const alt = msg.positions[i * 3 + 2];
            pts.get(i).position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
            pts.get(i).show     = true;

            // Colour: falling (cyan) → pooled (blue)
            const t = msg.pooled[i] ? 1 : 0;
            pts.get(i).color = Cesium.Color.lerp(
              Cesium.Color.fromCssColorString('#80d8ff'),
              Cesium.Color.fromCssColorString('#1565c0'),
              t, new Cesium.Color()
            );
          } else {
            pts.get(i).show = false;
          }
        }

        // Spawn more drops gradually
        if (this._running && msg.active < this._cfg.simulation.drop_count) {
          this._worker.postMessage({ type: 'spawn', count: 20 });
        }

        // Request next frame
        this._worker.postMessage({ type: 'tick' });
        break;
      }
    }
  }

  // ── Serialise DEM for transfer to worker ─────────────────────────────────
  _serializeDem() {
    if (this._demData?.heights) return this._demData;
    // Let worker build its own synthetic DEM
    return null;
  }
}
