/**
 * web/js/flood-layer.js
 * Renders accumulated flood water.
 *
 * Scene 3 (pooling):
 *   Shows coloured "water disc" billboards at every depression cell,
 *   growing in radius and colour depth over time.
 *
 * Scene 4 (draped):
 *   Creates a ColourRampMaterial polygon grid draped on the terrain,
 *   plus road polygons coloured by flood depth (teal→yellow).
 *
 * Colour ramp: teal (#00bcd4) = 0 m → yellow (#ffeb3b) = ≥ 1.5 m.
 * Heights: WGS84 ellipsoid for Cesium (same artistic offset as elevation-layer).
 */

const TEAL   = Cesium.Color.fromCssColorString('#00bcd4').withAlpha(0.72);
const YELLOW = Cesium.Color.fromCssColorString('#ffeb3b').withAlpha(0.72);

export class FloodLayer {
  constructor(viewer, cfg, demData, roadData) {
    this._v        = viewer;
    this._cfg      = cfg;
    this._demData  = demData;
    this._roadData = roadData;
    this._poolPrim = null;   // PointPrimitiveCollection (scene 3)
    this._drapePrim= null;   // primitives list (scene 4)
    this._timer    = null;

    // Public stat
    this.maxDepthM = 0;
  }

  // ── Scene 3: animated pooling ─────────────────────────────────────────────
  showPooling() {
    this.hide();
    const grid  = this._getGrid();
    const pools = this._findDepressions(grid);

    const pts = this._v.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    );
    this._poolPrim = pts;

    // Start each pool as invisible; animate fill
    pools.forEach(p => {
      pts.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.baseH + 0.3),
        color:    TEAL,
        pixelSize: 3,
        show:      false,
        id:        { depth: 0, maxDepth: p.maxDepth, grow: 0 },
      });
    });

    let tick = 0;
    this._timer = setInterval(() => {
      tick++;
      let maxD = 0;
      for (let i = 0; i < pts.length; i++) {
        const pt  = pts.get(i);
        const id  = pt.id;
        id.grow  += 0.03;
        const t   = Math.min(id.grow, 1);
        id.depth  = t * id.maxDepth;
        if (id.depth > maxD) maxD = id.depth;

        pt.show     = id.grow > 0.05;
        pt.pixelSize = 3 + t * 18;
        pt.color    = Cesium.Color.lerp(TEAL, YELLOW, t * 0.7, new Cesium.Color())
                        .withAlpha(0.65 + t * 0.3);
      }
      this.maxDepthM = maxD;
    }, 100);
  }

  // ── Scene 4: draped flood + road colouring ────────────────────────────────
  showDraped() {
    this.hide();
    const grid  = this._getGrid();
    const pools = this._findDepressions(grid);

    const prims = [];

    // Flood polygons per cell
    pools.forEach(p => {
      const half  = grid.cellLon * 0.5;
      const halfL = grid.cellLat * 0.5;
      const t     = Math.min(p.maxDepth / 1.5, 1);
      const col   = Cesium.Color.lerp(TEAL, YELLOW, t, new Cesium.Color());

      const ent = this._v.entities.add({
        polygon: {
          hierarchy: Cesium.PolygonHierarchy.fromPositions(
            Cesium.Cartesian3.fromDegreesArray([
              p.lon - half, p.lat - halfL,
              p.lon + half, p.lat - halfL,
              p.lon + half, p.lat + halfL,
              p.lon - half, p.lat + halfL,
            ])
          ),
          height:         p.baseH,
          material:       col.withAlpha(0.68),
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          outline:        false,
        },
      });
      prims.push(ent);
    });

    // Road segments coloured by flood depth (if road data available)
    if (this._roadData?.roads) {
      this._roadData.roads.forEach(road => {
        const depths = road.segments.map(s => this._depthAt(s.lon, s.lat, grid, pools));
        road.segments.forEach((seg, i) => {
          if (i === road.segments.length - 1) return;
          const d = depths[i];
          if (d < 0.05) return;
          const t   = Math.min(d / 1.5, 1);
          const col = Cesium.Color.lerp(TEAL, YELLOW, t, new Cesium.Color());
          const ent = this._v.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray([
                seg.lon,              seg.lat,
                road.segments[i+1].lon, road.segments[i+1].lat,
              ]),
              width:    4,
              material: col,
              clampToGround: true,
            },
          });
          prims.push(ent);
        });
      });
    } else {
      // Draw OMR road manually with flood colouring
      this._drawOMRRoadFallback(pools, grid, prims);
    }

    this._drapePrim = prims;
    this.maxDepthM  = Math.max(...pools.map(p => p.maxDepth), 0);
  }

  hide() {
    clearInterval(this._timer);
    if (this._poolPrim) {
      this._v.scene.primitives.remove(this._poolPrim);
      this._poolPrim = null;
    }
    if (this._drapePrim) {
      this._drapePrim.forEach(e => this._v.entities.remove(e));
      this._drapePrim = null;
    }
    this.maxDepthM = 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _getGrid() {
    if (this._demData?.heights) return this._demData;
    // Re-use same synthetic DEM logic (duplicated for module isolation)
    const bb   = this._cfg.bbox;
    const cols = 60, rows = 50;
    const cellLon = (bb.east - bb.west)   / cols;
    const cellLat = (bb.north - bb.south) / rows;
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lo = bb.west  + (c + 0.5) * cellLon;
        const la = bb.south + (r + 0.5) * cellLat;
        let h = 6 + (la - bb.south) / (bb.north - bb.south) * 4;
        const dLon = (lo - 80.218) / 0.03,  dLat = (la - 12.918) / 0.025;
        const dist  = Math.sqrt(dLon*dLon + dLat*dLat);
        if (dist < 1) h -= 3.5 * Math.pow(1-dist, 1.8);
        const roadD = Math.abs(lo - 80.233) / 0.004;
        if (roadD < 1) h += 1.2 * Math.pow(1-roadD, 2);
        const pD = Math.sqrt(Math.pow((lo-80.247)/0.015,2) + Math.pow((la-12.934)/0.015,2));
        if (pD < 1) h -= 2 * Math.pow(1-pD, 1.5);
        const tD = Math.sqrt(Math.pow((lo-80.223)/0.012,2) + Math.pow((la-12.912)/0.012,2));
        if (tD < 1) h -= 1.5 * Math.pow(1-tD, 1.5);
        h += 0.3 * Math.sin(lo*500) * Math.cos(la*400);
        heights[r*cols+c] = Math.max(0, h);
      }
    }
    const elevMin = Math.min(...heights);
    return { cols, rows, west: bb.west, south: bb.south, cellLon, cellLat,
             heights, elevMin };
  }

  _findDepressions(grid) {
    const { cols, rows, west, south, cellLon, cellLat, heights, elevMin } = grid;
    const depressions = [];
    // Local minimum heuristic: a cell is a depression if it is lower than its 4 neighbours
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const h   = heights[r * cols + c];
        const h_n = heights[(r+1) * cols + c];
        const h_s = heights[(r-1) * cols + c];
        const h_e = heights[r * cols + (c+1)];
        const h_w = heights[r * cols + (c-1)];
        // Depression if lower than avg of neighbours and within 2m of elevMin area
        const avg = (h_n + h_s + h_e + h_w) / 4;
        if (h < avg - 0.15) {
          const depth = Math.min((avg - h) * 0.8, 2.0);   // max 2 m visual depth
          depressions.push({
            lon:      west  + (c + 0.5) * cellLon,
            lat:      south + (r + 0.5) * cellLat,
            baseH:    Math.max(0, h),
            maxDepth: depth,
          });
        }
      }
    }
    return depressions;
  }

  _depthAt(lo, la, grid, pools) {
    // Return depth of nearest pool within 500m
    let minDist = Infinity, depth = 0;
    for (const p of pools) {
      const d = Math.hypot(lo - p.lon, la - p.lat);
      if (d < minDist) { minDist = d; depth = p.maxDepth; }
    }
    return minDist < 0.003 ? depth : 0;
  }

  _drawOMRRoadFallback(pools, grid, prims) {
    // OMR spine through study area: hand-digitised simplified centreline
    const omr = [
      [80.199, 12.986], [80.202, 12.978], [80.207, 12.968],
      [80.212, 12.958], [80.218, 12.948], [80.223, 12.938],
      [80.228, 12.928], [80.233, 12.918], [80.237, 12.908],
      [80.242, 12.900],
    ];
    for (let i = 0; i < omr.length - 1; i++) {
      const lo = (omr[i][0] + omr[i+1][0]) / 2;
      const la = (omr[i][1] + omr[i+1][1]) / 2;
      const d  = this._depthAt(lo, la, grid, pools);
      if (d < 0.05) continue;
      const t   = Math.min(d / 1.5, 1);
      const col = Cesium.Color.lerp(TEAL, YELLOW, t, new Cesium.Color());
      const ent = this._v.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([
            ...omr[i], ...omr[i+1],
          ]),
          width: 5,
          material: col,
          clampToGround: true,
        },
      });
      prims.push(ent);
    }
  }
}
