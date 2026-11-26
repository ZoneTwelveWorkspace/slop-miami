# Slop Miami

A free-roam Downtown Miami & Brickell built on [Slop New York](https://github.com/mrdoob/slop-newyork) by mrdoob: the
same [three.js](https://threejs.org/) WebGPURenderer & TSL engine, ported to real Miami streets, buildings and water
from OpenStreetMap. Walk, drive, cycle or fly from the Omni and the Venetian Causeway down to Brickell, across the Miami
River and out over Biscayne Bay.

## Run it

It's plain ES modules, no build step: serve the folder and open it in a browser with WebGPU (a recent Chrome, Edge or
Safari).

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## Regenerating the city

All geography is generated ahead of time into `js/` from OpenStreetMap:

```sh
# buildings & trees (the original engine's generator), in the Miami frame
node tools/build-osm.mjs --bbox 25.7550,-80.2050,25.7930,-80.1780 --origin 25.77427,-80.19366 --bearing 0 \
  --default-year 1965 --input tools/data/miami/osm_buildings_trees.json
# land, water, blocks, roads, the street graph, parks, landmarks & transit
node tools/build-miami.mjs
```

The Overpass queries are in `tools/data/miami/*.overpassql`. The world frame is metres, x east, z south, with the origin
at Flagler St & Miami Ave (where Miami's street numbering starts) and true north up.

What changed from the New York original (see [PORTING.md](PORTING.md) for the map of the engine):

- `tools/build-miami.mjs` (+ `tools/miami/`): the coastline flood-filled into a land mask, the Miami River cut out,
  curb islands from every at-grade road at its width (the original's block rasteriser, reused), the street centreline
  graph the traffic drives on, parks, named buildings, elevated freeways and the Metromover / Metrorail guideways.
- `js/city-config.js`, `js/city-grid.js`, `js/boroughs.js`, `js/landmarks.js`: rewritten for Miami (same exports).
- `js/palms.js`: palm trees in the parks and along the streets.
- Biscayne Bay's turquoise water, Miami Beach across the bay, Miami teleports and scenic cameras.

## License and data

The project code is available under the [MIT License](LICENSE) (© the Slop New York authors).

Geographic data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and
dependencies retain their respective licenses.
