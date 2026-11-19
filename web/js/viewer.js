/**
 * web/js/viewer.js
 * Configures the CesiumJS Viewer with Google Photorealistic 3D Tiles.
 * Disables default globe, geocoder, base layers, and widgets.
 */

import { GOOGLE_MAPS_KEY } from './config.js';

export async function createViewer(containerId = 'cesiumContainer') {
  // Clear any Ion token and provide the Google Maps Key
  Cesium.Ion.defaultAccessToken = '';
  Cesium.GoogleMaps.defaultApiKey = GOOGLE_MAPS_KEY;

  const viewer = new Cesium.Viewer(containerId, {
    globe: false,
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    fullscreenButton: false,
    vrButton: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    skyBox: false,
    skyAtmosphere: false,
  });

  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0e17');

  // Load Google Photorealistic 3D Tileset
  let tileset = null;
  try {
    tileset = await Cesium.createGooglePhotorealistic3DTileset();
    viewer.scene.primitives.add(tileset);
  } catch (err) {
    console.error('Failed to load Google Photorealistic 3D Tileset:', err);
  }

  return { viewer, tileset };
}

/**
 * Adds a thin white bounding box outline that hugs 3D tiles using ground polyline
 */
export function addBoundingBoxOutline(viewer, bbox) {
  const { west, south, east, north } = bbox;

  // Closed rectangle coordinates: SW -> NW -> NE -> SE -> SW
  const degreesArray = [
    west, south,
    west, north,
    east, north,
    east, south,
    west, south,
  ];

  return viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(degreesArray),
      width: 2.0,
      material: new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(0.85)),
      clampToGround: true,
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
    },
  });
}

/**
 * Flies camera to the study box centre with heading ~20°, pitch ~ -35°, range ~3 km
 */
export function flyToStudyArea(viewer, centreLat, centreLon) {
  const target = Cesium.Cartesian3.fromDegrees(centreLon, centreLat, 0);
  const heading = Cesium.Math.toRadians(20.0);
  const pitch = Cesium.Math.toRadians(-35.0);
  const range = 3000.0; // ~3 km away

  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(target, 400.0),
    {
      offset: new Cesium.HeadingPitchRange(heading, pitch, range),
      duration: 2.5,
    }
  );
}
