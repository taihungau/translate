// The teacher's face: a realistic 3D person who says each phrase with matching lips, so she can
// see how English is spoken, and who smiles and nods when she gets it right.
//
// Drawn with TalkingHead (MIT, https://github.com/met4citizen/TalkingHead) on three.js, both
// loaded from the CDN through the import map in learn.html, only once the face is first shown.
// The sound still comes from learn.js's own <audio> player (it plays on silent and at any
// speed); the lips follow that player's position every frame, so they stay in sync at 0,5× or 2×.
// Word timings come with the audio from `api/tts?lipsync=1`; without them (a published copy),
// words are spread over the part of the clip that is loud.
import { spreadWords } from "./learn-core.js";

/** The two faces, matching the two voices. Settings from TalkingHead's own site config. */
const FACES = {
  female: {
    url: "avatars/woman.glb", body: "F", avatarMood: "neutral",
    camera: { cameraDistance: -0.42, cameraY: -0.06 }, // a video-call close-up: forehead to chin
    retarget: {
      Hips: { y: 0.03 }, Spine: { y: 0.02 }, Spine1: { y: 0.02, z: 0.01 }, Spine2: { y: 0.02, z: 0.01 },
      Neck: { z: 0.02, y: 0.01 }, Head: { z: 0.02 }, LeftShoulder: { rx: -0.5 }, RightShoulder: { rx: -0.5 }, scaleToHipsLevel: 1.0,
    },
    baseline: { headRotateX: -0.05, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.15 },
  },
  male: {
    url: "avatars/man.glb", body: "M", avatarMood: "neutral",
    camera: { cameraDistance: -0.48, cameraY: -0.16 },
    retarget: {
      Neck: { z: -0.01, rx: -0.15 }, Neck1: { z: -0.01, rx: -0.15 }, Neck2: { z: -0.01, rx: -0.15 },
      LeftShoulder: { rz: -0.3 }, RightShoulder: { rz: 0.3 }, scaleToEyesLevel: 1.0, origin: { y: -0.1 },
    },
    baseline: { headRotateX: -0.04, eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 },
  },
};
const FACE_VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"];
// Lips a bit clearer than in normal speech, as a teacher would mouth them, with the jaw opening
// on open sounds.
const LIP_GAIN = 1.6;
const FACE_JAW = { aa: 0.32, O: 0.24, E: 0.16, I: 0.1, U: 0.12, CH: 0.08, kk: 0.1, RR: 0.06, DD: 0.06, TH: 0.08, nn: 0.04, SS: 0.03 };

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

let faceHead = null; // the TalkingHead instance
let faceCreating = null;
let faceFailedAt = 0; // when loading last failed (offline): retried at most once a minute
let faceWanted = "female"; // whose face should show
let faceShown = null; // whose face is loaded
let faceLoading = null;
let faceSpeech = null; // what is being said: { media, src, cues }

const setFaceNote = (text) => {
  faceNote.textContent = text ?? "";
  faceNote.hidden = !text;
};

/** The face's stage, to put in a screen; `voice` picks the woman or the man. */
export function avatarStage(voice = "female") {
  faceWanted = FACES[voice] ? voice : "female";
  if (!faceShown) setFaceNote("Загружаю лицо…");
  return faceStage;
}

/** Runs the face while its stage is on screen and pauses it otherwise; call after each screen change. */
export function avatarRefresh() {
  if (!faceStage.isConnected) {
    hushFace();
    faceHead?.stop();
    return;
  }
  requestAnimationFrame(async () => {
    if (!faceStage.isConnected) return;
    if (!faceHead && Date.now() - faceFailedAt < 60000) return setFaceNote("Лицо не загрузилось. Проверьте интернет.");
    try {
      await createFace();
    } catch (err) {
      console.error(err);
      setFaceNote("Лицо не загрузилось. Проверьте интернет.");
      faceCreating = null;
      faceFailedAt = Date.now();
      return;
    }
    faceHead.start();
    if (faceShown !== faceWanted && !faceLoading && Date.now() - faceFailedAt > 60000) loadFace();
  });
}

function createFace() {
  faceCreating ??= (async () => {
    const { TalkingHead } = await import("talkinghead");
    faceHead = new TalkingHead(faceView, {
      lipsyncModules: ["en"], lipsyncLang: "en",
      cameraView: "head", cameraRotateEnable: false, cameraPanEnable: false, cameraZoomEnable: false,
      modelFPS: 30, modelPixelRatio: Math.min(2, window.devicePixelRatio || 1), modelMovementFactor: 0.4,
      avatarIdleEyeContact: 0.7, avatarIdleHeadMove: 0.2, avatarSpeakingEyeContact: 0.9, avatarSpeakingHeadMove: 0.2,
      update: driveFace,
    });
    if (faceHead.controls) faceHead.controls.minDistance = 0.5; // close enough to read the lips
  })();
  return faceCreating;
}

async function loadFace() {
  const who = faceWanted;
  faceLoading = who;
  setFaceNote("Загружаю лицо…");
  try {
    const { camera, ...face } = FACES[who];
    Object.assign(faceHead.opt, camera);
    await faceHead.showAvatar({ ...face, lipsyncLang: "en" }, (ev) => {
      if (ev?.lengthComputable && ev.total) setFaceNote(`Загружаю лицо… ${Math.round((ev.loaded / ev.total) * 100)}%`);
    });
    faceShown = who;
    faceHead.setView("head", camera);
    setFaceNote(null);
  } catch (err) {
    console.error(err);
    setFaceNote("Лицо не загрузилось. Проверьте интернет.");
    faceFailedAt = Date.now();
  }
  faceLoading = null;
  if (faceStage.isConnected && faceWanted !== faceShown && faceShown) loadFace(); // the voice changed meanwhile
}

const faceReady = () => Boolean(faceHead && faceShown && faceStage.isConnected);

// ---------------------------------------------------------------- lips
/**
 * Mouth shapes for words said at known times: each word's visemes spread over its time, each one
 * rising and falling (the same envelope TalkingHead uses for its own speech).
 * @param {{w: string, s: number, e: number}[]} words seconds into the clip
 */
function faceCues(words) {
  if (!faceHead?.lipsync?.en) return null; // the English lip-sync module is still loading
  const cues = [];
  for (const { w, s, e } of words) {
    const val = faceHead.lipsyncWordsToVisemes(faceHead.lipsyncPreProcessText(w, "en"), "en");
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

// Without timings: where the voice is in the clip (loud enough), and words spread over it by length,
// with a short pause at a comma.
const faceWindows = new Map(); // audio URL → Promise<[start, end] in seconds>
function voicedPart(url) {
  if (!faceWindows.has(url)) {
    faceWindows.set(url, (async () => {
      const bytes = url.startsWith("data:") // a published copy's recording: decoded here, no fetch needed
        ? Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)).buffer
        : await (await fetch(url)).arrayBuffer();
      const audio = await faceHead.audioCtx.decodeAudioData(bytes);
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
  if (!faceReady()) return;
  const src = media.currentSrc || media.src;
  faceSpeech = { media, src, cues: [] };
  const mine = faceSpeech;
  const seconds = Number.isFinite(media.duration) ? media.duration / (media.playbackRate || 1) : 2;
  faceHead.lookAtCamera(Math.max(2500, seconds * 1000 + 600)); // eye contact for the whole phrase
  let timed = words?.length ? words : null;
  if (!timed) {
    try {
      timed = spreadWords(text, await voicedPart(src));
    } catch {
      timed = spreadWords(text, [0.05, Math.max(0.3, (media.duration || 1.5) - 0.15)]);
    }
  }
  for (let tries = 0; tries < 40 && !faceHead.lipsync?.en; tries++) await new Promise((r) => setTimeout(r, 50));
  if (faceSpeech === mine) faceSpeech.cues = faceCues(timed) ?? [];
}

/** Stops the lips (the sound was stopped). */
export function avatarHush() {
  hushFace();
}

function hushFace() {
  if (!faceSpeech) return;
  faceSpeech = null;
  if (!faceHead?.mtAvatar) return;
  for (const name of [...FACE_VISEMES.map((v) => `viseme_${v}`), "jawOpen"]) {
    const o = faceHead.mtAvatar[name];
    if (o) Object.assign(o, { realtime: null, needsUpdate: true });
  }
}

// Every frame, before the face is drawn: the mouth shape for where the player is now.
function driveFace() {
  if (!faceSpeech) return;
  const { media } = faceSpeech;
  if ((media.currentSrc || media.src) !== faceSpeech.src || media.ended || media.error || (media.paused && media.currentTime > 0)) {
    hushFace();
    return;
  }
  const t = media.currentTime * 1000;
  const values = Object.fromEntries(FACE_VISEMES.map((v) => [v, 0]));
  for (const c of faceSpeech.cues) {
    if (t <= c.a || t >= c.c) continue;
    const x = t < c.b ? (c.level * (t - c.a)) / (c.b - c.a) : (c.level * (c.c - t)) / (c.c - c.b);
    if (x > values[c.v]) values[c.v] = x;
  }
  let jaw = 0;
  for (const v of FACE_VISEMES) {
    const x = Math.min(1, values[v] * LIP_GAIN);
    jaw += x * (FACE_JAW[v] ?? 0);
    const o = faceHead.mtAvatar[`viseme_${v}`];
    if (o) Object.assign(o, { realtime: x, needsUpdate: true });
  }
  const o = faceHead.mtAvatar.jawOpen;
  if (o) Object.assign(o, { realtime: Math.min(0.4, jaw), needsUpdate: true });
}

// ---------------------------------------------------------------- expressions
/** A reaction to her answer: a smile and a nod when it's right, a kind look when it isn't. */
export function avatarReact(good) {
  if (!faceReady()) return;
  if (good) {
    faceHead.playGesture("😊", 2.5);
    faceHead.playGesture("yes", 2);
  } else {
    faceHead.playGesture("🙂", 2);
  }
}

/** Looks at her while she speaks. */
export function avatarListen(ms = 4000) {
  if (faceReady()) faceHead.lookAtCamera(ms);
}
