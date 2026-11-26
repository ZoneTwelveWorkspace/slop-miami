import * as THREE from 'three/webgpu';
import { DETAIL_BOUNDS, isLandAt, ISLAND_BOUNDS } from './city-config.js';
import { prand } from './random.js';
import { GEO } from './miami-geodata.js';

// Miami beyond the detailed area: the low-rise mainland around it (Overtown, Little Havana, the Roads, Edgewater)
// and, across Biscayne Bay, Miami Beach's hotel & condo skyline on its barrier island. Instanced stucco boxes on the
// real land (the 4 m land mask) outside the detailed box, fading into the haze — the skyline you look out at.

// Miami Beach (west shore along Alton Rd / the bay, east shore the Atlantic), in the world frame
const LAT_M = 110800;
const LON_M = 100250;
const toX = (lon) => (lon - GEO.frame.lon) * LON_M;
const toZ = (lat) => -(lat - GEO.frame.lat) * LAT_M;
const MIAMI_BEACH = { minX: toX(-80.1430), maxX: toX(-80.1260), minZ: toZ(25.8600), maxZ: toZ(25.7680) };

function buildBoroughs(scene) {
  const group = new THREE.Group();
  group.name = 'MiamiSurroundings';
  const D = DETAIL_BOUNDS;
  const W = GEO.frame.world;

  // Miami Beach island (beyond the world box's land mask): sand-coloured land on the bay
  const beachMat = new THREE.MeshStandardNodeMaterial({ color: 0xc9b98f, roughness: 0.95 });
  const mb = MIAMI_BEACH;
  const beachGeo = new THREE.BoxGeometry(mb.maxX - mb.minX, 1.2, mb.maxZ - mb.minZ);
  beachGeo.translate((mb.minX + mb.maxX) / 2, ISLAND_BOUNDS.waterLevel + 0.4, (mb.minZ + mb.maxZ) / 2);
  const beach = new THREE.Mesh(beachGeo, beachMat);
  beach.receiveShadow = true;
  group.add(beach);

  // Buildings: [x, z, w, d, h] — mainland low-rise around the detailed box, Miami Beach's towers along its shore
  const sites = [];
  const STEP = 34;
  for (let x = W.minX + 20; x < W.maxX - 20; x += STEP) {
    for (let z = W.minZ + 20; z < W.maxZ - 20; z += STEP) {
      const jx = x + (prand(x, z, 11) - 0.5) * 14, jz = z + (prand(z, x, 12) - 0.5) * 14;
      if (jx > D.minX - 40 && jx < D.maxX + 40 && jz > D.minZ - 40 && jz < D.maxZ + 40) continue;
      if (!isLandAt(jx, jz) || !isLandAt(jx + 12, jz) || !isLandAt(jx - 12, jz) || !isLandAt(jx, jz + 12) || !isLandAt(jx, jz - 12)) continue;
      if (prand(jx, jz, 13) < 0.25) continue;
      // Edgewater's condo towers north of the box along the bay, low-rise everywhere else
      const edgewater = jz < D.minZ && jx > D.minX + 600;
      const r = prand(jx, jz, 14);
      const h = edgewater && r > 0.6 ? 40 + r * 120 : 5 + r * r * 22;
      sites.push([jx, jz, 12 + prand(jx, jz, 15) * 16, 12 + prand(jz, jx, 16) * 16, h]);
    }
  }
  for (let z = mb.minZ + 30; z < mb.maxZ - 30; z += 38) {
    for (let x = mb.minX + 40; x < mb.maxX - 40; x += 46) {
      if (prand(x, z, 21) < 0.2) continue;
      const nearOcean = x > mb.maxX - 320;
      const r = prand(x, z, 22);
      const h = nearOcean ? 25 + r * r * 140 : 8 + r * 30;
      sites.push([x + (prand(z, x, 23) - 0.5) * 12, z, 18 + r * 22, 18 + prand(x, z, 24) * 20, h]);
    }
  }

  const stuccoMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(box, stuccoMat, sites.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const PALETTE = [0xf2ede2, 0xe9e2d0, 0xf4e1c8, 0xd8e8e4, 0xf1d6d0, 0xe2e6ea, 0xc8d4d8, 0xf5f3ee];
  sites.forEach(([x, z, w, d, h], i) => {
    m.makeScale(w, h, d).setPosition(x, x > mb.minX - 20 ? ISLAND_BOUNDS.waterLevel + 1.0 : 0, z);
    mesh.setMatrixAt(i, m);
    c.setHex(PALETTE[Math.floor(prand(x, z, 31) * PALETTE.length)]).multiplyScalar(0.85 + prand(z, x, 32) * 0.2);
    mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);

  scene.add(group);
  return { group, colliders: [], update: null };
}

export { buildBoroughs };
