// Miami street tree sites to go with the surveyed trees (js/tree-geodata.js; OpenStreetMap maps few curbside palms):
// every ~13 m along the curbs of the blocks, 1.6 m in from the curb, about half of them planted.
import { BLOCKS } from './city-config.js';

const sites = [];
const hash = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
for (const b of BLOCKS) {
  if (b.median || b.area < 300) continue;
  const P = b.poly;
  let area = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) area += P[j].x * P[i].z - P[i].x * P[j].z;
  const inward = area > 0 ? 1 : -1;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], c = P[(i + 1) % P.length];
    const L = Math.hypot(c.x - a.x, c.z - a.z);
    if (L < 20) continue;
    const ux = (c.x - a.x) / L, uz = (c.z - a.z) / L;
    const nx = -uz * inward, nz = ux * inward;
    for (let s = 8; s < L - 8; s += 13) {
      const x = a.x + ux * s + nx * 1.6, z = a.z + uz * s + nz * 1.6;
      if (hash(x, z) < 0.5) sites.push(x, z);
    }
  }
}
export const CURB_TREES = new Float32Array(sites);
