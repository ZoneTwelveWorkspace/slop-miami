// tools/build-miami.mjs — writes js/miami-geodata.js: Downtown Miami & Brickell from OpenStreetMap in the simulation's
// world frame, in the shapes the runtime reads (land, blocks, roads, the street centreline graph, parks, landmarks).
// usage: node tools/build-miami.mjs [--input tools/data/miami/osm_city.json] [out.js]
// The Overpass query is tools/data/miami/q_city.overpassql. Data © OpenStreetMap contributors, ODbL 1.0.
//
// Frame: 1 unit = 1 m, x = east, z = south (north = -z), origin at the centreline crossing of Flagler St & Miami Ave
// (where Miami's street numbering starts); bearing 0 — the city grid runs true north-south.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFrame, parseLength, joinWays } from './build-osm.mjs';
import { Raster, rdp, rdpRing, ringArea, bbox, log } from './miami/geom.mjs';
import { buildBlocks } from './miami/blocks.mjs';

const args = process.argv.slice(2);
const inputArg = args.indexOf('--input');
const INPUT = inputArg >= 0 ? args.splice(inputArg, 2)[1] : fileURLToPath(new URL('data/miami/osm_city.json', import.meta.url));
const OUT = args[0] || fileURLToPath(new URL('../js/miami-geodata.js', import.meta.url));

export const ORIGIN = { lat: 25.77427, lon: -80.19366 };
export const DETAIL_BBOX = [25.7550, -80.2050, 25.7930, -80.1780]; // south, west, north, east
const WORLD_BBOX = [25.7400, -80.2200, 25.8100, -80.1500];
const frame = createFrame({ ...ORIGIN, bearing: 0 });
const toWorld = (lon, lat) => frame.toWorld(lon, lat);
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const SIDEWALK = 4.6;

const osm = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry);
const rels = osm.elements.filter((e) => e.type === 'relation');
const wpts = (e) => e.geometry.map((g) => toWorld(g.lon, g.lat));
log(`${ways.length} ways, ${rels.length} relations, ${osm.elements.filter((e) => e.type === 'node').length} nodes`);

function corners([s, w, n, e]) {
  const pts = [toWorld(w, s), toWorld(e, s), toWorld(e, n), toWorld(w, n)];
  const b = bbox(pts);
  return { minX: b.x0, maxX: b.x1, minZ: b.z0, maxZ: b.z1 };
}
const DETAIL = corners(DETAIL_BBOX);
const WORLD = corners(WORLD_BBOX);
log(`detail ${Math.round(DETAIL.maxX - DETAIL.minX)} x ${Math.round(DETAIL.maxZ - DETAIL.minZ)} m, world ${Math.round(WORLD.maxX - WORLD.minX)} x ${Math.round(WORLD.maxZ - WORLD.minZ)} m`);

// Outer (and inner) rings of an area: a closed way, or a multipolygon relation's member ways joined end to end
function areaRings(e) {
  if (e.type === 'way') {
    const p = wpts(e);
    return p.length >= 4 && e.nodes[0] === e.nodes[e.nodes.length - 1] ? { outer: [p], inner: [] } : { outer: [], inner: [] };
  }
  const part = (role) => joinWays((e.members || []).filter((m) => m.type === 'way' && m.geometry && (m.role || 'outer') === role)
    .map((m) => m.geometry.map((g) => [g.lon, g.lat]))).map((r) => r.map(([lon, lat]) => toWorld(lon, lat)));
  return { outer: part('outer'), inner: part('inner') };
}
const allAreas = [...ways, ...rels];

// =====================================================================================================================
// 1. LAND: the coastline (land on its left) flood-filled at 4 m over the world box, minus the river & inland water
// =====================================================================================================================
const L = new Raster(WORLD.minX, WORLD.minZ, WORLD.maxX, WORLD.maxZ, 4);
L.d.fill(1);
function stamp(R, x0, z0, x1, z1, r, val) {
  const ix0 = Math.max(0, Math.floor((Math.min(x0, x1) - r - R.x0) / R.res));
  const ix1 = Math.min(R.w - 1, Math.ceil((Math.max(x0, x1) + r - R.x0) / R.res));
  const iz0 = Math.max(0, Math.floor((Math.min(z0, z1) - r - R.z0) / R.res));
  const iz1 = Math.min(R.h - 1, Math.ceil((Math.max(z0, z1) + r - R.z0) / R.res));
  const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
  for (let j = iz0; j <= iz1; j++) {
    const pz = R.z0 + (j + 0.5) * R.res;
    for (let i = ix0; i <= ix1; i++) {
      const px = R.x0 + (i + 0.5) * R.res;
      const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / L2));
      const ex = x0 + t * dx - px, ez = z0 + t * dz - pz;
      if (ex * ex + ez * ez <= r * r) R.d[j * R.w + i] = val;
    }
  }
}
const coast = ways.filter((w) => w.tags?.natural === 'coastline').map(wpts);
for (const line of coast) {
  for (let k = 0; k + 1 < line.length; k++) stamp(L, line[k][0], line[k][1], line[k + 1][0], line[k + 1][1], 3.2, 2);
}
// The coastline cuts the box into regions; each votes land or water from the side of the coastline it lies on (water
// to the right of the way: (-dz, dx) in this frame, x east & z south). Voting per region rather than flooding from
// seeds: next to docks and narrow piers a seed can land on the far side of the next slip and flood the mainland.
{
  const { w, h, d } = L;
  const lab = new Int32Array(w * h);
  let regions = 0;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (d[s] !== 1 || lab[s]) continue;
    regions++;
    lab[s] = regions;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      const i = p % w, j = (p - i) / w;
      if (i > 0 && d[p - 1] === 1 && !lab[p - 1]) { lab[p - 1] = regions; stack.push(p - 1); }
      if (i < w - 1 && d[p + 1] === 1 && !lab[p + 1]) { lab[p + 1] = regions; stack.push(p + 1); }
      if (j > 0 && d[p - w] === 1 && !lab[p - w]) { lab[p - w] = regions; stack.push(p - w); }
      if (j < h - 1 && d[p + w] === 1 && !lab[p + w]) { lab[p + w] = regions; stack.push(p + w); }
    }
  }
  const votes = new Float64Array(regions + 1); // > 0: water
  const regionAt = (x, z) => {
    const i = Math.floor((x - L.x0) / L.res), j = Math.floor((z - L.z0) / L.res);
    return i >= 0 && j >= 0 && i < w && j < h ? lab[j * w + i] : 0;
  };
  for (const line of coast) {
    for (let k = 0; k + 1 < line.length; k++) {
      const [x0, z0] = line[k];
      const [x1, z1] = line[k + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1) continue;
      const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
      for (let s = 0.5; s < len; s += 4) {
        const px = x0 + ((x1 - x0) * s) / len, pz = z0 + ((z1 - z0) * s) / len;
        votes[regionAt(px + nx * 6, pz + nz * 6)] += 1;
        votes[regionAt(px - nx * 6, pz - nz * 6)] -= 1;
      }
    }
  }
  for (let k = 0; k < d.length; k++) {
    if (d[k] === 2) d[k] = 1;
    else if (lab[k] && votes[lab[k]] > 0) d[k] = 0;
  }
  log(`coastline split the box into ${regions} regions; ${[...votes].filter((v) => v > 0).length} vote water`);
}
const waterAreas = allAreas.filter((e) => e.tags && (e.tags.natural === 'water' || e.tags.waterway === 'riverbank') && e.tags.water !== 'pond_private');
for (const e of waterAreas) {
  const { outer, inner } = areaRings(e);
  for (const r of outer) L.fillRing(r, 0);
  for (const r of inner) L.fillRing(r, 1);
}
log(`land: ${coast.length} coastline ways, ${waterAreas.length} inland water areas`);

// Land components -> rings (corner walk around each 4-connected component, as tools/miami/blocks.mjs)
function componentRings(R, minArea) {
  const { w, h, d } = R;
  const lab = new Int32Array(w * h);
  const out = [];
  let id = 0;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (d[s] !== 1 || lab[s]) continue;
    id++;
    let n = 0;
    stack.push(s);
    lab[s] = id;
    while (stack.length) {
      const p = stack.pop();
      n++;
      const i = p % w, j = (p - i) / w;
      if (i > 0 && d[p - 1] === 1 && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (i < w - 1 && d[p + 1] === 1 && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (j > 0 && d[p - w] === 1 && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (j < h - 1 && d[p + w] === 1 && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    if (n * R.res * R.res < minArea) continue;
    const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h && lab[j * w + i] === id ? 1 : 0);
    const si = s % w, sj = (s - si) / w;
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    let cx = si, cz = sj, dir = 0;
    const pts = [];
    const start = `${cx},${cz},${dir}`;
    let guard = 0;
    do {
      pts.push([R.x0 + cx * R.res, R.z0 + cz * R.res]);
      cx += DX[dir];
      cz += DZ[dir];
      let left, right;
      if (dir === 0) { left = at(cx, cz - 1); right = at(cx, cz); }
      else if (dir === 1) { left = at(cx, cz); right = at(cx - 1, cz); }
      else if (dir === 2) { left = at(cx - 1, cz); right = at(cx - 1, cz - 1); }
      else { left = at(cx - 1, cz - 1); right = at(cx, cz - 1); }
      if (left && right) dir = (dir + 3) % 4;
      else if (!right) dir = (dir + 1) % 4;
      if (++guard > 2e7) break;
    } while (`${cx},${cz},${dir}` !== start);
    // stair midpoints, then simplify
    const mids = pts.map((p, k) => {
      const nx = pts[(k + 1) % pts.length];
      return [(p[0] + nx[0]) / 2, (p[1] + nx[1]) / 2];
    });
    let ring = rdpRing(mids, R.res * 0.6);
    if (ringArea(ring) > 0) ring.reverse();
    out.push({ ring, area: n * R.res * R.res });
  }
  return out.sort((a, b) => b.area - a.area);
}
const landRings = componentRings(L, 4000);
log(`${landRings.length} land masses (largest ${(landRings[0].area / 1e6).toFixed(2)} km²)`);
// The 4 m land mask itself, for the runtime's water test (row-major bytes, run-length encoded)
function rle(d) {
  const runs = [];
  let v = d[0], n = 0;
  for (let k = 0; k < d.length; k++) {
    if (d[k] === v) n++;
    else { runs.push(n); v = d[k]; n = 1; }
  }
  runs.push(n);
  return { first: d[0], runs };
}

// =====================================================================================================================
// 2. ROADS: vehicular OSM ways. At grade (blocks, traffic, the road graph) unless they're freeways or flyovers
// =====================================================================================================================
const VEHICULAR = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$/;
const CLASS_WIDTH = { trunk: 18, primary: 16, secondary: 13, tertiary: 11.5, unclassified: 8.5, residential: 9.1, living_street: 6.5,
  motorway: 22, motorway_link: 7.5, trunk_link: 7.5, primary_link: 7.5, secondary_link: 7, tertiary_link: 7 };
const insideDetail = ([x, z], m = 0) => x > DETAIL.minX - m && x < DETAIL.maxX + m && z > DETAIL.minZ - m && z < DETAIL.maxZ + m;
const roadWays = [];
const elevated = [];
for (const w of ways) {
  const t = w.tags || {};
  if (!t.highway || !VEHICULAR.test(t.highway) || t.area === 'yes' || t.tunnel) continue;
  if (t.access === 'private' || t.access === 'no') continue;
  const pts = wpts(w);
  if (!pts.some((p) => insideDetail(p, 30))) continue;
  const layer = parseInt(t.layer || '0', 10) || 0;
  const freeway = /^(motorway|motorway_link|trunk_link)$/.test(t.highway);
  const lanes = parseInt(t.lanes || '0', 10) || 0;
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' || t.highway === 'motorway' ? 1 : t.oneway === '-1' ? -1 : 0;
  let width = parseLength(t.width);
  if (!(width > 3)) width = lanes ? Math.max(6, lanes * 3.4 + (t.highway === 'residential' ? 2.4 : 0)) : CLASS_WIDTH[t.highway] || 9;
  width = Math.min(width, 30);
  const name = (t.name || t.ref || '').trim();
  const road = { id: w.id, nodes: w.nodes, pts, name, cls: t.highway, w: width, lanes, dir: oneway, bridge: !!t.bridge, layer };
  // Freeways & anything stacked over another road are elevated (I-95, I-395, the Brickell flyovers): drawn as viaducts
  if (freeway || layer >= 2 || (t.bridge && layer >= 1 && !/^(primary|secondary|tertiary|residential|unclassified|trunk)$/.test(t.highway))) elevated.push(road);
  else roadWays.push(road);
}
log(`${roadWays.length} at-grade road ways, ${elevated.length} elevated`);

// =====================================================================================================================
// 3. BLOCKS: land at 1 m over the detail box, minus every at-grade roadway at its curb-to-curb width
// =====================================================================================================================
const R = new Raster(DETAIL.minX, DETAIL.minZ, DETAIL.maxX, DETAIL.maxZ, 1);
for (const { ring } of landRings) R.fillRing(ring, 1);
// keep a 2 m lip of open paving between the blocks and the seawall
{
  const toWater = R.edt((v) => v === 0);
  for (let k = 0; k < R.d.length; k++) if (R.d[k] && toWater[k] <= 4) R.d[k] = 0;
}
for (const r of roadWays) {
  for (let k = 0; k + 1 < r.pts.length; k++) stamp(R, r.pts[k][0], r.pts[k][1], r.pts[k + 1][0], r.pts[k + 1][1], r.w / 2, 0);
}
const { blocks, labels } = buildBlocks(R, { SIDEWALK });

// Parks: share of each block under parkland, and the park's name
const PARK = /^(park|garden|pitch|playground|dog_park)$/;
const parkAreas = allAreas.filter((e) => e.tags && (PARK.test(e.tags.leisure || '') || /^(grass|recreation_ground|village_green)$/.test(e.tags.landuse || '')));
const parks = [];
const parkMask = new Raster(R.x0, R.z0, R.x0 + (R.w - 1) * R.res, R.z0 + (R.h - 1) * R.res, 1);
const parkIds = new Int16Array(parkMask.w * parkMask.h);
for (const e of parkAreas) {
  const { outer } = areaRings(e);
  if (!outer.length) continue;
  const area = outer.reduce((t, r) => t + Math.abs(ringArea(r)), 0);
  if (area < 150) continue;
  const id = parks.length + 1;
  parks.push({ name: e.tags.name || '', cat: e.tags.leisure || e.tags.landuse, acres: Math.round((area / 4046.86) * 100) / 100, rings: outer.map((r) => rdpRing(r, 0.6)) });
  parkMask.d.fill(0);
  for (const r of outer) parkMask.fillRing(r, 1);
  for (let k = 0; k < parkMask.d.length; k++) if (parkMask.d[k] && (!parkIds[k] || id < 32767)) parkIds[k] = id;
}
{
  const byLab = new Map(blocks.map((b) => [b.id, { b, n: 0, park: 0, names: new Map() }]));
  for (let k = 0; k < labels.length; k++) {
    const s = byLab.get(labels[k]);
    if (!s) continue;
    s.n++;
    const p = parkIds[k];
    if (p) {
      s.park++;
      const nm = parks[p - 1].name;
      if (nm) s.names.set(nm, (s.names.get(nm) || 0) + 1);
    }
  }
  for (const s of byLab.values()) {
    s.b.park = s.n ? Math.round((s.park / s.n) * 100) / 100 : 0;
    s.b.parkName = [...s.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
}
log(`${parks.length} parks; ${blocks.filter((b) => b.park > 0.6).length} park blocks`);

// =====================================================================================================================
// 4. STREET CENTRELINE GRAPH (js/road-network.js 4b): ways split at shared nodes -> links between junctions
// =====================================================================================================================
function buildRoadGraph() {
  const uses = new Map();
  for (const r of roadWays) for (const id of r.nodes) uses.set(id, (uses.get(id) || 0) + 1);
  const nodes = [];
  const nodeIdx = new Map();
  const nodeOf = (id, p) => {
    if (!nodeIdx.has(id)) { nodeIdx.set(id, nodes.length / 2); nodes.push(q(p[0]), q(p[1])); }
    return nodeIdx.get(id);
  };
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    const k = n.toUpperCase();
    if (!nameIds.has(k)) { nameIds.set(k, names.length); names.push(k); }
    return nameIds.get(k);
  };
  const links = [];
  for (const r of roadWays) {
    let a = 0;
    for (let k = 1; k < r.nodes.length; k++) {
      if (k < r.nodes.length - 1 && uses.get(r.nodes[k]) < 2) continue;
      const pts = r.pts.slice(a, k + 1);
      // keep the links touching the detailed box
      if (pts.some((p) => insideDetail(p, 10)) && r.nodes[a] !== r.nodes[k]) {
        const ia = nodeOf(r.nodes[a], r.pts[a]);
        const ib = nodeOf(r.nodes[k], r.pts[k]);
        const inner = rdp(pts, 0.4).slice(1, -1);
        links.push([ia, ib, nameId(r.name), q(r.w), r.lanes, r.dir, flat(inner)]);
      }
      a = k;
    }
  }
  log(`road graph: ${nodes.length / 2} nodes, ${links.length} links`);
  return { nodes, links, names };
}
const roadGraph = buildRoadGraph();

// Traffic signals: the junction nodes that carry a highway=traffic_signals node (or have one within 12 m)
const signals = osm.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'traffic_signals').map((e) => toWorld(e.lon, e.lat)).filter((p) => insideDetail(p));

// =====================================================================================================================
// 5. LANDMARKS, TRANSIT & WATERFRONT
// =====================================================================================================================
const landmarks = {};
for (const e of allAreas) {
  const t = e.tags || {};
  if (!t.name || !(t.building || t.tourism)) continue;
  const { outer } = areaRings(e);
  if (!outer.length) continue;
  const r = outer.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
  if (!insideDetail(r[0], 50)) continue;
  const b = bbox(r);
  const area = Math.abs(ringArea(r));
  const prev = landmarks[t.name];
  if (prev && prev.area >= area) continue;
  const h = parseLength(t.height) || (t['building:levels'] ? parseFloat(t['building:levels']) * 3.2 : null);
  landmarks[t.name] = { x: q((b.x0 + b.x1) / 2), z: q((b.z0 + b.z1) / 2), w: q(b.x1 - b.x0), d: q(b.z1 - b.z0), h: h ? Math.round(h) : null, area: Math.round(area), kind: t.tourism || t.building, ring: flat(rdpRing(r.slice(0, -1), 0.4)) };
}
log(`${Object.keys(landmarks).length} named buildings & attractions`);

const transit = ways.filter((w) => w.tags?.railway && /^(light_rail|monorail|subway|rail)$/.test(w.tags.railway))
  .map((w) => ({ kind: w.tags.railway, name: w.tags.name || '', elevated: !!w.tags.bridge || (parseInt(w.tags.layer || '0', 10) || 0) >= 1, pts: wpts(w) }))
  .filter((l) => l.pts.some((p) => insideDetail(p, 50)));
const piers = ways.filter((w) => /^(pier|breakwater|groyne)$/.test(w.tags?.man_made || '')).map((w) => ({ name: w.tags.name || '', closed: w.nodes[0] === w.nodes[w.nodes.length - 1], pts: wpts(w) }))
  .filter((p) => p.pts.some((pt) => insideDetail(pt, 50)));
log(`${transit.length} transit ways (${transit.filter((t) => t.elevated).length} elevated), ${piers.length} piers`);

// =====================================================================================================================
// Assemble
// =====================================================================================================================
const GEO = {
  version: 1,
  city: 'Miami',
  frame: { bearingDeg: 0, origin: 'Flagler St & Miami Ave (centreline)', lat: ORIGIN.lat, lon: ORIGIN.lon, units: 'm', sidewalk: SIDEWALK,
    detail: { minX: q(DETAIL.minX), maxX: q(DETAIL.maxX), minZ: q(DETAIL.minZ), maxZ: q(DETAIL.maxZ) },
    world: { minX: q(WORLD.minX), maxX: q(WORLD.maxX), minZ: q(WORLD.minZ), maxZ: q(WORLD.maxZ) } },
  land: landRings.map((l) => flat(l.ring)),
  landMask: { x0: L.x0, z0: L.z0, res: L.res, w: L.w, h: L.h, ...rle(L.d) },
  roads: roadWays.filter((r) => r.name).map((r) => [r.name, q(r.w), r.dir, r.lanes, 0, flat(rdp(r.pts, 0.6))]),
  elevated: elevated.map((r) => [r.name, q(r.w), r.dir, r.lanes, r.layer, flat(rdp(r.pts, 0.6))]),
  roadGraph,
  signals: flat(signals),
  // [outline, lot rects, park share, park name, rectangular, frontage frames [[θ, px, pz, lot rects in the frame], ...] | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0]),
  parks: parks.map((p) => ({ name: p.name, cat: p.cat, acres: p.acres, rings: p.rings.map(flat) })),
  landmarks,
  transit: transit.map((t) => ({ kind: t.kind, name: t.name, elevated: t.elevated, pts: flat(rdp(t.pts, 0.5)) })),
  piers: piers.map((p) => ({ name: p.name, closed: p.closed, pts: flat(p.pts) }))
};
const header = `// js/miami-geodata.js — GENERATED by tools/build-miami.mjs, do not edit by hand.
// Downtown Miami & Brickell in the simulation's world frame: 1 unit = 1 m, x = east, z = south, origin at the
// centreline crossing of Flagler St & Miami Ave. Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Source: © OpenStreetMap contributors (ODbL 1.0).
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${JSON.stringify(GEO)};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
