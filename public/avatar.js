// The teacher's face: a realistic person who says each phrase with matching lips, so she can see
// how English is spoken, and who smiles and nods when she gets it right.
//
// The models are photo-based busts (public/avatars/, see LICENSE.txt there) with the ARKit face
// shapes and 14 mouth shapes (visemes). This file is their whole engine, on three.js (loaded from
// the CDN through the import map in learn.html, only once the face is first shown): portrait
// lighting with soft shadows, blinking, eyes that keep contact while the head moves a little, a
// resting smile, reactions, and the lips.
// The sound still comes from learn.js's own <audio> player (it plays on silent and at any
// speed); every frame the lips take the mouth shape for that player's position, so they stay in
// sync at 0,5× or 2×. Word timings come with the audio from `api/tts?lipsync=1`; without them (a
// published copy), words are spread over the part of the clip that is loud. Words become mouth
// shapes with TalkingHead's English lip-sync module (MIT, github.com/met4citizen/TalkingHead).
import { spreadWords } from "./learn-core.js";

const DEG = Math.PI / 180;

/** The two faces, matching the two voices. Lengths are in metres; a bust stands at the origin, looking along +z. */
const FACES = {
  female: {
    url: "avatars/woman.glb",
    frame: { y: 0.082, height: 0.345 }, // what the camera frames: the middle of the picture and its height
    rest: { mouthSmileLeft: 0.2, mouthSmileRight: 0.2, cheekSquintLeft: 0.06, cheekSquintRight: 0.06 }, // a soft resting smile
    hair: "chestnut", // her long hair is a separate piece with no colour of its own: this one unless she picks another
    underHair: 0.3, // how dark the head's own painted hair is under it
    own: { eyes: "#8d9a84", lips: "#cf9689", skin: "#f1cfb8" }, // as photographed, for the settings' swatches
  },
  male: {
    url: "avatars/man.glb",
    frame: { y: 0.085, height: 0.34 },
    rest: { mouthSmileLeft: 0.14, mouthSmileRight: 0.14 },
    own: { hair: "#a06a3a", eyes: "#5f7088", lips: "#c8837a", skin: "#f3c7aa" },
  },
};

/**
 * What can be changed about a face, for the settings page: [id, Russian name, colour, strength].
 * "own" is as photographed. Hair colour also goes to brows and beard; a lipstick has a strength;
 * a skin tone is what the photo's skin is multiplied by (red, green, blue).
 */
export const AVATAR_LOOKS = {
  hair: [
    ["own", "Свои"], ["blonde", "Блонд", "#cba669"], ["fair", "Русые", "#8a6541"], ["chestnut", "Каштановые", "#523128"],
    ["dark", "Тёмные", "#2b1a13"], ["black", "Чёрные", "#100e0f"], ["ginger", "Рыжие", "#7d3d1d"], ["pink", "Розовые", "#cf7c9c"],
  ],
  eyes: [
    ["own", "Свои"], ["blue", "Голубые", "#5d87b4"], ["grey", "Серые", "#848f99"], ["green", "Зелёные", "#6b8a5a"],
    ["hazel", "Ореховые", "#8a7040"], ["brown", "Карие", "#6e4526"], ["dark", "Тёмные", "#35221a"],
  ],
  lips: [
    ["own", "Свои"], ["nude", "Нюд", "#b97f6d", 0.6], ["pink", "Розовая", "#d4687f", 0.7], ["coral", "Коралловая", "#dd5a48", 0.75],
    ["red", "Красная", "#b01c2a", 0.85], ["berry", "Ягодная", "#7d1f41", 0.85],
  ],
  skin: [["own", "Своя"], ["fair", "Светлая", [1.09, 1.08, 1.09]], ["tan", "Загар", [0.9, 0.79, 0.69]], ["deep", "Смуглая", [0.7, 0.56, 0.45]]],
};
const faceChoices = { female: {}, male: {} }; // what was picked for each face: { hair, eyes, lips, skin } as ids

/** The choices a face offers, with the colour to show for each: [id, name, css colour]. */
export function avatarChoices(voice, kind) {
  const face = FACES[voice] ?? FACES.female;
  const css = (c) => (Array.isArray(c) ? `rgb(${c.map((x, i) => Math.round(Math.min(1, x ** (1 / 2.2) * [0.945, 0.81, 0.72][i]) * 255)).join(" ")})` : c);
  return AVATAR_LOOKS[kind]
    .filter(([id]) => id !== "own" || face.own[kind]) // a face with no colour of its own for this has no "own"
    .map(([id, name, colour]) => [id, name, id === "own" ? face.own[kind] : css(colour)]);
}

/** What a face shows when nothing was picked. */
export const avatarDefault = (voice, kind) => ((FACES[voice] ?? FACES.female).own[kind] ? "own" : FACES[voice][kind]);

/** Changes a face's colours: `choice` is { hair, eyes, lips, skin }, each an id from AVATAR_LOOKS. */
export function avatarLook(voice, choice = {}) {
  if (!faceChoices[voice]) return;
  faceChoices[voice] = { ...choice };
  if (faceModel?.who === voice) tintFace(faceModel);
}
const FACE_VISEMES = ["PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"];
const OPEN_VISEMES = { aa: 1, O: 0.8, E: 0.6, I: 0.45, U: 0.5, CH: 0.3, kk: 0.3 }; // how far each opens the mouth: the head moves a little with it
const EYE_TURN = 12 * DEG; // the furthest the eyes turn
const LIP_GAIN = 1.15; // lips a bit clearer than in normal speech, as a teacher would mouth them

// The look: a portrait studio. A warm key light in front, to one side and above, casts soft
// shadows (under the chin, beside the nose); a cool fill from the other side keeps them light; a
// warm light from behind rims the hair and shoulders. Skin has a soft glow rather than shine, the
// eyes a wet coat that catches the lights, the mouth stays darker inside.
const FACE_LOOK = {
  exposure: 0.95,
  environment: 0.5, // the room around her, seen in reflections and as soft all-round light
  key: { color: 0xffead4, intensity: 2.6, position: [0.95, 0.72, 1.5], shadow: 0.7, softness: 3 },
  fill: { color: 0xd8deff, intensity: 0.55, position: [-1.5, 0.15, 1.1] },
  rim: { color: 0xffddb0, intensity: 1.5, position: [-0.7, 0.85, -1.5] },
  skin: { roughness: 0.58, sheen: 0.3, sheenRoughness: 0.5, sheenColor: 0xffb9a0, specularIntensity: 0.45, envMapIntensity: 1 },
  eyes: { roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.7 },
  teeth: { roughness: 0.3, envMapIntensity: 0.5, color: [1.7, 1.66, 1.57], glow: 0.1 }, // the model's are painted grey, as if always in the dark
  mouth: { roughness: 0.28, color: 0xb8b0ae, envMapIntensity: 0.35 },
  hair: { roughness: 0.62, envMapIntensity: 0.35, normalScale: 0.7, specularIntensity: 0.4, solid: 0.55 }, // its colour: see AVATAR_LOOKS
};

/** True when this browser can draw the face (WebGL 2). */
export function avatarSupported() {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

// One stage for the whole app, moved into whichever screen shows the face, so the 3D scene is
// built once.
const faceStage = document.createElement("div");
faceStage.className = "avatar-stage";
const faceView = document.createElement("div");
faceView.className = "avatar-view";
const faceNote = document.createElement("div");
faceNote.className = "avatar-note";
faceNote.setAttribute("role", "status");
faceStage.append(faceView, faceNote);

let faceLibs = null; // three.js and friends, once asked for
let faceGL = null; // { renderer, scene, camera, key, fill, rim }
let faceModel = null; // the face on stage and its animation state
let faceFailedAt = 0; // when loading last failed (offline): retried at most once a minute
let faceWanted = "female"; // whose face should show
let faceLoading = null;
let faceSpeech = null; // what is being said: { media, src, cues, words, word, seen, seenAt }
let faceRaf = null;

const setFaceNote = (text) => {
  faceNote.textContent = text ?? "";
  faceNote.hidden = !text;
};
const showFace = (on) => faceStage.classList.toggle("ready", on); // the picture fades in once there is a face to show

/** The face's stage, to put in a screen; `voice` picks the woman or the man. */
export function avatarStage(voice = "female") {
  faceWanted = FACES[voice] ? voice : "female";
  if (faceModel?.who !== faceWanted) {
    showFace(false);
    setFaceNote("Загружаю лицо…");
  }
  return faceStage;
}

/** Runs the face while its stage is on screen and pauses it otherwise; call after each screen change. */
export function avatarRefresh() {
  if (!faceStage.isConnected) {
    faceSpeech = null;
    cancelAnimationFrame(faceRaf);
    faceRaf = null;
    return;
  }
  requestAnimationFrame(async () => {
    if (!faceStage.isConnected) return;
    if (!faceGL && Date.now() - faceFailedAt < 60000) return setFaceNote("Лицо не загрузилось. Проверьте интернет.");
    try {
      await createFace();
    } catch (err) {
      console.error(err);
      setFaceNote("Лицо не загрузилось. Проверьте интернет.");
      faceLibs = null;
      faceFailedAt = Date.now();
      return;
    }
    if (!faceStage.isConnected) return;
    fitFace();
    faceRaf ??= requestAnimationFrame(tickFace);
    if (faceModel?.who !== faceWanted && !faceLoading && Date.now() - faceFailedAt > 60000) loadFace();
  });
}

// ---------------------------------------------------------------- the studio
function loadFaceLibs() {
  faceLibs ??= Promise.all([
    import("three"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
    import("three/addons/environments/RoomEnvironment.js"),
    import("lipsync-en"),
  ]).then(([THREE, { GLTFLoader }, { MeshoptDecoder }, { RoomEnvironment }, { LipsyncEn }]) => (
    { THREE, GLTFLoader, MeshoptDecoder, RoomEnvironment, lipsync: new LipsyncEn() }
  ));
  return faceLibs;
}

async function createFace() {
  const { THREE, RoomEnvironment } = await loadFaceLibs();
  if (faceGL) return;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps the colours of the photo the skin comes from
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  faceView.append(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(11, 1, 0.2, 12); // a long lens, as for a portrait
  const light = () => {
    const l = new THREE.DirectionalLight();
    scene.add(l, l.target);
    return l;
  };
  const key = light();
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -0.3, right: 0.3, top: 0.34, bottom: -0.26, near: 0.5, far: 5 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.003;
  faceGL = { renderer, scene, camera, key, fill: light(), rim: light() };
  lightFace();
  new ResizeObserver(fitFace).observe(faceView);
}

function lightFace(look = FACE_LOOK) {
  const { renderer, scene, key, fill, rim } = faceGL;
  renderer.toneMappingExposure = look.exposure;
  scene.environmentIntensity = look.environment;
  for (const [l, cfg] of [[key, look.key], [fill, look.fill], [rim, look.rim]]) {
    l.color.set(cfg.color);
    l.intensity = cfg.intensity;
    l.position.set(...cfg.position).multiplyScalar(1.6);
    l.target.position.set(0, 0.08, 0.02);
  }
  key.shadow.intensity = look.key.shadow;
  key.shadow.radius = look.key.softness;
}

// The picture's size, and the camera's distance for it: the framed height stays the same; on a
// narrow stage the camera steps back so the face still fits its width.
function fitFace() {
  if (!faceGL) return;
  const { renderer, scene, camera } = faceGL;
  const w = faceView.clientWidth;
  const h = faceView.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  const { frame } = faceModel?.face ?? FACES[faceWanted];
  const height = Math.max(frame.height, (0.24 * h) / w);
  camera.aspect = w / h;
  camera.position.set(0, frame.y, height / 2 / Math.tan((camera.fov * DEG) / 2));
  camera.lookAt(0, frame.y, 0);
  camera.updateProjectionMatrix();
  if (faceModel) renderer.render(scene, camera); // resizing clears the picture
}

// A published copy (claude.ai) can't serve .glb files: there each model comes as base64 in a .json
// file in LEARN_FACE_DIR (e.g. "avatars/woman.json"), turned back into a model here.
const FACE_DIR = globalThis.LEARN_FACE_DIR ?? null;
async function faceModelUrl(who) {
  if (!FACE_DIR) return FACES[who].url;
  const name = FACES[who].url.split("/").pop().replace(/\.glb$/, "");
  const res = await fetch(`${FACE_DIR}${name}.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bin = atob((await res.json()).glb);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
}

async function loadFace() {
  const who = faceWanted;
  faceLoading = who;
  setFaceNote("Загружаю лицо…");
  try {
    const { THREE, GLTFLoader, MeshoptDecoder } = await loadFaceLibs();
    const url = await faceModelUrl(who);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url, (ev) => {
      if (ev?.lengthComputable && ev.total) setFaceNote(`Загружаю лицо… ${Math.round((ev.loaded / ev.total) * 100)}%`);
    });
    const { renderer, scene, camera } = faceGL;
    if (faceModel) {
      scene.remove(faceModel.root);
      for (const part of faceModel.all) {
        part.geometry.dispose();
        part.material.map?.dispose();
        part.material.normalMap?.dispose();
        part.material.dispose();
      }
    }
    faceModel = stageFace(THREE, gltf.scene, who);
    tintFace(faceModel);
    scene.add(faceModel.root);
    fitFace();
    await renderer.compileAsync(scene, camera); // shaders ready before the face appears
    setFaceNote(null);
    showFace(true);
  } catch (err) {
    console.error(err);
    setFaceNote("Лицо не загрузилось. Проверьте интернет.");
    faceFailedAt = Date.now();
  }
  faceLoading = null;
  if (faceStage.isConnected && faceWanted !== who && faceModel) loadFace(); // the voice changed meanwhile
}

/** The loaded bust, dressed for the studio, with what its animation needs. */
function stageFace(THREE, root, who, look = FACE_LOOK) {
  const parts = []; // the meshes with face shapes: skin, eyes, teeth, mouth
  const all = [];
  // the colours that can be changed, as the shaders read them (see tintFace)
  const tint = {
    uHair: { value: new THREE.Vector4() }, uIris: { value: new THREE.Vector4() }, uLips: { value: new THREE.Vector4() },
    uSkin: { value: new THREE.Vector3(1, 1, 1) }, uUnder: { value: 1 }, uLum: { value: new THREE.Vector4(1, 1, 1, 1) },
  };
  root.traverse((o) => {
    if (!o.isMesh) return;
    all.push(o);
    if (o.morphTargetInfluences) parts.push(o);
    o.frustumCulled = false; // its shapes move outside the box worked out from the rest pose
    o.material = dressFace(THREE, o.material, look, tint);
    const { kind } = o.material.userData;
    o.castShadow = kind === "skin" || kind === "hair";
    o.receiveShadow = kind !== "soft" && kind !== "teeth";
    if (o.material.map) o.material.map.anisotropy = Math.min(8, faceGL.renderer.capabilities.getMaxAnisotropy());
  });
  // Hair is strands painted on cards. The solid layer is drawn twice: first only where the strands
  // are dense, which also hides the hair behind it; then softly over that, for fine edges.
  for (const o of all.filter((o) => o.material.userData.kind === "hair")) {
    const soft = o.material.clone();
    soft.userData.kind = "soft";
    recolourFace(soft, tint);
    const twin = new THREE.SkinnedMesh(o.geometry, dressFace(THREE, soft, look));
    twin.bind(o.skeleton, o.bindMatrix);
    twin.frustumCulled = false;
    o.parent.add(twin);
    all.push(twin);
  }
  const bone = (name) => root.getObjectByName(name);
  const index = parts[0].morphTargetDictionary; // shape name → its number (the same in every part)
  const n = Object.keys(index).length;
  return {
    who,
    face: FACES[who],
    root,
    parts,
    all,
    tint,
    colour: new THREE.Color(),
    index,
    smooth: new Float32Array(n), // expressions ease towards what is wanted…
    want: new Float32Array(n),
    direct: new Float32Array(n), // …lips, lids and blinks are set as they are
    bones: { chest: bone("chest"), neck: bone("neck"), head: bone("head"), eyes: [bone("eyeLeft"), bone("eyeRight")] },
    chestY: bone("chest")?.position.y ?? 0,
    euler: new THREE.Euler(0, 0, 0, "YXZ"),
    // animation state; times are seconds on the frame clock
    last: 0,
    nextBlink: 0,
    blinkAt: -9,
    nextGlance: 0,
    gaze: { yaw: 0, pitch: 0 },
    eyeYaw: 0,
    eyePitch: 0,
    contactUntil: 0,
    listenUntil: 0,
    listen: 0,
    react: null, // { good, at }
    browAt: -9,
    nodAt: -9,
    mouthOpen: 0,
  };
}

/** A material in the look: skin, eyes, teeth, the inside of the mouth and hair each get their own treatment. */
function dressFace(THREE, m, look, tint = null) {
  let p = m;
  if (!m.isMeshPhysicalMaterial) { // the model's is a standard material: copied into a physical one, once
    p = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(p, m);
    // hair comes as strands on cards, in two layers: a solid one (cut out by the texture) and a soft one over it
    p.userData = { ...m.userData, kind: ["hairsoft", "hair", "eyes", "teeth", "mouth"].find((k) => m.name.toLowerCase().startsWith(k)) ?? "skin" };
    if (p.userData.kind === "hairsoft") p.userData.kind = "soft";
    m.dispose();
    recolourFace(p, tint);
  }
  const { kind } = p.userData;
  const s = look[kind === "soft" ? "hair" : kind];
  p.metalness = 0;
  p.roughness = s.roughness;
  p.envMapIntensity = s.envMapIntensity;
  if (kind === "skin") {
    p.sheen = s.sheen; p.sheenRoughness = s.sheenRoughness; p.sheenColor.set(s.sheenColor); // a warm glow at the edges, like light under the skin
    p.specularIntensity = s.specularIntensity; // less oily shine
  } else if (kind === "eyes") {
    p.clearcoat = s.clearcoat; p.clearcoatRoughness = s.clearcoatRoughness; // wet: they catch the lights
  } else if (kind === "mouth") {
    p.color.set(s.color); // little light gets inside a mouth
  } else if (kind === "teeth") {
    p.color.setRGB(...s.color);
    p.emissiveMap = p.map; p.emissive.setScalar(s.glow); // never quite dark, behind the lips
  } else {
    p.specularIntensity = s.specularIntensity;
    p.normalScale.set(s.normalScale, s.normalScale);
    p.transparent = kind === "soft";
    p.depthWrite = kind === "hair";
    p.alphaTest = kind === "hair" ? s.solid : 0.02;
  }
  p.needsUpdate = true;
  return p;
}

// The colours that can be changed are changed as the face is drawn. A model brings a second
// picture, laid out like its texture, that says what is what: red for hair (with blue: brows and
// beard, which have skin under them; on the eyeballs: the iris), green for lips, blue for skin. It
// comes in the material's occlusion slot. A new colour keeps the texture's light and dark: it is
// multiplied by how bright each point is next to the average of its kind (uLum, from the model).
const FACE_TINTS = `
uniform sampler2D uMask;
uniform vec4 uHair; // a colour, and how much of it (0: as photographed)
uniform vec4 uIris;
uniform vec4 uLips;
uniform vec3 uSkin;
uniform float uUnder;
uniform vec4 uLum; // average brightness of: painted hair, lips, irises, the strands of added hair
float faceLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;
const FACE_TINT = {
  skin: `
  {
    vec4 mk = texture2D( uMask, vMapUv );
    float lum = faceLum( diffuseColor.rgb );
    diffuseColor.rgb *= mix( vec3( 1.0 ), uSkin, mk.b * ( 1.0 - mk.r ) * ( 1.0 - 0.5 * mk.g ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, uLips.rgb * ( lum / uLum.y ), smoothstep( 0.2, 0.8, mk.g ) * uLips.a );
    // no brighter than hair gets: at its edge the map takes in a little skin, and a light colour would glow on it
    diffuseColor.rgb = mix( diffuseColor.rgb, uHair.rgb * min( lum / uLum.x, 1.7 ), mk.r * uHair.a * ( 1.0 - 0.2 * mk.b ) );
    diffuseColor.rgb *= mix( 1.0, uUnder, mk.r * ( 1.0 - mk.b ) ); // the head's own hair, in the shade of the hair over it
  }`,
  eyes: `
  {
    float iris = texture2D( uMask, vMapUv ).r;
    diffuseColor.rgb = mix( diffuseColor.rgb, uIris.rgb * ( faceLum( diffuseColor.rgb ) / uLum.z ), iris * uIris.a );
  }`,
  hair: `
  diffuseColor.rgb = mix( diffuseColor.rgb, uHair.rgb * ( faceLum( sampledDiffuseColor.rgb ) / uLum.w ), uHair.a );`,
};

/** Lets a material's colours be changed (see FACE_TINTS): skin, eyes, and the strands of added hair. */
function recolourFace(p, tint) {
  const { kind } = p.userData;
  const code = FACE_TINT[kind === "soft" ? "hair" : kind];
  const mask = p.aoMap; // not occlusion: the picture of what is what
  p.aoMap = null;
  if (!tint || !code || (kind !== "hair" && kind !== "soft" && !mask)) return;
  const lum = p.userData.look ?? {};
  if (lum.hair) tint.uLum.value.setX(lum.hair);
  if (lum.lips) tint.uLum.value.setY(lum.lips);
  if (lum.iris) tint.uLum.value.setZ(lum.iris);
  if (lum.strands) tint.uLum.value.setW(lum.strands);
  p.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, tint, { uMask: { value: mask } });
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${FACE_TINTS}void main() {`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n#ifdef USE_MAP${code}\n#endif`);
  };
  p.customProgramCacheKey = () => `face-${kind}`;
}

/** Sets the colours picked for this face (avatarLook), or its own. */
function tintFace(m) {
  const choice = faceChoices[m.who] ?? {};
  const pick = (kind) => AVATAR_LOOKS[kind].find(([id]) => id === (choice[kind] ?? m.face[kind])) ?? [];
  const set = (uniform, colour, amount = 1) => {
    if (colour) uniform.value.set(...m.colour.set(colour).toArray(), amount);
    else uniform.value.set(0, 0, 0, 0);
  };
  set(m.tint.uHair, pick("hair")[2]);
  set(m.tint.uIris, pick("eyes")[2]);
  set(m.tint.uLips, pick("lips")[2], pick("lips")[3]);
  m.tint.uSkin.value.set(...(pick("skin")[2] ?? [1, 1, 1]));
  m.tint.uUnder.value = m.face.underHair ?? 1;
}

// ---------------------------------------------------------------- lips
/**
 * Mouth shapes for words said at known times: each word's visemes spread over its time, each one
 * rising and falling (the envelope TalkingHead uses for its own speech).
 * @param {{w: string, s: number, e: number}[]} words seconds into the clip
 */
function faceCues(lipsync, words) {
  const cues = [];
  for (const { w, s, e } of words) {
    const val = lipsync.wordsToVisemes(lipsync.preProcessText(w));
    const n = val?.visemes?.length ?? 0;
    if (!n) continue;
    const total = val.times[n - 1] + val.durations[n - 1];
    if (!(total > 0)) continue;
    let duration = Math.max(60, (e - s) * 1000);
    const overdrive = Math.min(duration, Math.max(0, duration - n * 150));
    const level = 0.6 + (0.4 * overdrive) / duration;
    duration = Math.min(duration, n * 200);
    for (let j = 0; j < n; j++) {
      const t = s * 1000 + (val.times[j] / total) * duration;
      const d = (val.durations[j] / total) * duration;
      const v = val.visemes[j];
      cues.push({ v, a: t - Math.min(60, (2 * d) / 3), b: t + Math.min(25, d / 2), c: t + d + Math.min(60, d / 2), level: v === "PP" || v === "FF" ? 0.9 : level });
    }
  }
  return cues;
}

// Without timings: where the voice is in the clip (loud enough); learn-core's spreadWords then
// spreads the words over it by length.
const faceWindows = new Map(); // audio URL → Promise<[start, end] in seconds>
let faceAudio = null;
function voicedPart(url) {
  if (!faceWindows.has(url)) {
    faceWindows.set(url, (async () => {
      const bytes = url.startsWith("data:") // a published copy's recording: decoded here, no fetch needed
        ? Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)).buffer
        : await (await fetch(url)).arrayBuffer();
      faceAudio ??= new (window.AudioContext || window.webkitAudioContext)();
      const audio = await faceAudio.decodeAudioData(bytes);
      const data = audio.getChannelData(0);
      const step = Math.max(1, Math.round(audio.sampleRate / 100)); // 10 ms
      const loud = [];
      for (let i = 0; i < data.length; i += step) {
        let sum = 0;
        for (let j = i; j < Math.min(i + step, data.length); j++) sum += data[j] * data[j];
        loud.push(Math.sqrt(sum / step));
      }
      const top = Math.max(...loud);
      const first = loud.findIndex((x) => x > top * 0.12);
      const last = loud.length - 1 - [...loud].reverse().findIndex((x) => x > top * 0.12);
      return first < 0 ? [0, audio.duration] : [first / 100, (last + 1) / 100];
    })());
    faceWindows.get(url).catch(() => faceWindows.delete(url));
  }
  return faceWindows.get(url);
}

/**
 * The face says `text` along with `media` (learn.js's player, already playing `media.src`).
 * `words` are the clip's word timings when known.
 */
export async function avatarSay(text, media, words = null) {
  if (!faceStage.isConnected) return;
  const src = media.currentSrc || media.src;
  const mine = { media, src, cues: [], words: [], word: 0, seen: -1, seenAt: 0 };
  faceSpeech = mine;
  let timed = words?.length ? words : null;
  if (!timed) {
    try {
      timed = spreadWords(text, await voicedPart(src));
    } catch {
      timed = spreadWords(text, [0.05, Math.max(0.3, (media.duration || 1.5) - 0.15)]);
    }
  }
  try {
    const { lipsync } = await loadFaceLibs();
    if (faceSpeech !== mine) return;
    mine.cues = faceCues(lipsync, timed);
    mine.words = timed;
  } catch {
    // no lips this time: the face itself reports that it couldn't load
  }
}

/** Stops the lips (the sound was stopped). */
export function avatarHush() {
  faceSpeech = null;
}

// Where the player is in the clip, in milliseconds, or null when it isn't playing it. Some
// browsers only move `currentTime` a few times a second: between its steps the frame clock
// carries on, so the lips move smoothly.
function speechTime(sp, now) {
  const { media } = sp;
  if ((media.currentSrc || media.src) !== sp.src || media.ended || media.error) return (faceSpeech = null);
  if (media.paused) return media.currentTime > 0 ? (faceSpeech = null) : null; // stopped; or not started yet
  const at = media.currentTime;
  if (at !== sp.seen) {
    sp.seen = at;
    sp.seenAt = now;
  }
  return (at + Math.min(0.25, now - sp.seenAt) * (media.playbackRate || 1)) * 1000;
}

// ---------------------------------------------------------------- expressions
const faceReady = () => Boolean(faceModel && faceStage.isConnected);

/** A reaction to her answer: a smile and a nod when it's right, a kind look when it isn't. */
export function avatarReact(good) {
  if (!faceReady()) return;
  faceModel.react = { good: Boolean(good), at: faceModel.last };
  faceModel.contactUntil = faceModel.last + 3;
}

/** Looks at her, attentive, while she speaks. */
export function avatarListen(ms = 4000) {
  if (faceReady()) faceModel.listenUntil = faceModel.last + ms / 1000;
}

// ---------------------------------------------------------------- every frame
const faceWave = (t, a, b, c) => Math.sin(t * a) * 0.5 + Math.sin(t * b + 1.3) * 0.3 + Math.sin(t * c + 4.1) * 0.2; // a slow sway in −1…1 that doesn't visibly repeat
const faceEase = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function tickFace(now) {
  faceRaf = requestAnimationFrame(tickFace);
  const m = faceModel;
  if (!m || document.hidden) return;
  const t = now / 1000;
  if (t - m.last < (faceSpeech?.cues.length ? 1 / 70 : 1 / 40)) return; // 60 pictures a second while she talks, 30 otherwise
  if (!m.last) Object.assign(m, { nextBlink: t + 2, nextGlance: t + 1.2, contactUntil: t + 4 }); // her first moments: looking at the learner
  const dt = Math.min(0.1, t - m.last);
  m.last = t;
  animateFace(m, t, dt);
  faceGL.renderer.render(faceGL.scene, faceGL.camera);
}

function animateFace(m, t, dt) {
  m.want.fill(0);
  m.direct.fill(0);
  const want = (name, v) => { const i = m.index[name]; if (i !== undefined) m.want[i] += v; };
  const direct = (name, v) => { const i = m.index[name]; if (i !== undefined) m.direct[i] += v; };
  for (const name in m.face.rest) want(name, m.face.rest[name]);

  // --- lips: the mouth shape for where the player is now
  let open = 0;
  const sp = faceSpeech;
  const ms = sp?.cues.length ? speechTime(sp, t) : null;
  const speaking = ms !== null;
  if (speaking) {
    for (const v of FACE_VISEMES) {
      let x = 0;
      for (const c of sp.cues) {
        if (c.v !== v || ms <= c.a || ms >= c.c) continue;
        x = Math.max(x, ms < c.b ? (c.level * (ms - c.a)) / (c.b - c.a) : (c.level * (c.c - ms)) / (c.c - c.b));
      }
      if (!x) continue;
      x = Math.min(1, x * LIP_GAIN);
      direct(`viseme_${v}`, x);
      open += x * (OPEN_VISEMES[v] ?? 0.1);
    }
    // a new word: now and then the brows lift or the head dips with it, as when stressing a word
    while (sp.word < sp.words.length && sp.words[sp.word].s * 1000 <= ms) {
      const first = sp.word === 0;
      if (first || Math.random() < 0.2) m.browAt = t;
      if (first || Math.random() < 0.3) m.nodAt = t;
      sp.word++;
    }
    m.contactUntil = t + 1.5;
  }
  m.mouthOpen += (Math.min(1, open) - m.mouthOpen) * (1 - Math.exp(-dt * 10));

  // --- attention
  const listening = t < m.listenUntil;
  m.listen += ((listening ? 1 : 0) - m.listen) * (1 - Math.exp(-dt * 4));
  const attending = speaking || listening || t < m.contactUntil;
  if (m.listen > 0.01) want("browInnerUp", 0.16 * m.listen);
  const brow = t - m.browAt; // a quick lift, a slower fall
  if (brow < 0.6) {
    const e = brow < 0.12 ? brow / 0.12 : 1 - (brow - 0.12) / 0.48;
    direct("browInnerUp", 0.3 * e); direct("browOuterUpLeft", 0.22 * e); direct("browOuterUpRight", 0.22 * e);
  }

  // --- reaction to her answer
  let nod = 0;
  let tilt = 0;
  if (m.react) {
    const u = t - m.react.at;
    const e = faceEase(u / 0.3) * (1 - faceEase((u - 1.7) / 0.9)); // in, held, out
    if (u > 2.7) m.react = null;
    else if (m.react.good) {
      want("mouthSmileLeft", 0.45 * e); want("mouthSmileRight", 0.45 * e);
      want("laughter", 0.4 * e); // a smile that shows the teeth
      want("cheekSquintLeft", 0.4 * e); want("cheekSquintRight", 0.4 * e);
      want("eyeSquintLeft", 0.3 * e); want("eyeSquintRight", 0.3 * e);
      want("browInnerUp", 0.1 * e);
      if (u < 1.4) nod = 5.5 * DEG * Math.sin(u * Math.PI * 2 * 1.5) * Math.exp(-u * 1.5); // yes, yes
    } else {
      want("mouthSmileLeft", 0.22 * e); want("mouthSmileRight", 0.22 * e);
      want("browInnerUp", 0.32 * e);
      tilt = 3 * DEG * e;
    }
  }

  // --- head: a slow sway, livelier while speaking, stiller while listening
  const lively = speaking ? 1.6 : 1 - 0.5 * m.listen;
  const nodded = t - m.nodAt;
  const yaw = 2.1 * DEG * lively * faceWave(t, 0.31, 0.83, 1.37);
  const pitch = 1.2 * DEG * lively * faceWave(t + 40, 0.27, 0.71, 1.53) + nod + (speaking ? 1.6 * DEG * (m.mouthOpen - 0.2) : 0)
    + (nodded < 0.5 ? 1.4 * DEG * Math.sin((nodded / 0.5) * Math.PI) : 0) + 1.2 * DEG * m.listen;
  const roll = 1.0 * DEG * lively * faceWave(t + 80, 0.23, 0.57, 1.11) + tilt + 2.4 * DEG * m.listen;
  const { chest, neck, head, eyes } = m.bones;
  neck?.quaternion.setFromEuler(m.euler.set(pitch * 0.35, yaw * 0.35, roll * 0.35));
  head?.quaternion.setFromEuler(m.euler.set(pitch * 0.65, yaw * 0.65, roll * 0.65));
  if (chest) chest.position.y = m.chestY + 0.0012 * Math.sin(t * Math.PI * 2 * 0.23); // breathing

  // --- eyes: on her, with small jumps around her face; now and then a glance away
  if (t >= m.nextGlance) {
    const away = !attending && Math.random() < 0.2;
    m.gaze = away
      ? { yaw: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 4) * DEG, pitch: (Math.random() * 5 - 2) * DEG }
      : { yaw: (Math.random() * 2 - 1) * 1.5 * DEG, pitch: (Math.random() * 2 - 1) * 0.9 * DEG };
    m.nextGlance = t + (away ? 0.5 + Math.random() * 0.7 : 0.9 + Math.random() * 2.4);
    if (away || Math.random() < 0.25) m.nextBlink = Math.min(m.nextBlink, t + 0.03); // eyes often blink as they move
  }
  const quick = 1 - Math.exp(-dt * 40);
  m.eyeYaw += (m.gaze.yaw - m.eyeYaw) * quick;
  m.eyePitch += (m.gaze.pitch - m.eyePitch) * quick;
  // the eyes hold what they look at while the head moves; they don't turn far (the lashes' shade is painted on the eyeballs)
  const ey = Math.max(-EYE_TURN, Math.min(EYE_TURN, m.eyeYaw - yaw));
  const ep = Math.max(-EYE_TURN * 0.7, Math.min(EYE_TURN * 0.7, m.eyePitch - pitch));
  for (const eye of eyes) eye?.quaternion.setFromEuler(m.euler.set(ep, ey, 0));
  // the lids follow the eyes
  direct("eyeLookDownLeft", Math.max(0, ep) / (28 * DEG)); direct("eyeLookDownRight", Math.max(0, ep) / (28 * DEG));
  direct("eyeLookUpLeft", Math.max(0, -ep) / (20 * DEG)); direct("eyeLookUpRight", Math.max(0, -ep) / (20 * DEG));
  direct("eyeLookOutLeft", Math.max(0, ey) / (25 * DEG)); direct("eyeLookInLeft", Math.max(0, -ey) / (25 * DEG));
  direct("eyeLookInRight", Math.max(0, ey) / (25 * DEG)); direct("eyeLookOutRight", Math.max(0, -ey) / (25 * DEG));

  // --- blinking
  if (t >= m.nextBlink) {
    m.blinkAt = t;
    m.nextBlink = t + (Math.random() < 0.15 ? 0.34 : 2.4 + Math.random() * 3.4); // sometimes twice
  }
  const b = t - m.blinkAt;
  const blink = b < 0.07 ? b / 0.07 : b < 0.1 ? 1 : b < 0.26 ? 1 - (b - 0.1) / 0.16 : 0;
  if (blink) { direct("eyeBlinkLeft", blink); direct("eyeBlinkRight", blink); }

  // --- onto the face
  const ease = 1 - Math.exp(-dt * 12);
  const n = m.smooth.length;
  for (let i = 0; i < n; i++) m.smooth[i] += (m.want[i] - m.smooth[i]) * ease;
  for (const part of m.parts) {
    const out = part.morphTargetInfluences;
    for (let i = 0; i < n; i++) {
      const v = m.smooth[i] + m.direct[i];
      out[i] = v < 0.002 ? 0 : v > 1 ? 1 : v;
    }
  }
}
