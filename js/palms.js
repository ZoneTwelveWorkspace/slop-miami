import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, smoothstep, uv, fract } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { minStdRandom, prand } from './random.js';

// Palm trees for Miami's streets & parks (royal / coconut / sabal-like): a gently bowed trunk with ring scars and a
// crown of arching fronds, each frond a rachis carrying two rows of drooping leaflets. A few variants are built once
// and instanced over every site; sites are { x, y, z, scale, yaw? }.

const VARIANTS = 3;

function trunkGeometry(rng, height, lean) {
  const SEG = 12, RAD = 8;
  const pos = [], uvs = [], idx = [];
  const bowX = lean * (0.6 + rng() * 0.6), bowZ = lean * (rng() - 0.5) * 0.6;
  const at = (t) => {
    const y = t * height;
    // a bow that grows toward the top (trunks lean out of the wind and curve back up)
    return [bowX * t * t * height * 0.12, y, bowZ * t * t * height * 0.12];
  };
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const [cx, cy, cz] = at(t);
    // swollen base, slim neck under the crown shaft
    const r = 0.24 * (1 + 0.55 * Math.exp(-t * 9)) * (1 - 0.28 * t);
    for (let j = 0; j <= RAD; j++) {
      const a = (j / RAD) * Math.PI * 2;
      pos.push(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r);
      uvs.push(j / RAD, t * height);
    }
  }
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < RAD; j++) {
      const a = i * (RAD + 1) + j, b = a + RAD + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, top: at(1) };
}

function crownGeometry(rng, top) {
  const pos = [], idx = [], uvs = [];
  const quad = (a, b, c, d, u0, u1) => {
    const n = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uvs.push(u0, 0, u0, 1, u1, 1, u1, 0);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  const fronds = 10 + Math.floor(rng() * 3);
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + rng() * 0.4;
    const len = 3.6 + rng() * 1.4;
    const rise = 0.35 + rng() * 0.55; // how high the frond arches before it droops
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    // rachis: an arc out and down from the crown
    const N = 9;
    const rach = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const out = t * len;
      const y = rise * len * t * (1 - t) * 1.6 - t * t * len * 0.55;
      rach.push([top[0] + dx * out, top[1] + y + 0.2, top[2] + dz * out]);
    }
    for (let i = 0; i < N; i++) {
      const p = rach[i], q = rach[i + 1];
      const t = (i + 0.5) / N;
      // leaflets droop from the rachis on both sides, longest mid-frond
      const leaf = (0.55 + 0.9 * Math.sin(Math.PI * Math.min(1, t * 1.15))) * (1 - t * 0.35);
      for (const side of [-1, 1]) {
        const sx = -dz * side, sz = dx * side;
        const droop = 0.35 + t * 0.5;
        const tipP = [p[0] + sx * leaf + dx * 0.25, p[1] - leaf * droop, p[2] + sz * leaf + dz * 0.25];
        const tipQ = [q[0] + sx * leaf + dx * 0.25, q[1] - leaf * droop, q[2] + sz * leaf + dz * 0.25];
        quad(p, tipP, tipQ, q, t, t + 1 / N);
      }
    }
  }
  // the crown shaft & husks at the top of the trunk
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const husk = new THREE.SphereGeometry(0.42, 8, 5).scale(1, 1.25, 1).translate(top[0], top[1] + 0.05, top[2]);
  husk.deleteAttribute('uv');
  husk.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(husk.attributes.position.count * 2), 2));
  return { fronds: g, husk };
}

function createPalmMaterials() {
  const bark = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  // grey-tan trunk with darker leaf-scar rings every ~0.3 m, greener toward the crown shaft
  const band = fract(uv().y.mul(3.4));
  const ring = smoothstep(0.35, 0.5, band).mul(smoothstep(0.65, 0.5, band));
  bark.colorNode = mix(mix(color(0x9a8c78), color(0x6f6656), ring.mul(0.6)), color(0x6f7a4a), smoothstep(7.0, 12.0, positionLocal.y));
  const frond = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, side: THREE.DoubleSide });
  // lighter rachis side, yellowing toward the tips
  frond.colorNode = mix(mix(color(0x3d6a26), color(0x5a8a32), uv().y.mul(0.6)), color(0x9aa04a), smoothstep(0.75, 1.0, uv().x).mul(0.55));
  const husk = new THREE.MeshStandardNodeMaterial({ color: 0x7a6a44, roughness: 0.95 });
  return { bark, frond, husk };
}

/**
 * Instanced palms over `sites` ({ x, y, z, scale, yaw? }). Returns { group, colliders, count }.
 */
function createPalmField(sites) {
  const group = new THREE.Group();
  group.name = 'Palms';
  const mats = createPalmMaterials();
  const variants = [];
  for (let v = 0; v < VARIANTS; v++) {
    const rng = minStdRandom(9173 * (v + 1));
    const height = 8.5 + v * 2.2 + rng() * 1.5;
    const trunk = trunkGeometry(rng, height, 0.6 + rng() * 0.8);
    const crown = crownGeometry(rng, trunk.top);
    variants.push({ trunk: trunk.geo, fronds: crown.fronds, husk: crown.husk });
  }
  const buckets = variants.map(() => []);
  for (const s of sites) buckets[Math.min(VARIANTS - 1, Math.floor(prand(s.x, s.z, 41) * VARIANTS))].push(s);
  const colliders = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  variants.forEach((v, i) => {
    const list = buckets[i];
    if (!list.length) return;
    const parts = [[v.trunk, mats.bark], [v.fronds, mats.frond], [mergeGeometries([v.husk], false), mats.husk]];
    for (const [geo, mat] of parts) {
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((s, k) => {
        const yaw = s.yaw ?? prand(s.z, s.x, 42) * Math.PI * 2;
        q.setFromAxisAngle(up, yaw);
        const k2 = s.scale || 1;
        sc.set(k2, k2, k2);
        p.set(s.x, s.y || 0, s.z);
        m.compose(p, q, sc);
        inst.setMatrixAt(k, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      group.add(inst);
    }
    for (const s of list) colliders.push({ minX: s.x - 0.35, maxX: s.x + 0.35, minZ: s.z - 0.35, maxZ: s.z + 0.35, minY: s.y || 0, maxY: (s.y || 0) + 9 });
  });
  return { group, colliders, count: sites.length };
}

export { createPalmField };
