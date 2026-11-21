// Prepares an Avatar SDK "Head 2.0" bust (one mesh, one texture, 66 blendshapes, no normals) for
// the course's talking face:
//  - smooth normals (the sample has none, so it would be drawn faceted);
//  - three parts with their own materials: skin (with hair and clothes), eyes (they get a glossy
//    coat) and mouth (teeth, tongue, inside: kept dark and wet), found from the mesh itself;
//  - mouth shapes renamed to Oculus viseme names (viseme_aa…), as the lip-sync module calls them;
//  - blendshape deltas as 16-bit numbers, everything meshopt-compressed.
//  - optionally, the texture rebuilt by face-ai/bake.py (sharper and compact), with its map of
//    hair, lips and skin, and long hair from another model.
// Usage: node prep-bust.mjs <in.glb> <out.glb> [drop=name,name…] [atlas=<dir>] [hair=<file.glb>[,scale,dx,dy,dz,wide,deep]]
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";

const [input, output] = process.argv.slice(2);
// Face shapes the course's engine never uses are left out (less to download and to keep in memory).
const UNUSED = "cheekPuff,jawForward,jawLeft,jawRight,mouthClose,mouthDimpleLeft,mouthDimpleRight,mouthFunnel,mouthLeft,mouthRight,mouthLowerDownLeft,mouthLowerDownRight,mouthPressLeft,mouthPressRight,mouthPucker,mouthRollLower,mouthRollUpper,mouthShrugLower,mouthShrugUpper,mouthStretchLeft,mouthStretchRight,mouthUpperUpLeft,mouthUpperUpRight,noseSneerLeft,noseSneerRight";
const DROP = new Set((process.argv.slice(4).find((a) => a.startsWith("drop=")) ?? `drop=${UNUSED}`).replace(/^drop=/, "").split(",").filter(Boolean));
const hairArg = process.argv.slice(4).find((a) => a.startsWith("hair="));
// atlas=<dir>: the rebuilt texture from face-ai/bake.py (atlas.png, mask.png, uv.f32, meta.json)
const atlasDir = (process.argv.slice(4).find((a) => a.startsWith("atlas=")) ?? "").slice(6) || null;
const SCALP_IN = 0.007; // metres
const UNDER_HAIR = 0.16; // how dark the painted hair gets under the added hair (a multiplier, in linear light)
const VISEMES = { aa: "viseme_aa", E: "viseme_E", ih: "viseme_I", oh: "viseme_O", ou: "viseme_U", PP: "viseme_PP", FF: "viseme_FF", TH: "viseme_TH", DD: "viseme_DD", kk: "viseme_kk", CH: "viseme_CH", SS: "viseme_SS", nn: "viseme_nn", RR: "viseme_RR", Laughter: "laughter" };

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(input);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];
const mesh = root.listMeshes()[0];
const prim = mesh.listPrimitives()[0];
const material = prim.getMaterial();
const texture = material.getBaseColorTexture();
const [TW, TH_] = texture.getSize();
const joints = root.listSkins()[0].listJoints().map((j) => j.getName());
const eyeJoints = new Set(joints.map((n, i) => (/^eye/i.test(n) ? i : -1)).filter((i) => i >= 0));

const idx = prim.getIndices().getArray();
const P = prim.getAttribute("POSITION").getArray();
const UV = prim.getAttribute("TEXCOORD_0").getArray();
const J = prim.getAttribute("JOINTS_0").getArray();
const W = prim.getAttribute("WEIGHTS_0").getArray();
const count = P.length / 3;
let names = mesh.getExtras().targetNames;
let targets = prim.listTargets().map((t) => t.getAttribute("POSITION").getArray());
const keep = names.map((n) => !DROP.has(n));
targets = targets.filter((_, k) => keep[k]);
names = names.filter((_, k) => keep[k]).map((n) => VISEMES[n] ?? n);

// ---- the rebuilt texture, if any: new texture coordinates for every vertex, and the map of hair, lips and skin
let UV2 = UV, look = null, maskRaw = null;
if (atlasDir) {
  const { readFileSync } = await import("node:fs");
  const sharp = (await import("sharp")).default;
  const raw = readFileSync(`${atlasDir}/uv.f32`);
  UV2 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (UV2.length !== UV.length) throw new Error("uv.f32 is for another model");
  look = JSON.parse(readFileSync(`${atlasDir}/meta.json`, "utf8"));
  maskRaw = await sharp(`${atlasDir}/mask.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}
// how much a vertex is hair on the head itself (not brows or beard, which have skin under them): 0…1
const scalpAt = (i) => {
  const { data, info } = maskRaw;
  const x = Math.min(info.width - 1, Math.max(0, Math.floor(UV2[i * 2] * info.width))), y = Math.min(info.height - 1, Math.max(0, Math.floor(UV2[i * 2 + 1] * info.height)));
  const o = (y * info.width + x) * 3;
  return (data[o] / 255) * (1 - data[o + 2] / 255);
};

// ---- smooth normals: face normals summed (so weighted by area) over vertices at the same place,
// so the texture's seams don't show as creases
const place = new Map();
const placeOf = new Uint32Array(count);
for (let i = 0; i < count; i++) {
  const k = `${Math.round(P[i * 3] * 2e5)},${Math.round(P[i * 3 + 1] * 2e5)},${Math.round(P[i * 3 + 2] * 2e5)}`;
  if (!place.has(k)) place.set(k, place.size);
  placeOf[i] = place.get(k);
}
const sum = new Float64Array(place.size * 3);
for (let t = 0; t < idx.length; t += 3) {
  const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  for (const v of [idx[t], idx[t + 1], idx[t + 2]]) for (let a2 = 0; a2 < 3; a2++) sum[placeOf[v] * 3 + a2] += n[a2];
}
const N = new Float32Array(count * 3);
for (let i = 0; i < count; i++) {
  const s = placeOf[i] * 3;
  const l = Math.hypot(sum[s], sum[s + 1], sum[s + 2]) || 1;
  N[i * 3] = sum[s] / l; N[i * 3 + 1] = sum[s + 1] / l; N[i * 3 + 2] = sum[s + 2] / l;
}

// ---- parts: islands of the mesh (triangles joined by shared vertices) sorted into eyes (they
// follow the eye bones), mouth (small islands in the left, square half of the texture: teeth,
// tongue, the inside of the mouth) and skin (the rest)
const parent = new Uint32Array(count).map((_, i) => i);
const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
for (let t = 0; t < idx.length; t += 3) {
  const a = find(idx[t]);
  parent[find(idx[t + 1])] = a;
  parent[find(idx[t + 2])] = a;
}
const islands = new Map(); // root → { verts, eye, uMax }
for (let i = 0; i < count; i++) {
  const r = find(i);
  if (!islands.has(r)) islands.set(r, { verts: 0, eye: 0, uMax: 0, uMin: 1, vMin: 1, vMax: 0, lo: [9, 9, 9], hi: [-9, -9, -9] });
  const s = islands.get(r);
  s.verts++;
  let eyeWeight = 0;
  for (let k = 0; k < 4; k++) if (eyeJoints.has(J[i * 4 + k])) eyeWeight += W[i * 4 + k];
  if (eyeWeight > 0.5) s.eye++;
  s.uMax = Math.max(s.uMax, UV[i * 2]); s.uMin = Math.min(s.uMin, UV[i * 2]);
  s.vMax = Math.max(s.vMax, UV[i * 2 + 1]); s.vMin = Math.min(s.vMin, UV[i * 2 + 1]);
  for (let a = 0; a < 3; a++) { s.lo[a] = Math.min(s.lo[a], P[i * 3 + a]); s.hi[a] = Math.max(s.hi[a], P[i * 3 + a]); }
}
const square = TH_ / TW; // the left square of a 2:1 texture ends at u = 0.5
const biggest = [...islands.values()].filter((s) => s.uMax <= square + 0.002).sort((a, b) => b.verts - a.verts)[0];
for (const s of islands.values()) {
  s.part = s.eye > s.verts / 2 ? "eyes" : s.uMax <= square + 0.002 && s !== biggest ? "mouth" : "skin";
  if (s.part === "mouth" && s.uMax * TW < 820 && s.vMax * TH_ < 560) s.part = "teeth"; // each tooth is an island in the texture's top left corner
}
const report = {};
for (const s of islands.values()) {
  const r = (report[s.part] ??= { islands: 0, verts: 0 });
  r.islands++; r.verts += s.verts;
}
console.log("parts:", JSON.stringify(report));
if (process.env.VERBOSE) for (const s of islands.values()) console.log(s.part, s.verts, "u", (s.uMin * TW).toFixed(0), (s.uMax * TW).toFixed(0), "v", (s.vMin * TH_).toFixed(0), (s.vMax * TH_).toFixed(0), "x", s.lo[0].toFixed(3), s.hi[0].toFixed(3), "y", s.lo[1].toFixed(3), s.hi[1].toFixed(3), "z", s.lo[2].toFixed(3), s.hi[2].toFixed(3));

// ---- under added hair, the head's own painted hair is pushed in a little so that it doesn't show
// through: where the texture is as dark as hair, above the brows; eased over the neighbours so the
// forehead stays smooth
let under = null; // per vertex, 0…1: how much it lies under the added hair
if (hairArg) {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(Buffer.from(texture.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const luma = (i) => {
    const x = Math.min(info.width - 1, Math.round(UV[i * 2] * info.width)), y = Math.min(info.height - 1, Math.round(UV[i * 2 + 1] * info.height));
    const o = (y * info.width + x) * 3;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  };
  const step = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  let w = new Float32Array(place.size);
  const seen = new Float32Array(place.size);
  for (let i = 0; i < count; i++) {
    if (islands.get(find(i)).part !== "skin") continue;
    w[placeOf[i]] += (maskRaw ? scalpAt(i) : step(190, 150, luma(i))) * step(0.15, 0.17, P[i * 3 + 1]);
    seen[placeOf[i]]++;
  }
  for (let k = 0; k < w.length; k++) if (seen[k]) w[k] /= seen[k];
  const near = Array.from({ length: place.size }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = placeOf[idx[t]], b = placeOf[idx[t + 1]], c = placeOf[idx[t + 2]];
    near[a].add(b).add(c); near[b].add(a).add(c); near[c].add(a).add(b);
  }
  for (let pass = 0; pass < 6; pass++) {
    const next = new Float32Array(w.length);
    for (let k = 0; k < w.length; k++) {
      let sum = w[k];
      for (const j of near[k]) sum += w[j];
      next[k] = sum / (near[k].size + 1);
    }
    w = next;
  }
  let pushed = 0;
  under = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    under[i] = w[placeOf[i]];
    const d = SCALP_IN * under[i];
    if (d < 1e-5) continue;
    pushed++;
    for (let a = 0; a < 3; a++) P[i * 3 + a] -= N[i * 3 + a] * d;
  }
  console.log(`scalp: ${pushed} vertices pushed in by up to ${SCALP_IN * 1000} mm`);
}

// ---- build the three primitives
const accessor = (array, type, normalized = false) => doc.createAccessor().setArray(array).setType(type).setNormalized(normalized).setBuffer(buffer);
let colour = texture, maskTexture = null;
if (atlasDir) {
  const sharp = (await import("sharp")).default;
  const { EXTTextureWebP } = await import("@gltf-transform/extensions");
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const webp = await sharp(`${atlasDir}/atlas.png`).webp({ quality: 90, effort: 6 }).toBuffer();
  const png = await sharp(`${atlasDir}/mask.png`).webp({ quality: 92, effort: 6 }).toBuffer();
  colour = doc.createTexture("Face").setImage(new Uint8Array(webp)).setMimeType("image/webp");
  maskTexture = doc.createTexture("FaceMask").setImage(new Uint8Array(png)).setMimeType("image/webp");
  console.log(`texture: ${look.size.join("x")}, webp ${(webp.byteLength / 1024).toFixed(0)} kB; mask webp ${(png.byteLength / 1024).toFixed(0)} kB`);
}
const materials = Object.fromEntries(["skin", "eyes", "teeth", "mouth"].map((part) => {
  const m = doc.createMaterial(part[0].toUpperCase() + part.slice(1)).setBaseColorTexture(colour).setRoughnessFactor(material.getRoughnessFactor()).setMetallicFactor(0);
  // The map of hair, lips and skin rides in the occlusion slot, at strength 0: a viewer ignores
  // it, the course's engine recolours with it. `look` holds the average brightness of each.
  if (maskTexture && (part === "skin" || part === "eyes")) m.setOcclusionTexture(maskTexture).setOcclusionStrength(0).setExtras({ look: look.luma });
  return [part, m];
}));
prim.detach();
mesh.listPrimitives().forEach((p) => mesh.removePrimitive(p));
let zeroed = 0;
for (const part of ["skin", "eyes", "teeth", "mouth"]) {
  const tris = [];
  for (let t = 0; t < idx.length; t += 3) if (islands.get(find(idx[t])).part === part) tris.push(idx[t], idx[t + 1], idx[t + 2]);
  const map = new Map();
  for (const v of tris) if (!map.has(v)) map.set(v, map.size);
  const n = map.size;
  const order = [...map.keys()];
  const pos = new Float32Array(n * 3), nor = new Int8Array(n * 3), uv = new Uint16Array(n * 2), jt = new Uint8Array(n * 4), wt = new Uint8Array(n * 4);
  order.forEach((v, i) => {
    for (let a = 0; a < 3; a++) { pos[i * 3 + a] = P[v * 3 + a]; nor[i * 3 + a] = Math.round(N[v * 3 + a] * 127); }
    for (let a = 0; a < 2; a++) uv[i * 2 + a] = Math.round(Math.min(1, Math.max(0, UV2[v * 2 + a])) * 65535);
    // weights as bytes that add up to 255 exactly
    const w = [0, 1, 2, 3].map((k) => W[v * 4 + k]);
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const bytes = w.map((x) => Math.round((x / total) * 255));
    bytes[bytes.indexOf(Math.max(...bytes))] += 255 - bytes.reduce((a, b) => a + b, 0);
    for (let k = 0; k < 4; k++) { jt[i * 4 + k] = bytes[k] ? J[v * 4 + k] : 0; wt[i * 4 + k] = bytes[k]; }
  });
  const indices = n > 65535 ? new Uint32Array(tris.length) : new Uint16Array(tris.length);
  tris.forEach((v, i) => { indices[i] = map.get(v); });
  const p = doc.createPrimitive()
    .setIndices(accessor(indices, "SCALAR"))
    .setAttribute("POSITION", accessor(pos, "VEC3"))
    .setAttribute("NORMAL", accessor(nor, "VEC3", true))
    .setAttribute("TEXCOORD_0", accessor(uv, "VEC2", true))
    .setAttribute("JOINTS_0", accessor(jt, "VEC4"))
    .setAttribute("WEIGHTS_0", accessor(wt, "VEC4", true))
    .setMaterial(materials[part]);
  if (under && part === "skin" && !atlasDir) { // with the rebuilt texture the engine darkens it itself, by the map of what is hair
    // the painted hair under the added hair is darkened (vertex colours multiply the texture), so
    // that what shows between the strands reads as hair in shadow, not as scalp
    const col = new Uint8Array(n * 3);
    order.forEach((v, i) => {
      const t = Math.min(1, Math.max(0, (under[v] - 0.25) / 0.5));
      col.fill(Math.round(255 * (1 - (1 - UNDER_HAIR) * t * t * (3 - 2 * t))), i * 3, i * 3 + 3);
    });
    p.setAttribute("COLOR_0", accessor(col, "VEC3", true));
  }
  targets.forEach((src, k) => {
    const d = new Int16Array(n * 3);
    order.forEach((v, i) => {
      // movements under 0.02 mm are noise: zero them, they compress to nothing
      const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
      if (Math.hypot(x, y, z) < 2e-5) { zeroed++; return; }
      d[i * 3] = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
      d[i * 3 + 1] = Math.round(Math.max(-1, Math.min(1, y)) * 32767);
      d[i * 3 + 2] = Math.round(Math.max(-1, Math.min(1, z)) * 32767);
    });
    // the writer takes the blendshape names from the targets' own names
    p.addTarget(doc.createPrimitiveTarget(names[k]).setAttribute("POSITION", accessor(d, "VEC3", true)));
  });
  mesh.addPrimitive(p);
  console.log(`${part}: ${n} vertices, ${tris.length / 3} triangles`);
}
mesh.setName("Bust").setExtras({ ...mesh.getExtras(), targetNames: names }).setWeights(names.map(() => 0));
console.log(`${names.length} blendshapes: ${names.join(" ")}`);

// ---- hair (optional): the long hair of another model, set on this head. It is moved so that the
// two models' eyes meet, scaled, and bound to this bust's bones (what followed the other model's
// head follows this head; what lay on its shoulders stays with the chest).
// hair=<file.glb>[,scale,dx,dy,dz,wide,deep]
if (hairArg) {
  const sharp = (await import("sharp")).default;
  const { EXTTextureWebP } = await import("@gltf-transform/extensions");
  const [file, ...nums] = hairArg.slice(5).split(",");
  const [scale = 1, dx = 0, dy = 0, dz = 0, wide = 1, deep = 1] = nums.map(Number);
  const src = await io.read(file);
  const sroot = src.getRoot();
  const at = (r, name) => r.listNodes().find((n) => n.getName() === name).getWorldTranslation();
  const mid = (a, b) => a.map((x, i) => (x + b[i]) / 2);
  const from = mid(at(sroot, "LeftEye"), at(sroot, "RightEye"));
  const to = mid(at(root, "eyeLeft"), at(root, "eyeRight"));
  const k = [scale * wide, scale, scale * deep];
  const move = [dx, dy, dz];
  console.log(`hair: eyes ${from.map((x) => x.toFixed(4))} → ${to.map((x) => x.toFixed(4))}, scale ${k}`);
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const skin = root.listSkins()[0];
  const hairMesh = doc.createMesh("Hair");
  const textures = new Map(); // a source texture → its copy here, as WebP
  // The strands' colour is spread into the transparent pixels around them (they are black in the
  // source), so that filtering the texture doesn't darken the strands' edges.
  const bleed = async (image) => {
    const { data, info } = await sharp(Buffer.from(image)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const known = new Uint8Array(w * h);
    const mean = [0, 0, 0, 0];
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4 + 3] < 32) continue;
      known[i] = 1;
      for (let c = 0; c < 3; c++) mean[c] += data[i * 4 + c];
      mean[3]++;
    }
    for (let pass = 0; pass < 48; pass++) {
      const add = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const j = yy * w + xx;
          if (!known[j]) continue;
          r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; n++;
        }
        if (n) add.push(i, r / n, g / n, b / n);
      }
      if (!add.length) break;
      for (let k = 0; k < add.length; k += 4) {
        const i = add[k];
        data[i * 4] = add[k + 1]; data[i * 4 + 1] = add[k + 2]; data[i * 4 + 2] = add[k + 3];
        known[i] = 1;
      }
    }
    for (let i = 0; i < w * h; i++) if (!known[i]) for (let c = 0; c < 3; c++) data[i * 4 + c] = mean[c] / mean[3];
    return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  };
  // the average brightness of the strands (in linear light): the engine recolours them by it
  const strandsOf = async (t) => {
    const { data } = await sharp(Buffer.from(t.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const lin = (x) => (x / 255) ** 2.2;
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2]);
      n++;
    }
    return sum / Math.max(1, n);
  };
  const copyTexture = async (t, name, quality, spread = false) => {
    if (!t) return null;
    if (!textures.has(t)) {
      const image = spread ? await bleed(t.getImage()) : Buffer.from(t.getImage());
      const webp = await sharp(image).webp({ quality, alphaQuality: 100, effort: 6 }).toBuffer();
      console.log(`  ${name}: ${t.getSize().join("x")} ${(t.getImage().byteLength / 1024).toFixed(0)} kB → webp ${(webp.byteLength / 1024).toFixed(0)} kB`);
      textures.set(t, doc.createTexture(name).setImage(new Uint8Array(webp)).setMimeType("image/webp"));
    }
    return textures.get(t);
  };
  for (const node of sroot.listNodes()) {
    if (!/hair/i.test(node.getName()) || !node.getMesh()) continue;
    const their = node.getSkin().listJoints().map((j) => j.getName());
    const mine = (name) => joints.indexOf(name === "Head" ? "head" : name === "Neck" ? "neck" : "chest");
    for (const sp of node.getMesh().listPrimitives()) {
      const sP = sp.getAttribute("POSITION"), sN = sp.getAttribute("NORMAL"), sUV = sp.getAttribute("TEXCOORD_0"), sJ = sp.getAttribute("JOINTS_0"), sW = sp.getAttribute("WEIGHTS_0");
      const n = sP.getCount();
      const pos = new Float32Array(n * 3), nor = new Int8Array(n * 3), uv = new Uint16Array(n * 2), jt = new Uint8Array(n * 4), wt = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const p = sP.getElement(i, []), nn = sN.getElement(i, []), t = sUV.getElement(i, []), j = sJ.getElement(i, []), w = sW.getElement(i, []);
        for (let a = 0; a < 3; a++) pos[i * 3 + a] = (p[a] - from[a]) * k[a] + to[a] + move[a];
        const nl = Math.hypot(nn[0] / k[0], nn[1] / k[1], nn[2] / k[2]) || 1;
        for (let a = 0; a < 3; a++) nor[i * 3 + a] = Math.round((nn[a] / k[a] / nl) * 127);
        for (let a = 0; a < 2; a++) uv[i * 2 + a] = Math.round(Math.min(1, Math.max(0, t[a])) * 65535);
        const sumBy = new Map();
        for (let c = 0; c < 4; c++) if (w[c] > 0) sumBy.set(mine(their[j[c]]), (sumBy.get(mine(their[j[c]])) ?? 0) + w[c]);
        const total = [...sumBy.values()].reduce((a, b) => a + b, 0) || 1;
        const pairs = [...sumBy].map(([joint, x]) => [joint, Math.round((x / total) * 255)]).sort((a, b) => b[1] - a[1]);
        pairs[0][1] += 255 - pairs.reduce((a, b) => a + b[1], 0);
        pairs.forEach(([joint, x], c) => { jt[i * 4 + c] = x ? joint : 0; wt[i * 4 + c] = x; });
      }
      const sm = sp.getMaterial();
      const blend = sm.getAlphaMode() === "BLEND";
      const m = doc.createMaterial(blend ? "HairSoft" : "Hair")
        .setBaseColorTexture(await copyTexture(sm.getBaseColorTexture(), "HairColor", 90, true))
        .setNormalTexture(await copyTexture(sm.getNormalTexture(), "HairNormal", 90))
        .setAlphaMode(sm.getAlphaMode()).setAlphaCutoff(sm.getAlphaCutoff()).setDoubleSided(true)
        .setRoughnessFactor(0.6).setMetallicFactor(0)
        .setExtras({ look: { strands: +(await strandsOf(sm.getBaseColorTexture())).toFixed(4) } });
      const si = sp.getIndices().getArray();
      hairMesh.addPrimitive(doc.createPrimitive()
        .setIndices(accessor(n > 65535 ? new Uint32Array(si) : new Uint16Array(si), "SCALAR"))
        .setAttribute("POSITION", accessor(pos, "VEC3"))
        .setAttribute("NORMAL", accessor(nor, "VEC3", true))
        .setAttribute("TEXCOORD_0", accessor(uv, "VEC2", true))
        .setAttribute("JOINTS_0", accessor(jt, "VEC4"))
        .setAttribute("WEIGHTS_0", accessor(wt, "VEC4", true))
        .setMaterial(m));
      console.log(`  ${node.getName()}: ${n} vertices, ${si.length / 3} triangles, ${sm.getAlphaMode()}`);
    }
  }
  root.listScenes()[0].addChild(doc.createNode("Hair").setMesh(hairMesh).setSkin(skin));
}
await doc.transform(prune({ keepAttributes: true, keepExtras: true }));
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(output, doc);
console.log("wrote", output);
