# Hydrological Water Model Plan (`web/js/pooling-core.js`)

## 1. Goal
Implement a rigorous, physically-principled 2D depression filling and catchment runoff accumulation model using:
1. **Priority-Flood Algorithm (Barnes et al., 2014):**
   - Pure function with a Binary Min-Heap (priority queue) operating on cell indices.
   - Initialises the priority queue with all grid boundary cells (grid edge is the open ocean/outlet).
   - Inward flood propagation: for each extracted cell `c` with spill elevation `e`, each unvisited neighbor `n` has spill level `filled[n] = max(height[n], e)`.
   - Result: `filled[i]` is the absolute maximum water surface elevation if the depression filled completely to its spillover point.
   - Max capacity depth per cell = `max(0, filled[i] - heights[i])`.

2. **D8 Drainage & Catchment Routing with Spillover:**
   - D8 steepest descent computed on the original terrain (or breach-level terrain).
   - Inflow volume per cell: $V_{\text{in}} = C \times \frac{R}{1000} \times A_{\text{cell}}$ (in $\text{m}^3$).
   - Runoff coefficient $C = 0.8$ from `config/area.json`, Cell area $A_{\text{cell}} = (\text{cellSizeM})^2 = 30 \times 30 = 900\text{ m}^2$.
   - Depressions (connected components where `filled[i] > heights[i]` sharing the same spill elevation):
     - Calculate total available storage volume of the depression pond up to spill elevation.
     - Accumulate total runoff volume directed into this catchment basin.
     - Level-pool filling:
       - If total water volume $\le$ depression volume: fill water level $h_{\text{water}}$ horizontally from the bottom cell upward such that $\sum \max(0, h_{\text{water}} - \text{height}_j) \times A_{\text{cell}} = V_{\text{total}}$.
       - If total water volume $>$ depression volume: depression is full ($h_{\text{water}} = \text{spill}$), and excess water volume overflows along the spillway to the downstream catchment.

3. **Output:**
   - `depth[i] = max(0, waterLevel[i] - heights[i])` as `Float32Array` in metres.

4. **Integration & Visualization:**
   - `web/js/pooling-core.js`: Pure mathematical functions, zero DOM/Cesium dependency, works in both Node.js and browser.
   - `web/js/pooling.worker.js`: Offloads Priority-Flood and volume routing to a background Web Worker.
   - `web/js/pooling.js`: Calls the worker, receives `depth[]`, and renders cells with `depth > 0.05` ($5\text{ cm}$) as colored instanced tiles on the 10× exaggerated slab, animating water rise over 5 seconds.
   - `web/test/pooling.test.mjs`: Node.js automated unit test verifying a $7 \times 7$ bowl with known spill height and volume conservation.
