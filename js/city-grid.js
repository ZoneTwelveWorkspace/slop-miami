import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  ISLAND_BOUNDS,
  BLOCKS,
  blockAt,
  LAND_POLYGONS,
  BRIDGE_SPANS,
  DETAIL_BOUNDS,
  isLandAt
} from './city-config.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial
} from './tsl-materials.js';
import { createRoadPaintChunkBuilder } from './road-paint.js';
import { pointInPolygon, polygonArea, polygonBounds } from './polygon.js';
import { prand } from './random.js';
import { batchStaticGroupMeshes } from './batching.js';
import { GEO } from './miami-geodata.js';

// Downtown Miami & Brickell ground: Biscayne Bay & the Miami River, the seawalls, the asphalt of every street (the land
// itself at y = 0, with the raised curb islands on top: the roads are what lies between them), sidewalks & curbs, park
// lawns, the bridge decks over the river and the bay, the I-95 / I-395 viaducts and the Metromover / Metrorail
// guideways. Exports the same names as the New York original so buildings.js & street-details.js read it unchanged.

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let centralParkClearings = null;
let parkTreeSites = [];
let parkLampSites = [];
let pavedPlazaRects = [];
let sidewalkBlocks = [];
const fdrViaduct = null;
let streetGroundSurfaces = [];

function addStreetGround(poly, height) {
  streetGroundSurfaces.push({ poly, height, ...polygonBounds(poly) });
}

function getStreetGroundHeight(x, z) {
  let height = 0.22;
  for (const s of streetGroundSurfaces) {
    if (s.height > height && x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ
      && pointInPolygon(s.poly, x, z)) height = s.height;
  }
  return height;
}

function createWorldXZShape(pts) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  return shape;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false) {
  const geo = new THREE.ExtrudeGeometry(createWorldXZShape(pts), { depth: height, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true) {
  const geo = new THREE.ShapeGeometry(createWorldXZShape(pts), 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/** Sutherland-Hodgman clip of polygon [{x, z}] to the half-plane nx * x + nz * z >= c. */
function clipPolygonHalfPlane(pts, nx, nz, c) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const da = nx * a.x + nz * a.z - c;
    const db = nx * b.x + nz * b.z - c;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/** A polygon (either winding, may be concave) clipped to an axis-aligned box. The part inside must be connected. */
function clipPolygonToBox(pts, minX, maxX, minZ, maxZ) {
  let out = clipPolygonHalfPlane(pts, 1, 0, minX);
  out = clipPolygonHalfPlane(out, -1, 0, -maxX);
  out = clipPolygonHalfPlane(out, 0, 1, minZ);
  return clipPolygonHalfPlane(out, 0, -1, -maxZ);
}

/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d); null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  const area = polygonArea(pts);
  const s = area > 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s;
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z;
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  const a2 = polygonArea(out);
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

/** Polygon offset outward by d with mitred corners clamped to 3d */
function offsetPolygonOutward(pts, d) {
  const n = pts.length;
  const s = polygonArea(pts) > 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], q = pts[i], r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z, bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9, lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s, n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const len = Math.min(3 * d, d / Math.max(1e-3, mx * n1x + mz * n1z));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  return out;
}

// A box (centre, size, yaw) appended to a list of geometries
function boxGeo(list, cx, cy, cz, w, h, d, yaw = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (yaw) g.rotateY(yaw);
  g.translate(cx, cy, cz);
  list.push(g);
}
// A flat-topped strip of width w along a polyline at height y (top) with thickness t
function stripGeo(list, pts, w, yAt, t) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.5) continue;
    const ya = yAt(k), yb = yAt(k + 1);
    const g = new THREE.BoxGeometry(L + 0.6, t, w);
    // pitch to follow ramps
    g.rotateZ(Math.atan2(yb - ya, L));
    g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
    g.translate((a.x + b.x) / 2, (ya + yb) / 2 - t / 2, (a.z + b.z) / 2);
    list.push(g);
  }
}

function buildCityGrid(scene) {
  streetGroundSurfaces = [];
  const group = new THREE.Group();
  group.name = 'MiamiCityGrid';
  const D = DETAIL_BOUNDS;
  const WATER_Y = ISLAND_BOUNDS.waterLevel;

  // Ground footprints that traffic and pedestrians must keep clear of (medians, plazas, monuments)
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  const colliders = [];

  // ===================================================================================================================
  // 1. BISCAYNE BAY & THE MIAMI RIVER
  // ===================================================================================================================
  const waterMat = createWaterMaterial();
  const waterGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.position.set(0, WATER_Y, 0);
  group.add(waterMesh);

  // ===================================================================================================================
  // 2. LAND: coral-stone seawalls around every land mass; street asphalt over the detailed area, scrubby ground beyond
  // ===================================================================================================================
  const seawallMat = new THREE.MeshStandardNodeMaterial({ color: 0x8f8a7c, roughness: 0.9, metalness: 0.0 });
  const roadMat = createRoadSurfaceMaterial();
  const groundMat = new THREE.MeshStandardNodeMaterial({ color: 0x6d7a4c, roughness: 0.95 });
  const seawallGeos = [];
  for (const ring of LAND_POLYGONS) {
    if (ring.length < 3) continue;
    const wall = offsetPolygonOutward(ring, 0.6);
    seawallGeos.push(createExtrudedPolygonMesh(wall, WATER_Y - 0.6, -WATER_Y + 0.55, seawallMat).geometry);
    const b = polygonBounds(ring);
    const inDetail = b.maxX > D.minX && b.minX < D.maxX && b.maxZ > D.minZ && b.minZ < D.maxZ;
    // beyond the detailed box: low ground (fogged out by distance)
    group.add(createFlatPolygonMesh(ring, -0.03, groundMat, true));
    if (inDetail) {
      const clipped = clipPolygonToBox(ring, D.minX, D.maxX, D.minZ, D.maxZ);
      if (clipped.length >= 3) group.add(createFlatPolygonMesh(clipped, 0.0, roadMat, true));
    }
  }
  const seawall = new THREE.Mesh(mergeGeometries(seawallGeos, false), seawallMat);
  seawall.receiveShadow = true;
  group.add(seawall);

  // ===================================================================================================================
  // 3. RAISED SIDEWALKS & CURBS: every curb island (city-config.js BLOCKS). Rectangular islands are instanced slabs,
  //    the rest extruded from their outlines. Parks get a lawn inside a sidewalk ring.
  // ===================================================================================================================
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const lawnMat = createParkLawnMaterial(false);
  const blockSidewalks = [];
  const roadSidewalks = [];
  const slabGeos = [];
  const curbGeos = [];
  const lawnGeos = [];
  const treeSites = [];
  const SW_TOP = 0.22;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();
  for (const b of BLOCKS) {
    const isPark = b.park > 0.55 && b.area > 600;
    if (b.rect && !isPark) {
      const slab = { cx: (b.minX + b.maxX) * 0.5, cz: (b.minZ + b.maxZ) * 0.5, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b };
      blockSidewalks.push(slab);
      if (b.median) addFootprint(slab.cx, slab.cz, slab.w, slab.d);
      else roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
      continue;
    }
    curbGeos.push(createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat).geometry);
    const inner = offsetPolygonInward(b.poly, 0.25);
    if (inner) slabGeos.push(createExtrudedPolygonMesh(inner, 0.03, SW_TOP - 0.03, sidewalkMat).geometry);
    if (isPark) {
      const lawn = offsetPolygonInward(b.poly, 3.2);
      if (lawn && Math.abs(polygonArea(lawn)) > 60) {
        lawnGeos.push(createFlatPolygonMesh(lawn, SW_TOP + 0.015, lawnMat).geometry);
        // palms & shade trees scattered over the lawn (a jittered 16 m lattice)
        const lb = polygonBounds(lawn);
        for (let x = lb.minX + 6; x < lb.maxX - 4; x += 16) {
          for (let z = lb.minZ + 6; z < lb.maxZ - 4; z += 16) {
            const tx = x + (prand(x, z, 1) - 0.5) * 9, tz = z + (prand(z, x, 2) - 0.5) * 9;
            if (prand(tx, tz, 3) < 0.35 || !pointInPolygon(lawn, tx, tz)) continue;
            treeSites.push({ x: tx, y: SW_TOP, z: tz, scale: 0.8 + prand(tx, tz, 4) * 0.35, species: prand(tz, tx, 5) < 0.6 ? 1 : 0, palm: prand(tx, tz, 6) < 0.7 });
          }
        }
      }
    }
    // rect cover for the consumers that work on rectangles: the lot rects grown back out to the curb
    for (const [x0, x1, z0, z1] of b.rects) {
      const r = { minX: x0 - 4.4, maxX: x1 + 4.4, minZ: z0 - 4.4, maxZ: z1 + 4.4 };
      blockSidewalks.push({ cx: (r.minX + r.maxX) * 0.5, cz: (r.minZ + r.maxZ) * 0.5, w: r.maxX - r.minX, d: r.maxZ - r.minZ, block: b, cover: true, park: isPark });
      if (!b.median) roadSidewalks.push(r);
    }
    if (!b.rects.length && !b.median) roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    if (b.median) addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
  }
  const mergeInto = (geos, mat, cast = false) => {
    for (let i = 0; i < geos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 400), false), mat);
      m.receiveShadow = true;
      m.castShadow = cast;
      group.add(m);
    }
  };
  mergeInto(curbGeos, curbMat);
  mergeInto(slabGeos, sidewalkMat);
  mergeInto(lawnGeos, lawnMat);

  const rectSlabs = blockSidewalks.filter((s) => !s.cover);
  const swInstanced = new THREE.InstancedMesh(unitBox, sidewalkMat, rectSlabs.length);
  const curbInstanced = new THREE.InstancedMesh(unitBox, curbMat, rectSlabs.length);
  swInstanced.receiveShadow = true;
  curbInstanced.receiveShadow = true;
  rectSlabs.forEach((blk, i) => {
    dummy.position.set(blk.cx, 0.125, blk.cz);
    dummy.scale.set(blk.w - 0.5, 0.19, blk.d - 0.5);
    dummy.updateMatrix();
    swInstanced.setMatrixAt(i, dummy.matrix);
    dummy.position.set(blk.cx, 0.095, blk.cz);
    dummy.scale.set(blk.w, 0.17, blk.d);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(i, dummy.matrix);
  });
  swInstanced.instanceMatrix.needsUpdate = true;
  curbInstanced.instanceMatrix.needsUpdate = true;
  group.add(swInstanced, curbInstanced);

  // ===================================================================================================================
  // 4. BRIDGE DECKS over the river & the bay: the at-grade roads' spans across open water (city-config.js
  //    BRIDGE_SPANS) get a concrete deck flush with the street, parapets and piers down to the water
  // ===================================================================================================================
  const concreteMat = new THREE.MeshStandardNodeMaterial({ color: 0xbdb7aa, roughness: 0.86 });
  const deckGeos = [];
  const parapetGeos = [];
  const pierGeos = [];
  for (const s of BRIDGE_SPANS) {
    const L = Math.hypot(s.bx - s.ax, s.bz - s.az);
    if (L < 1) continue;
    const ux = (s.bx - s.ax) / L, uz = (s.bz - s.az) / L;
    const yaw = -Math.atan2(uz, ux);
    const w = s.half * 2 + 3.2; // roadway + a sidewalk each side
    const cx = (s.ax + s.bx) / 2, cz = (s.az + s.bz) / 2;
    // asphalt flush with the street (y = 0) over a 1.4 m concrete deck
    const top = new THREE.PlaneGeometry(L + 0.8, w);
    top.rotateX(-Math.PI / 2);
    top.rotateY(yaw);
    top.translate(cx, 0.0, cz);
    deckGeos.push(top);
    boxGeo(pierGeos, cx, -0.72, cz, L + 0.8, 1.4, w, yaw);
    // parapets along both edges where the span is over water
    for (const side of [-1, 1]) {
      const px = cx - uz * side * (w / 2 - 0.25), pz = cz + ux * side * (w / 2 - 0.25);
      if (isLandAt(px, pz) && s.wet < 0.9) continue;
      boxGeo(parapetGeos, px, 0.55, pz, L + 0.8, 1.1, 0.4, yaw);
      colliders.push({ minX: Math.min(px - ux * L / 2, px + ux * L / 2) - 0.3, maxX: Math.max(px - ux * L / 2, px + ux * L / 2) + 0.3,
        minZ: Math.min(pz - uz * L / 2, pz + uz * L / 2) - 0.3, maxZ: Math.max(pz - uz * L / 2, pz + uz * L / 2) + 0.3, minY: 0, maxY: 1.1,
        polygon: { holes: [], outer: [
          { x: px - ux * L / 2 - uz * 0.25, z: pz - uz * L / 2 + ux * 0.25 }, { x: px + ux * L / 2 - uz * 0.25, z: pz + uz * L / 2 + ux * 0.25 },
          { x: px + ux * L / 2 + uz * 0.25, z: pz + uz * L / 2 - ux * 0.25 }, { x: px - ux * L / 2 + uz * 0.25, z: pz - uz * L / 2 - ux * 0.25 }
        ] } });
    }
    // piers every ~24 m standing in the water
    for (let t = 12; t < L; t += 24) {
      const x = s.ax + ux * t, z = s.az + uz * t;
      if (isLandAt(x, z)) continue;
      boxGeo(pierGeos, x, (WATER_Y - 1.4) / 2 - 0.7, z, 2.2, -WATER_Y + 0.2, w * 0.8, yaw);
    }
  }
  if (deckGeos.length) {
    const deck = new THREE.Mesh(mergeGeometries(deckGeos, false), roadMat);
    deck.receiveShadow = true;
    group.add(deck);
    mergeInto(pierGeos, concreteMat, true);
    if (parapetGeos.length) mergeInto(parapetGeos, concreteMat, true);
  }

  // ===================================================================================================================
  // 5. ELEVATED: the I-95 / I-395 viaducts & ramps and the Metromover / Metrorail guideways, on columns that stand on
  //    the blocks (never in a roadway, so they don't obstruct the streets below)
  // ===================================================================================================================
  const viaductGeos = [];
  const columnGeos = [];
  const guideGeos = [];
  const toPts = (flat) => {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
    return out;
  };
  const column = (x, z, top, r) => {
    if (!blockAt(x, z)) return;
    boxGeo(columnGeos, x, top / 2, z, r, top, r);
    colliders.push({ minX: x - r / 2, maxX: x + r / 2, minZ: z - r / 2, maxZ: z + r / 2, minY: 0, maxY: top });
  };
  for (const [, w, , , layer, flat] of GEO.elevated || []) {
    const pts = toPts(flat);
    if (pts.length < 2) continue;
    const h = 7.5 + Math.max(0, layer - 1) * 6.5;
    stripGeo(viaductGeos, pts, w + 1.5, () => h, 1.6);
    let acc = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      for (let t = (35 - (acc % 35)) % 35; t < L; t += 35) column(a.x + ((b.x - a.x) * t) / L, a.z + ((b.z - a.z) * t) / L, h - 1.6, 2.0);
      acc += L;
    }
  }
  for (const line of GEO.transit || []) {
    if (!line.elevated) continue;
    const pts = toPts(line.pts);
    const h = line.kind === 'monorail' || line.kind === 'light_rail' ? 7.0 : 9.5;
    stripGeo(guideGeos, pts, line.kind === 'subway' || line.kind === 'rail' ? 8.5 : 3.2, () => h, 1.3);
    let acc = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      for (let t = (30 - (acc % 30)) % 30; t < L; t += 30) column(a.x + ((b.x - a.x) * t) / L, a.z + ((b.z - a.z) * t) / L, h - 1.3, 1.4);
      acc += L;
    }
  }
  mergeInto(viaductGeos, concreteMat, true);
  mergeInto(columnGeos, concreteMat, true);
  mergeInto(guideGeos, concreteMat, true);

  // Road paint: lane lines, crosswalks & stop bars along the network (painted by road-paint.js after the traffic is built)
  const roadPaint = createRoadPaintChunkBuilder('RoadMarkings');

  batchStaticGroupMeshes(group, new Set([waterMat, roadMat, lawnMat]));
  scene.add(group);

  parkTreeSites = treeSites;
  parkLampSites = [];
  pavedPlazaRects = [];
  sidewalkBlocks = blockSidewalks;
  centralParkClearings = null;

  return { group, sidewalks: roadSidewalks, footprints, highwayLanes: [], colliders, roadPaint };
}

export {
  buildCityGrid,
  getStreetGroundHeight,
  centralParkClearings,
  parkTreeSites,
  parkLampSites,
  pavedPlazaRects,
  sidewalkBlocks,
  fdrViaduct
};
