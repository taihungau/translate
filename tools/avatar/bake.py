"""Rebuilds a bust's texture: sharper, smaller, and with a map of what is hair, lips and skin.

The sample's texture is 4096x2048 but mostly empty, and the face in it is a small soft photo.
This makes a compact new texture (about 3072x2064) in which

- the photo is four times larger, its face restored by two face-restoration networks
  (GFPGAN 1.4, then GPEN-BFR-2048) and laid back over the enlarged original;
- with `beauty`, retouched and made up (beauty.py), where 68 landmarks (2DFAN4) put it;
- the middle of the face (around the eyes, the nose, the lips) is painted again from that
  restored photo, wherever the camera could see it, at twice its old size;
- the eyeballs are painted again too, and white where the photo shows eyelid instead of eye, so
  the eyes can turn;
- the other islands (teeth, inside of the mouth) are moved over, smaller.

and a second picture of the same layout, at half size: red = hair (also brows and beard; on the
eyeballs: the iris), green = lips, blue = skin. The course's engine recolours with it.

Usage: FACE_MODELS=<folder> python bake.py <raw.glb> <out-dir> [beard] [beauty]
Writes atlas.png, mask.png, uv.f32 (the new texture coordinates of every vertex) and meta.json,
for prep-bust.mjs; and some pictures to check the work by (face.png, restored.png, photo-new.png,
middle-check.png, atlas-plain.png, beauty-check.png).
"""
import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

from bust import Bust

MODELS = os.environ.get("FACE_MODELS", "models")  # the folder with the .onnx files (see README.md)
FFHQ = np.array([[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]])
WIDTH = 3072
PAD = 8  # pixels of margin around every island in the new texture
# how much larger each kind of island gets: the photo and the middle of the face end up with about
# 3900 pixels per metre of skin (the middle had half the photo's detail)
SCALE = {"photo": 4.0, "middle": 2.0, "eye": 0.5, "tooth": 0.5, "mouth": 0.35}
ort.set_default_logger_severity(3)

path, out = sys.argv[1:3]
BEARD = "beard" in sys.argv[3:]
BEAUTY = "beauty" in sys.argv[3:]
os.makedirs(out, exist_ok=True)
b = Bust(path)
# Coordinates below are pixel indices: a pixel's centre is at a whole number.
vpx = b.px - 0.5  # every vertex, in the old texture


def smoothstep(a, c, x):
    t = np.clip((x - a) / (c - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ the new layout
class Item:
    """An island's rectangle in the old texture and in the new one."""

    def __init__(self, island, scale):
        self.island = island
        lo = np.floor(vpx[island["verts"]].min(0)).astype(int)
        hi = np.ceil(vpx[island["verts"]].max(0)).astype(int) + 1
        margin = int(np.ceil(PAD / scale))
        self.src = np.array([lo[0] - margin, lo[1] - margin, hi[0] + margin, hi[1] + margin])  # x0 y0 x1 y1, edges
        self.src[:2] = np.maximum(self.src[:2], 0)
        self.src[2:] = np.minimum(self.src[2:], [b.tw, b.th])
        self.size = np.maximum(4, np.round((self.src[2:] - self.src[:2]) * scale)).astype(int)
        self.k = self.size / (self.src[2:] - self.src[:2])  # the exact scale, per axis
        self.at = None  # top left corner in the new texture

    def to_new(self, xy):
        """Old texture pixel → new texture pixel (edges of the two rectangles line up)."""
        return (np.asarray(xy) + 0.5 - self.src[:2]) * self.k + self.at - 0.5

    def to_old(self, xy):
        return (np.asarray(xy) + 0.5 - self.at) / self.k + self.src[:2] - 0.5

    def grid_old(self):
        """For every pixel of this item, its place in the old texture: two float32 maps for cv2.remap."""
        xs = (np.arange(self.size[0]) + 0.5) / self.k[0] + self.src[0] - 0.5
        ys = (np.arange(self.size[1]) + 0.5) / self.k[1] + self.src[1] - 0.5
        return np.meshgrid(xs.astype(np.float32), ys.astype(np.float32))


items = [Item(i, SCALE[i["kind"]]) for i in b.islands if i["kind"] in SCALE]
photo = next(i for i in items if i.island["kind"] == "photo")
middle = next(i for i in items if i.island["kind"] == "middle")
photo.at = np.array([0, 0])
# the rest in a column to the photo's right, on shelves, tallest first
x_left, x, y, shelf = photo.size[0], photo.size[0], 0, 0
for it in sorted((i for i in items if i is not photo), key=lambda i: -i.size[1]):
    if x + it.size[0] > WIDTH:
        x, y, shelf = x_left, y + shelf, 0
    assert x + it.size[0] <= WIDTH, f"{it.island['kind']} is wider than the column"
    it.at = np.array([x, y])
    x += it.size[0]
    shelf = max(shelf, it.size[1])
base_at = np.array([x_left + 4, y + shelf + 4])  # the underside of the bust: one colour
HEIGHT = int(np.ceil(max(photo.size[1], y + shelf + 16) / 16) * 16)
print(f"new texture {WIDTH}x{HEIGHT}; photo {photo.size}, middle {middle.size} at {middle.at}")

uv = np.zeros((len(b.pos), 2), np.float32)
for it in items:
    v = it.island["verts"]
    uv[v] = (it.to_new(vpx[v]) + 0.5) / [WIDTH, HEIGHT]
base = b.of("base")
for isl in base:
    uv[isl["verts"]] = (base_at + 4 + 0.5) / [WIDTH, HEIGHT]


def moved(it, image=None, interpolation=None):
    """An item's pixels, taken from the old texture (or another picture laid out like it)."""
    mx, my = it.grid_old()
    up = it.k.mean() > 1
    return cv2.remap(b.texture if image is None else image, mx, my, interpolation or (cv2.INTER_LANCZOS4 if up else cv2.INTER_AREA), borderMode=cv2.BORDER_REPLICATE)


def resized(it):
    x0, y0, x1, y1 = it.src
    crop = b.texture[y0:y1, x0:x1]
    return cv2.resize(crop, tuple(int(s) for s in it.size), interpolation=cv2.INTER_LANCZOS4 if it.k.mean() > 1 else cv2.INTER_AREA)


atlas = np.zeros((HEIGHT, WIDTH, 3), np.uint8)
for it in items:
    atlas[it.at[1]:it.at[1] + it.size[1], it.at[0]:it.at[0] + it.size[0]] = resized(it)
if base:
    c = b.texture[int(round(vpx[base[0]["verts"][0], 1])), int(round(vpx[base[0]["verts"][0], 0]))]
    atlas[base_at[1]:base_at[1] + 9, base_at[0]:base_at[0] + 9] = c
cv2.imwrite(f"{out}/atlas-plain.png", atlas)


# ------------------------------------------------------------------ from the head to the photo
# A place on the front of the face → its pixel in the photo (old texture). Known on the rim of
# the hole that the photo's mesh has in the middle of the face; inside, a thin-plate spline
# carries it on smoothly.
def rim_of(island):
    loops = b.openings(island)
    return min((l for l in loops if len(l) > 200), key=len)


rim = rim_of(photo.island)
ctrl = b.pos[rim][:, :2]
target = vpx[rim]


def tps_kernel(r):
    return np.where(r > 0, r * r * np.log(np.maximum(r, 1e-12)), 0)


n = len(rim)
Kmat = tps_kernel(np.linalg.norm(ctrl[:, None] - ctrl[None], axis=2)) + 1e-9 * np.eye(n)
Pmat = np.c_[np.ones(n), ctrl]
system = np.block([[Kmat, Pmat], [Pmat.T, np.zeros((3, 3))]])
coef = np.linalg.solve(system, np.r_[target, np.zeros((3, 2))])


def to_photo(p):
    """Places on the face (n×3) → pixels of the old texture, in the photo (n×2)."""
    xy = np.asarray(p)[:, :2]
    outp = np.empty((len(xy), 2))
    for s in range(0, len(xy), 20000):  # in pieces: the kernel matrix is big
        part = xy[s:s + 20000]
        U = tps_kernel(np.linalg.norm(part[:, None] - ctrl[None], axis=2))
        outp[s:s + 20000] = U @ coef[:n] + np.c_[np.ones(len(part)), part] @ coef[n:]
    return outp


# ------------------------------------------------------------------ the face, restored
mid_v = middle.island["verts"]
eye_loops = sorted((l for l in b.openings(middle.island) if len(l) < 100), key=lambda l: b.pos[l, 0].mean())  # the person's right eye first: the picture's left
corner = lambda name: b.pos[mid_v[np.argmax(np.linalg.norm(b.target(name)[mid_v], axis=1))]]  # noqa: E731
smile = sorted([corner("mouthSmileLeft"), corner("mouthSmileRight")], key=lambda c: c[0])
tip = b.pos[mid_v[np.argmax(b.pos[mid_v, 2])]]
marks = to_photo(np.array([b.pos[eye_loops[0]].mean(0), b.pos[eye_loops[1]].mean(0), tip, smile[0], smile[1]]))
T, _ = cv2.estimateAffinePartial2D(marks.astype(np.float32), FFHQ.astype(np.float32), method=cv2.LMEDS)  # old texture → the 512 px face the networks expect
Tinv = cv2.invertAffineTransform(T)
face = cv2.warpAffine(b.texture, T, (512, 512), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


def network(name, bgr, norm="half"):
    s = ort.InferenceSession(f"{MODELS}/{name}.onnx", providers=["CPUExecutionProvider"])
    inp = s.get_inputs()[0]
    size = inp.shape[2]
    rgb = cv2.resize(bgr, (size, size), interpolation=cv2.INTER_CUBIC)[:, :, ::-1].astype(np.float32) / 255
    x = (rgb - 0.5) / 0.5 if norm == "half" else (rgb - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    return s.run(None, {inp.name: x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]


def restore(name, bgr):
    y = network(name, bgr)
    return ((np.clip(y.transpose(1, 2, 0), -1, 1) * 0.5 + 0.5) * 255)[:, :, ::-1].astype(np.uint8)


def softmax(y):
    e = np.exp(y - y.max(0))
    return e / e.sum(0)


restored = restore("gpen_bfr_2048", restore("gfpgan_1.4", face))  # 2048 px: four pixels for each of the face's
K = restored.shape[0] / 512
parse_face = softmax(network("bisenet_resnet_34", face, "imagenet"))  # 19 classes × 512 × 512
cv2.imwrite(f"{out}/face.png", face)
cv2.imwrite(f"{out}/restored.png", restored)

# ---- laid back over the enlarged photo
mx, my = photo.grid_old()  # for every pixel of the new photo, its place in the old texture
cx = T[0, 0] * mx + T[0, 1] * my + T[0, 2]  # … and in the 512 px face
cy = T[1, 0] * mx + T[1, 1] * my + T[1, 2]
plain = resized(photo).astype(np.float32)
ratio = K * np.hypot(T[0, 0], T[0, 1]) / SCALE["photo"]  # restored pixels for each of the new photo's
soft = cv2.GaussianBlur(restored, (0, 0), 0.5 * np.sqrt(ratio ** 2 - 1)) if ratio > 1.1 else restored  # no aliasing when it is made smaller
laid = cv2.remap(soft, (K * cx + (K - 1) / 2).astype(np.float32), (K * cy + (K - 1) / 2).astype(np.float32), cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT).astype(np.float32)
edge = np.minimum(np.minimum(cx, 511 - cx), np.minimum(cy, 511 - cy))  # how far inside the face picture
inside = smoothstep(6, 70, edge)[..., None]
# the networks shift the overall tone a little: bring it back to the photo's, keeping their detail
SIGMA = 8 * SCALE["photo"]
laid += cv2.GaussianBlur(plain - laid, (0, 0), SIGMA)
photo_new = np.clip(plain * (1 - inside) + laid * inside, 0, 255).astype(np.float32)


def landmarks(bgr):
    """The 68 points of a face picture (2DFAN4), in its pixels."""
    s = ort.InferenceSession(f"{MODELS}/2dfan4.onnx", providers=["CPUExecutionProvider"])
    x = cv2.resize(bgr, (256, 256), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
    return s.run(None, {s.get_inputs()[0].name: np.ascontiguousarray(x.transpose(2, 0, 1))[None]})[0][0][:, :2] / 64 * bgr.shape[0]


if BEAUTY:
    from beauty import LOOK, beautify
    lm = (landmarks(restored) + 0.5) / K - 0.5  # in the 512 px face
    lm_new = photo.to_new(lm @ Tinv[:, :2].T + Tinv[:, 2]) - photo.at

    def layer(classes):
        """The face's reading, laid over the new photo like the restored face."""
        got = cv2.remap(parse_face[classes].sum(0).astype(np.float32), cx.astype(np.float32), cy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        return got * inside[..., 0]

    before = photo_new
    # the upper liner is drawn on the lids themselves (below), so that it closes with them
    photo_new = beautify(photo_new, lm_new, {"skin": layer([1, 10]), "brows": layer([2, 3]), "lips": layer([12, 13]), "eyes": layer([4, 5])}, {**LOOK, "liner": 0})
    lo = np.maximum(lm_new.min(0) - 60, 0).astype(int)
    hi = lm_new.max(0).astype(int) + 60
    cv2.imwrite(f"{out}/beauty-check.png", np.hstack([before[lo[1]:hi[1], lo[0]:hi[0]], photo_new[lo[1]:hi[1], lo[0]:hi[0]]]).astype(np.uint8))
cv2.imwrite(f"{out}/photo-new.png", photo_new.astype(np.uint8))
atlas[:photo.size[1], :photo.size[0]] = photo_new.astype(np.uint8)


def sample(image, xy, interpolation=cv2.INTER_CUBIC):
    """A picture's values at a list of places (n×2, in its pixels) → n×channels."""
    n_ = len(xy)
    cols = 4096  # cv2.remap takes maps of limited size: the list is folded into rows
    rows = -(-n_ // cols)
    grid = np.zeros((rows * cols, 2), np.float32)
    grid[:n_] = xy
    got = cv2.remap(image, grid[:, 0].reshape(rows, cols), grid[:, 1].reshape(rows, cols), interpolation, borderMode=cv2.BORDER_REPLICATE)
    return got.reshape(rows * cols, -1)[:n_]


def from_photo(q, image, interpolation=cv2.INTER_CUBIC):
    """Samples a picture laid out like the new photo, at pixels of the old texture (n×2)."""
    return sample(image, photo.to_new(q) - photo.at, interpolation)


# ------------------------------------------------------------------ what the camera saw
def raster(it, tris, corners=None):
    """Which triangle covers each pixel of a rectangle (−1: none). `corners`: the triangles' corners in the rectangle's own pixels."""
    w, h = it if isinstance(it, tuple) else it.size
    ids = np.full((h, w), -1, np.int32)
    pts = np.round(corners * 16).astype(np.int32)
    for k in range(len(tris)):
        cv2.fillConvexPoly(ids, pts[k], int(k), lineType=cv2.LINE_8, shift=4)
    return ids


def weights(ids, corners):
    """For every covered pixel: its triangle, and its place in it as three weights."""
    ys, xs = np.nonzero(ids >= 0)
    t = ids[ys, xs]
    a, bb, c = corners[t, 0], corners[t, 1], corners[t, 2]
    p = np.c_[xs, ys].astype(np.float64)
    den = (bb[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (bb[:, 1] - a[:, 1])
    den = np.where(np.abs(den) < 1e-12, 1e-12, den)
    wb = ((p[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (p[:, 1] - a[:, 1])) / den
    wc = ((bb[:, 0] - a[:, 0]) * (p[:, 1] - a[:, 1]) - (p[:, 0] - a[:, 0]) * (bb[:, 1] - a[:, 1])) / den
    w = np.clip(np.c_[1 - wb - wc, wb, wc], 0, 1)
    return ys, xs, t, w / w.sum(1, keepdims=True)


# the depth of the skin as the camera saw it, over the old photo's pixels (the nearest surface wins)
skin_tris = np.concatenate([photo.island["tris"], middle.island["tris"]])
tri_v = b.idx[skin_tris]
flat = np.where((b.kind_of_vertex[tri_v] == "photo")[..., None], vpx[tri_v], to_photo(b.pos[tri_v.reshape(-1)]).reshape(-1, 3, 2))
x0, y0, x1, y1 = photo.src
order = np.argsort(b.pos[tri_v, 2].mean(1))  # far ones first, near ones painted over them
depth_ids = raster((int(x1 - x0), int(y1 - y0)), order, flat[order] - [x0, y0])
ys, xs, t, w = weights(depth_ids, flat[order] - [x0, y0])
depth = np.full(depth_ids.shape, -np.inf)
depth[ys, xs] = (b.pos[tri_v[order][t], 2] * w).sum(1)
covered = depth_ids >= 0


def seen(p, q, slack=0.0015):
    """Is a place on the head (p, with its photo pixel q) what the camera saw there, not hidden behind skin?"""
    qi = np.round(q - [x0, y0]).astype(int)
    ok = (qi[:, 0] >= 0) & (qi[:, 1] >= 0) & (qi[:, 0] < depth.shape[1]) & (qi[:, 1] < depth.shape[0])
    d = np.full(len(p), np.inf)
    d[ok] = depth[qi[ok, 1], qi[ok, 0]]
    return p[:, 2] >= d - slack, ok & np.isfinite(d)


def places(it, more=None):
    """For every painted pixel of an item: where on the head it is, its normal, and its photo pixel
    (and, with `more`, any other per-vertex number, carried over the same way)."""
    tris = it.island["tris"]
    corners = it.to_new(vpx[b.idx[tris]].reshape(-1, 2)).reshape(-1, 3, 2) - it.at
    ids = raster(it, tris, corners)
    ys, xs, t, w = weights(ids, corners)
    p = (b.pos[b.idx[tris][t]] * w[..., None]).sum(1)
    nrm = (b.normal[b.idx[tris][t]] * w[..., None]).sum(1)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    if more is None:
        return ys, xs, p, nrm, to_photo(p)
    return ys, xs, p, nrm, to_photo(p), (more[b.idx[tris][t]] * w).sum(1)


def spread(image, ys, xs):
    """Fills the pixels that nothing painted with the nearest painted one (an island's margin)."""
    cover = np.zeros(image.shape[:2], np.uint8)
    cover[ys, xs] = 255
    _, labels = cv2.distanceTransformWithLabels(255 - cover, cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
    near = np.zeros(labels.max() + 1, np.int64)
    near[labels[cover > 0]] = np.flatnonzero(cover.reshape(-1) > 0)
    flat = image.reshape(cover.size, -1)
    return flat[near[labels]].reshape(image.shape)


# ------------------------------------------------------------------ the middle of the face, painted again
blink = np.linalg.norm(b.target("eyeBlinkLeft") + b.target("eyeBlinkRight"), axis=1)  # how far each vertex travels in a blink
ys, xs, p, nrm, q, travel = places(middle, blink)
front, _ = seen(p, q)
facing = smoothstep(0.12, 0.45, nrm[:, 2]) * front
take = np.zeros((middle.size[1], middle.size[0]), np.float32)
take[ys, xs] = facing
take = cv2.GaussianBlur(spread(take, ys, xs), (0, 0), 2.5)  # soft borders between what is repainted and what is kept
again = np.zeros((middle.size[1], middle.size[0], 3), np.float32)
again[ys, xs] = from_photo(q, photo_new.astype(np.float32))
again = spread(again, ys, xs)
old_middle = resized(middle).astype(np.float32)
new_middle = old_middle * (1 - take[..., None]) + again * take[..., None]
# The upper lids. With the eyes open most of a lid is folded away: the camera saw only its edge and
# the lashes, and the whole lid would be painted with them, stretched. The part that unfolds in a
# blink gets smooth lid skin instead, darker towards its edge (the lash line).
for side in (-1, 1):
    eye = (np.sign(p[:, 0]) == side) & (travel > 0.0005)
    if not eye.any():
        continue
    top = travel[eye].max()
    above = eye & (travel < 0.002) & (p[:, 1] > p[eye & (travel > 0.8 * top), 1].mean() + 0.004)  # lid skin that hardly moves, over the eye
    tone = 1.06 * (np.median(new_middle[ys[above], xs[above]], axis=0) if above.sum() > 30 else np.median(new_middle[ys[eye], xs[eye]], axis=0))
    fold = np.zeros(take.shape, np.float32)
    fold[ys[eye], xs[eye]] = smoothstep(0.002, 0.0045, travel[eye])
    shade = np.ones(take.shape, np.float32)
    lash = (0.8, 0.7) if BEAUTY else (0.5, 0.78)  # how dark the lash line is, and from where on the lid: with `beauty`, lined
    shade[ys[eye], xs[eye]] = 0.95 - lash[0] * smoothstep(lash[1], 0.98, travel[eye] / top)
    fold = cv2.GaussianBlur(fold, (0, 0), 1.5)[..., None]
    shade = cv2.GaussianBlur(shade, (0, 0), 1.0)[..., None]
    new_middle = new_middle * (1 - fold) + tone[None, None] * shade * fold
    print(f"  upper lid ({'left' if side > 0 else 'right'}): travels up to {top * 1000:.1f} mm; skin tone {tone.round()}")


def seg_distance(xy, line):
    """Distance from points (n×2) to a polyline (m×2), and how far along it the nearest place is (0…1)."""
    best, at = np.full(len(xy), np.inf), np.zeros(len(xy))
    lengths = np.linalg.norm(np.diff(line, axis=0), axis=1)
    start = np.r_[0, np.cumsum(lengths)] / lengths.sum()
    for k in range(len(line) - 1):
        a, d = line[k], line[k + 1] - line[k]
        t = np.clip(((xy - a) @ d) / max(d @ d, 1e-12), 0, 1)
        dist = np.linalg.norm(xy - (a + t[:, None] * d), axis=1)
        closer = dist < best
        best[closer] = dist[closer]
        at[closer] = start[k] + t[closer] * (start[k + 1] - start[k])
    return best, at


if BEAUTY:
    # Liner along the upper lashes: the edge of each eye's opening, from the inner corner to the
    # outer, thicker towards the outer corner and on into a short wing, out and up; seen from the front.
    ys, xs, p, nrm, q = places(middle)
    liner = np.zeros(take.shape, np.float32)
    for loop in eye_loops:
        rim = b.pos[loop]
        i0, i1 = np.argmin(np.abs(rim[:, 0])), np.argmax(np.abs(rim[:, 0]))  # inner and outer corners
        n_ = len(loop)
        chains = [np.r_[[(i0 + k) % n_ for k in range((i1 - i0) % n_ + 1)]], np.r_[[(i0 - k) % n_ for k in range((i0 - i1) % n_ + 1)]]]
        upper = max(chains, key=lambda c: rim[c, 1].mean())
        line = rim[upper, :2]
        side = np.sign(line[-1, 0])
        wing = line[-1] + 0.0042 * np.array([side, 0.55]) / np.hypot(1, 0.55)
        line = np.vstack([line, wing])
        d, t = seg_distance(p[:, :2], line)
        corner_at = 1 - np.linalg.norm(wing - line[-2]) / (np.linalg.norm(np.diff(line, axis=0), axis=1).sum())
        width = np.interp(t, [0, 0.35, corner_at * 0.9, corner_at, 1], [0.35, 0.6, 1.0, 1.0, 0.12]) * 0.0013
        near = np.linalg.norm(p[:, :2] - rim[:, :2].mean(0), axis=1) < 0.03
        liner[ys, xs] = np.maximum(liner[ys, xs], (1 - smoothstep(0.7 * width, 1.1 * width, d)) * near * (p[:, 2] > rim[:, 2].min() - 0.004))
    liner = cv2.GaussianBlur(liner, (0, 0), 0.6)[..., None]
    new_middle = new_middle * (1 - 0.85 * liner) + np.array(LOOK["liner_colour"], np.float32) * 0.85 * liner
    print(f"  liner on the lids: {(liner > 0.5).sum()} pixels")
my0, mx0 = middle.at[1], middle.at[0]
atlas[my0:my0 + middle.size[1], mx0:mx0 + middle.size[0]] = np.clip(new_middle, 0, 255).astype(np.uint8)
# how well does the map from head to photo fit? The middle painted from the *plain* photo should match what was there
check = np.zeros_like(again)
check[ys, xs] = from_photo(q, plain)
sure = np.zeros(take.shape, bool)
sure[ys, xs] = facing > 0.9
print(f"middle of the face: {facing.mean() * 100:.0f}% repainted; plain photo vs old middle differ by {np.abs(check - old_middle)[sure].mean():.1f} of 255 on average")
cv2.imwrite(f"{out}/middle-check.png", np.hstack([old_middle, check, new_middle]).astype(np.uint8))

# ------------------------------------------------------------------ the eyeballs
# the iris in the restored face: a circle found in each eye opening
gray = cv2.cvtColor(cv2.resize(restored, (1024, 1024), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)  # two pixels for each of the face's
irises = []  # centre and radius, in old texture pixels
scale_face = np.hypot(T[0, 0], T[0, 1])  # face pixels per old texture pixel
for loop in eye_loops:
    c_old = to_photo(b.pos[loop]).mean(0)
    c_face = T[:, :2] @ c_old + T[:, 2]
    r_guess = 0.0059 * np.linalg.norm(coef[n + 1]) * scale_face * 2  # an iris is about 11.8 mm across; in restored pixels
    cxr, cyr = (2 * c_face + 0.5).astype(int)
    half = int(r_guess * 3.2)
    roi = gray[cyr - half:cyr + half, cxr - half:cxr + half]
    found = cv2.HoughCircles(cv2.GaussianBlur(roi, (0, 0), 1.5), cv2.HOUGH_GRADIENT, dp=1, minDist=half, param1=60, param2=12, minRadius=int(r_guess * 0.85), maxRadius=int(r_guess * 1.12))
    if found is None:
        centre, radius = np.array([cxr, cyr], float), r_guess
        print("  iris not found: using the eye's centre")
    else:
        fx, fy, fr = found[0, 0]
        centre, radius = np.array([cxr - half + fx, cyr - half + fy]), float(fr)
    c_old = Tinv[:, :2] @ ((centre - 0.5) / 2) + Tinv[:, 2]
    irises.append((c_old, radius / 2 / scale_face))
    print(f"  iris at restored px {centre.round(1)}, radius {radius:.1f} (expected about {r_guess:.1f})")

radius = np.mean([r for _, r in irises])  # two irises are the same size
irises = [(c, radius) for c, _ in irises]
mask = np.zeros((HEIGHT, WIDTH, 3), np.float32)  # red hair/iris, green lips, blue skin (stored as BGR below)
eye_debug = []
for it in (i for i in items if i.island["kind"] == "eye"):
    ys, xs, p, nrm, q = places(it)
    qi = np.round(q - [x0, y0]).astype(int)
    inside_photo = (qi[:, 0] >= 0) & (qi[:, 1] >= 0) & (qi[:, 0] < covered.shape[1]) & (qi[:, 1] < covered.shape[0])
    lid = np.ones(len(p), bool)
    lid[inside_photo] = covered[qi[inside_photo, 1], qi[inside_photo, 0]]  # skin in front of it: an eyelid
    open_ = (~lid) & (nrm[:, 2] > 0.3)
    shown = np.zeros((it.size[1], it.size[0]), np.float32)
    shown[ys, xs] = open_
    shown = smoothstep(0.5, 1.0, cv2.GaussianBlur(cv2.erode(shown, np.ones((3, 3), np.uint8)), (0, 0), 2.0))
    colour = np.zeros((it.size[1], it.size[0], 3), np.float32)
    colour[ys, xs] = from_photo(q, photo_new.astype(np.float32))
    # the white of this eye: the bright, colourless part of what the photo shows of it
    vis = colour[ys, xs][open_]
    if len(vis):
        bright = vis[(vis.max(1) - vis.min(1) < 40) & (vis.mean(1) > np.percentile(vis.mean(1), 60))]
        white = np.median(bright, axis=0) if len(bright) > 20 else np.array([215, 215, 220.0])
    else:
        white = np.array([215, 215, 220.0])
    white = white * max(1, (198 if BEAUTY else 186) / white.mean())  # the photo's whites are in the lids' shade: not darker than a light grey
    painted = np.zeros((it.size[1], it.size[0]), np.float32)
    painted[ys, xs] = 0.8 + 0.2 * np.clip(nrm[:, 2], 0, 1)  # a little darker towards the sides and the back
    cover = np.zeros(painted.shape, np.uint8)
    cover[ys, xs] = 1
    painted[cover == 0] = 0.8
    ball = white[None, None] * painted[..., None]
    # The lids hide part of the iris from the camera. That part is painted from the part that
    # shows: an iris is the same all the way round, so the colour at each distance from its centre.
    d = np.min([np.linalg.norm(q - c, axis=1) / r for c, r in irises], axis=0)  # distance from the iris's centre, in its radii
    ring = np.minimum((d * 16).astype(int), 17)
    known = open_ & (d < 1.1)
    if known.sum() > 50:
        vis_colour = colour[ys, xs]
        profile = np.array([np.median(vis_colour[known & (ring == k)], axis=0) if (known & (ring == k)).sum() > 3 else [np.nan] * 3 for k in range(18)])
        for k in range(18):  # rings the photo doesn't show take the next one's colour
            if np.isnan(profile[k, 0]):
                ok = np.flatnonzero(~np.isnan(profile[:, 0]))
                profile[k] = profile[ok[np.argmin(np.abs(ok - k))]]
        frac = np.clip(d * 16 - 0.5, 0, 16.999)
        lo_ring = frac.astype(int)
        whole_iris = profile[lo_ring] * (1 - (frac - lo_ring))[:, None] + profile[np.minimum(lo_ring + 1, 17)] * (frac - lo_ring)[:, None]
        if BEAUTY:  # a darker ring at the iris's edge: the eyes read clearer
            whole_iris *= (1 - 0.35 * smoothstep(0.8, 1.0, d))[:, None]
        in_iris = ((1 - smoothstep(0.92, 1.04, d)) * (nrm[:, 2] > 0.3))[:, None]
        ball[ys, xs] = ball[ys, xs] * (1 - in_iris) + whole_iris * in_iris
    result = ball * (1 - shown[..., None]) + colour * shown[..., None]
    atlas[it.at[1]:it.at[1] + it.size[1], it.at[0]:it.at[0] + it.size[0]] = np.clip(result, 0, 255).astype(np.uint8)
    # the iris, for recolouring
    iris = np.zeros(painted.shape, np.float32)
    iris[ys, xs] = (1 - smoothstep(0.9, 1.06, d)) * (nrm[:, 2] > 0.3)
    mask[it.at[1]:it.at[1] + it.size[1], it.at[0]:it.at[0] + it.size[0], 2] = cv2.GaussianBlur(iris, (0, 0), 0.8)
    eye_debug.append(np.clip(result, 0, 255).astype(np.uint8))
    print(f"  eyeball island: {open_.mean() * 100:.0f}% shows in the photo; white {white.round()}")
cv2.imwrite(f"{out}/atlas.png", atlas)

# ------------------------------------------------------------------ hair, lips, skin
HAIR, BROWS, LIPS = [17], [2, 3], [12, 13]
SKIN = [1, 7, 8, 10, 14, 15]
# a second reading of the whole photo, for what lies outside the face picture (hair at the sides, neck, clothes)
whole = cv2.resize(b.texture[y0:y1, x0:x1], (512, 512), interpolation=cv2.INTER_CUBIC)
parse_whole = softmax(network("bisenet_resnet_34", whole, "imagenet"))


def reading(q):
    """At pixels of the old texture: how much each is hair, brows, lips, skin (0…1)."""
    c = (np.c_[q, np.ones(len(q))] @ T.T).astype(np.float32)
    inside_face = smoothstep(6, 70, np.minimum(np.minimum(c[:, 0], 511 - c[:, 0]), np.minimum(c[:, 1], 511 - c[:, 1])))
    wq = ((q - [x0, y0] + 0.5) * [512 / (x1 - x0), 512 / (y1 - y0)] - 0.5).astype(np.float32)

    def read(parse, xy, classes):
        return sample(parse[classes].sum(0).astype(np.float32), xy, cv2.INTER_LINEAR).reshape(-1)

    return {name: read(parse_face, c, classes) * inside_face + read(parse_whole, wq, classes) * (1 - inside_face)
            for name, classes in (("hair", HAIR), ("brows", BROWS), ("lips", LIPS), ("skin", SKIN))}


def r_lips(layers):
    """Where the lips are, with a little room around them: no beard there."""
    return np.clip(cv2.GaussianBlur(layers["lips"], (0, 0), 2) * 1.5, 0, 1)


def beard_of(colour, skin, p):
    """A beard reads as skin to the network: found here by its colour, below the nose, where skin is."""
    c = colour.astype(np.float32)
    lum = c.mean(1)
    red = (c[:, 2] - c[:, 0]) / np.maximum(c.sum(1), 1)  # how much redder than blue (the pictures are BGR)
    clean = skin > 0.8
    ref = (p[:, 1] > tip[1] + 0.035) & clean & (np.abs(p[:, 0]) < 0.035)  # the forehead: skin for sure
    if ref.sum() < 50:
        return np.zeros(len(c), np.float32)
    lum0, red0 = np.median(lum[ref]), np.median(red[ref])
    darker = smoothstep(0.06, 0.22, (lum0 - lum) / lum0) + smoothstep(0.03, 0.09, red - red0)
    low = smoothstep(tip[1] - 0.004, tip[1] - 0.014, p[:, 1])  # from just under the nose down…
    low *= smoothstep(tip[1] - 0.125, tip[1] - 0.1, p[:, 1])  # …to a little under the chin,
    low *= smoothstep(-0.015, 0.015, p[:, 2])  # on the front half of the head: a shaded neck is not a beard
    return np.clip(darker, 0, 1) * low * skin


for it in (photo, middle):
    if it is photo:
        mx, my = photo.grid_old()
        q = np.c_[mx.reshape(-1), my.reshape(-1)].astype(np.float64)
        r = reading(q)
        shape = (photo.size[1], photo.size[0])
        layers = {k: v.reshape(shape) for k, v in r.items()}
        # where on the head each pixel is: from the photo's own triangles
        tris = photo.island["tris"]
        corners = it.to_new(vpx[b.idx[tris]].reshape(-1, 2)).reshape(-1, 3, 2) - it.at
        ids = raster(it, tris, corners)
        ys, xs, t, w = weights(ids, corners)
        p = (b.pos[b.idx[tris][t]] * w[..., None]).sum(1)
        # over the top and the back of the head the photo is a smear the network can't read: what isn't skin there is hair
        eye_y = b.pos[eye_loops[0], 1].mean()
        high = np.zeros(shape, np.float32)
        high[ys, xs] = np.maximum(smoothstep(eye_y + 0.035, eye_y + 0.055, p[:, 1]), smoothstep(-0.02, -0.05, p[:, 2]) * smoothstep(eye_y - 0.07, eye_y - 0.04, p[:, 1]))
        high = spread(high, ys, xs)
        layers["hair"] = np.maximum(layers["hair"], high * (1 - layers["skin"]))
        if BEARD:
            beard = np.zeros(shape, np.float32)
            beard[ys, xs] = beard_of(photo_new[ys, xs], layers["skin"][ys, xs], p)
            # a beard is one area, not its single hairs: thin places in it are filled in
            closed = cv2.morphologyEx(beard, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
            layers["beard"] = cv2.GaussianBlur(np.maximum(beard, 0.85 * closed), (0, 0), 3)
    else:
        ys, xs, p, nrm, q = places(middle)
        r = reading(q)
        layers = {}
        for k, v in r.items():
            layer = np.zeros((it.size[1], it.size[0]), np.float32)
            layer[ys, xs] = v
            layers[k] = layer
        if BEARD:
            beard = np.zeros((it.size[1], it.size[0]), np.float32)
            beard[ys, xs] = beard_of(new_middle[ys, xs], r["skin"], p)
            closed = cv2.morphologyEx(beard, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
            layers["beard"] = cv2.GaussianBlur(np.maximum(beard, 0.85 * closed), (0, 0), 1.5) * (1 - r_lips(layers))
        for k in layers:  # the island's margin takes the values next to it
            layers[k] = spread(layers[k], ys, xs)
    hair = np.clip(layers["hair"] + layers["brows"] + layers.get("beard", 0), 0, 1)
    skin = np.clip(layers["skin"] + layers["brows"] + layers["lips"], 0, 1)  # the tone goes under brows, beard and lips too
    part = mask[it.at[1]:it.at[1] + it.size[1], it.at[0]:it.at[0] + it.size[0]]
    part[..., 2] = hair
    part[..., 1] = layers["lips"]
    part[..., 0] = skin
small = cv2.resize(mask, (WIDTH // 2, HEIGHT // 2), interpolation=cv2.INTER_AREA)
cv2.imwrite(f"{out}/mask.png", np.clip(small * 255, 0, 255).astype(np.uint8))

uv.tofile(f"{out}/uv.f32")
# what the engine needs to know to recolour: the average brightness of what each mask covers (in linear light)
lin = (atlas.astype(np.float32) / 255) ** 2.2
lum = lin[..., 2] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 0] * 0.0722
scalp = mask[..., 2] * (1 - mask[..., 0])
eyes_area = np.zeros(mask.shape[:2], bool)
for it in (i for i in items if i.island["kind"] == "eye"):
    eyes_area[it.at[1]:it.at[1] + it.size[1], it.at[0]:it.at[0] + it.size[0]] = True
avg = lambda wgt: float((lum * wgt).sum() / max(wgt.sum(), 1e-6))  # noqa: E731
# an iris without its pupil: the brighter two thirds of it
iris_w = mask[..., 2] * eyes_area
iris_lum = lum[iris_w > 0.5]
iris_ref = float(iris_lum[iris_lum >= np.percentile(iris_lum, 33)].mean()) if len(iris_lum) else 0.2
meta = {
    "size": [WIDTH, HEIGHT],
    "luma": {"hair": avg(mask[..., 2] * ~eyes_area), "scalp": avg(scalp * ~eyes_area), "lips": avg(mask[..., 1]), "iris": iris_ref,
             "skin": avg(mask[..., 0] * (1 - mask[..., 2]) * (1 - mask[..., 1]) * ~eyes_area)},
    "irises": [[float(c[0]), float(c[1]), float(r)] for c, r in irises],
}
json.dump(meta, open(f"{out}/meta.json", "w"), indent=1)
print("wrote", out, json.dumps(meta["luma"]))
