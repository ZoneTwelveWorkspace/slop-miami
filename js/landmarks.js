// Miami's landmark buildings (the Freedom Tower, Miami Tower, the Brickell towers...) come straight from their
// OpenStreetMap footprints & heights in js/building-geodata.js, like every other building, so there is nothing
// hand-built here. The New York original modelled the Empire State, Chrysler, Grand Central & co. in this module;
// it keeps the same exports for the engine.

// The raised lawn the New York original fitted Bryant Park to (cameras.js, controllers.js, street-details.js)
const bryantParkLawn = null;

function buildLandmarks() {
  return { colliders: [] };
}

export { buildLandmarks, bryantParkLawn };
