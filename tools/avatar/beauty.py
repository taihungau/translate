"""Retouch and soft make-up, painted into a face texture (for bake.py's `beauty` option).

Works on a picture of the face (BGR, float32, 0…255) with its 68 landmarks (the iBUG layout:
jaw 0–16, brows 17–26, nose 27–35, eyes 36–47, lips 48–67; the picture's left eye is 36–41) and
soft maps of what is skin, brows, lips and eyes. All sizes follow the distance between the eyes,
so it works at any resolution.

- skin: small dark spots (moles, blemishes) healed; blotches evened out; pores kept, a little softer;
- under the eyes a little lighter;
- eyes: a warm rose-taupe shadow on the lids, deepest at the lash line and the outer corner; a
  dark liner along the upper lashes with a short wing; a soft smudge under the outer lower lashes;
- brows a little darker and fuller;
- blush on the apples of the cheeks; a soft contour under the cheekbones and along the jaw; light on
  the bridge of the nose, the cheekbones, the cupid's bow and the chin;
- lips: a richer rose, a defined edge, a little light on the lower lip.
"""
import cv2
import numpy as np

# How much of each (1: as designed). Colours are multipliers in BGR order.
LOOK = {
    "smooth": 0.9, "spots": 1.0, "under_eyes": 0.08,
    "shadow": 0.6, "shadow_colour": (0.74, 0.8, 0.9),
    "liner": 0.85, "liner_colour": (34, 30, 36), "liner_width": 0.022, "wing": 0.065, "lower_liner": 0.3,
    "brows": 0.12,
    "blush": 0.55, "blush_colour": (0.9, 0.88, 1.02),
    "contour": 0.07, "highlight": 0.06,
    "lips": 0.46, "lips_colour": (112, 98, 186), "lip_edge": 0.1, "lip_light": 0.1,
}

R_EYE, L_EYE = list(range(36, 42)), list(range(42, 48))


def smoothstep(a, c, x):
    t = np.clip((x - a) / (c - a), 0, 1)
    return t * t * (3 - 2 * t)


def gauss(x, s):
    return cv2.GaussianBlur(x, (0, 0), max(float(s), 0.3))


def lum(img):
    return img @ np.array([0.114, 0.587, 0.299], np.float32)


def spline(pts, per=16):
    """A Catmull-Rom curve through the points (n×2), as many points."""
    p = np.asarray(pts, np.float64)
    p = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    t = np.linspace(0, 1, per, endpoint=False)[:, None]
    out = []
    for i in range(1, len(p) - 2):
        a, b, c, d = p[i - 1], p[i], p[i + 1], p[i + 2]
        out.append(0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t ** 2 + (3 * b - a - 3 * c + d) * t ** 3))
    out.append(p[-2][None])
    return np.vstack(out)


def along(curve, n):
    """n points evenly spaced along a curve, and how far along each is (0…1)."""
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(curve, axis=0), axis=1))]
    t = np.linspace(0, d[-1], n)
    return np.c_[np.interp(t, d, curve[:, 0]), np.interp(t, d, curve[:, 1])], t / max(d[-1], 1e-9)


class Canvas:
    """Soft shapes (0…1) the size of the picture."""

    def __init__(self, shape):
        self.shape = shape[:2]
        h, w = self.shape
        self.ys, self.xs = np.mgrid[0:h, 0:w].astype(np.float32)

    def poly(self, pts, soft=0):
        m = np.zeros(self.shape, np.float32)
        cv2.fillPoly(m, [np.round(np.asarray(pts) * 16).astype(np.int32)], 1.0, cv2.LINE_AA, shift=4)
        return gauss(m, soft) if soft else m

    def stroke(self, pts, widths, soft=0):
        """A line through the points, as wide as `widths` (one for each point)."""
        m = np.zeros(self.shape, np.float32)
        for (x, y), w in zip(pts, widths):
            cv2.circle(m, (int(round(x * 16)), int(round(y * 16))), max(1, int(round(w / 2 * 16))), 1.0, -1, cv2.LINE_AA, shift=4)
        return gauss(m, soft) if soft else m

    def blob(self, centre, rx, ry, angle=0.0):
        """A soft ellipse: 1 in the middle, about 0.14 at its radii."""
        dx, dy = self.xs - centre[0], self.ys - centre[1]
        c, s = np.cos(angle), np.sin(angle)
        u = (dx * c + dy * s) / rx
        v = (-dx * s + dy * c) / ry
        return np.exp(-2 * (u * u + v * v))


def multiply(img, mask, colour, amount):
    """Darkens and tints by a colour (BGR multipliers), as much as mask × amount."""
    k = (mask * amount)[..., None]
    return img * (1 - k + k * np.asarray(colour, np.float32))


def lighten(img, mask, amount):
    return img * (1 + (mask * amount)[..., None])


def beautify(img, lm, parts, look=LOOK, log=print):
    """Returns the retouched picture. `parts`: soft maps (h×w, 0…1) "skin", "brows", "lips", "eyes"."""
    lm = np.asarray(lm, np.float64)
    eye_r, eye_l = lm[R_EYE].mean(0), lm[L_EYE].mean(0)
    u = float(np.linalg.norm(eye_l - eye_r))  # the eyes' distance: about 62 mm on a woman
    mm = u / 62
    # only around the face
    h, w = img.shape[:2]
    lo = np.maximum(np.floor(lm.min(0) - 0.6 * u), 0).astype(int)
    hi = np.minimum(np.ceil(lm.max(0) + 0.6 * u), [w, h]).astype(int)
    x0, y0 = lo
    x1, y1 = hi
    out_full = img.copy()
    im = img[y0:y1, x0:x1].astype(np.float32)
    pts = lm - [x0, y0]
    part = {k: np.clip(v[y0:y1, x0:x1], 0, 1).astype(np.float32) for k, v in parts.items()}
    cv = Canvas(im.shape)
    up = np.array([0.0, -1.0])
    disc = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(r) + 1, 2 * int(r) + 1))  # noqa: E731

    # ---- where not to retouch: the eyes, brows, lips and nostrils, with some room
    eyes = np.maximum(cv.poly(pts[R_EYE]), cv.poly(pts[L_EYE]))
    eyes = np.maximum(eyes, smoothstep(0.3, 0.7, part["eyes"]))
    lips = np.maximum(cv.poly(pts[48:60]), smoothstep(0.3, 0.7, part["lips"]))
    nostrils = cv.poly(np.vstack([pts[31:36], pts[30][None]]))
    away = np.maximum.reduce([cv2.dilate(eyes, disc(4 * mm)), cv2.dilate(smoothstep(0.2, 0.6, part["brows"]), disc(2 * mm)),
                              cv2.dilate(lips, disc(2 * mm)), cv2.dilate(nostrils, disc(2.5 * mm))])
    # the face itself (inside the jaw, up to the forehead): not the hairline, ears or neck
    hull = cv2.convexHull(np.vstack([pts[0:17], pts[17:27] + up * 0.35 * u]).astype(np.float32))[:, 0]
    face = gauss(cv2.erode(cv.poly(hull), disc(0.05 * u)), 0.05 * u)
    skin = smoothstep(0.3, 0.8, part["skin"]) * (1 - away) * face
    wider = smoothstep(0.3, 0.8, part["skin"]) * (1 - away) * cv2.dilate(cv.poly(hull), disc(0.06 * u))  # spots also on the jaw's edge
    skin_soft = gauss(skin, 1.5 * mm)

    # ---- skin: spots healed, blotches evened, pores kept
    f1, f2 = gauss(im, 0.7 * mm), gauss(im, 4 * mm)
    fine, mid = im - f1, f1 - f2
    smooth = f2 + 0.45 * mid + 0.8 * fine
    a = look["smooth"] * skin_soft
    res = im * (1 - a[..., None]) + smooth * a[..., None]
    closed = cv2.morphologyEx(im, cv2.MORPH_CLOSE, disc(3 * mm))  # dark spots up to about 6 mm across, filled in
    L, Lc = lum(im), lum(closed)
    spots = smoothstep(0.06, 0.12, (Lc - L) / np.maximum(Lc, 1)) * cv2.erode(wider, disc(2 * mm))
    spots = np.clip(gauss(cv2.dilate(spots, disc(1.2 * mm)), 0.8 * mm), 0, 1) * look["spots"]
    heal = gauss(closed, 1.5 * mm) + 0.6 * (closed - gauss(closed, 0.7 * mm))
    res = res * (1 - spots[..., None]) + heal * spots[..., None]
    log(f"  beauty: eyes {u:.0f} px apart; {skin.mean() * 100:.0f}% of the area is skin, {spots.sum() / max(skin.sum(), 1) * 100:.2f}% of it healed")

    # ---- under the eyes, lighter
    for lower in ([36, 41, 40, 39], [42, 47, 46, 45]):
        c = spline(pts[lower])
        band = cv.poly(np.vstack([c + [0, 0.035 * u], (c + [0, 0.2 * u])[::-1]]), soft=0.05 * u) * (1 - gauss(eyes, 0.02 * u))
        res = lighten(res, band, look["under_eyes"])
        res = multiply(res, band, (0.985, 1.0, 1.02), 1)  # less blue-violet

    # ---- eyes: shadow, liner
    for lid_i, brow_i in (([36, 37, 38, 39], [17, 18, 19, 20, 21]), ([45, 44, 43, 42], [26, 25, 24, 23, 22])):  # outer → inner
        lid, t = along(spline(pts[lid_i]), 80)
        brow, _ = along(spline(pts[brow_i]), 80)
        top = lid + 0.55 * (brow - lid)
        region = cv.poly(np.vstack([lid - [0, 0.01 * u], top[::-1]]), soft=0.03 * u)
        depth = cv.stroke(lid, np.full(len(lid), 0.22 * u), soft=0.09 * u)  # deepest at the lash line
        outer = lid[0]
        corner = cv.blob(outer + (outer - lid[-1]) * 0.12 + up * 0.08 * u, 0.2 * u, 0.13 * u)
        shade = np.clip(region * (0.55 * depth + 0.25) + 0.5 * corner * region, 0, 1) * (1 - eyes)
        res = multiply(res, shade, look["shadow_colour"], look["shadow"])
        # the liner: thin at the inner corner, widest at the outer, and a wing out and up from it
        out_dir = (lid[0] - lid[-1]) / np.linalg.norm(lid[0] - lid[-1])
        wing_dir = out_dir + 0.5 * up
        wing = outer + look["wing"] * u * wing_dir / np.linalg.norm(wing_dir)
        line, s = along(spline(np.vstack([lid[::-1][[0, 26, 53, 79]], wing])), 200)
        width_at = np.interp(s, [0, 0.35, 0.78, 1], [0.25, 0.6, 1.0, 0.12]) * look["liner_width"] * u
        line = line + up * (width_at / 2)[:, None] * 0.8  # sits on the lashes, not on the eye
        liner = cv.stroke(line, width_at, soft=0.0035 * u) * (1 - 0.7 * eyes)
        k = (liner * look["liner"])[..., None]
        res = res * (1 - k) + np.asarray(look["liner_colour"], np.float32) * k
    for lower in ([36, 41, 40], [45, 46, 47]):  # outer → in, under the eye
        c, s = along(spline(pts[lower]), 60)
        widths = np.interp(s, [0, 1], [0.022, 0.006]) * u
        smudge = cv.stroke(c + [0, 0.012 * u], widths, soft=0.012 * u) * (1 - eyes)
        res = multiply(res, smudge, (0.55, 0.55, 0.6), look["lower_liner"])

    # ---- brows: a little darker and fuller
    brows = gauss(smoothstep(0.2, 0.7, part["brows"]), 0.6 * mm)
    hairs = smoothstep(0.0, 0.12, (lum(gauss(res, 3 * mm)) - lum(res)) / 255 + 0.02)
    res = res * (1 - (brows * look["brows"] * (0.5 + 0.5 * hairs))[..., None])
    res = res * (1 - 0.3 * brows[..., None]) + gauss(res, 0.8 * mm) * 0.3 * brows[..., None]

    # ---- cheeks: blush, contour, light
    face_skin = gauss(smoothstep(0.3, 0.8, part["skin"]), 2 * mm) * (1 - gauss(np.maximum(eyes, lips), 3 * mm))
    for side, jaw, nose, eye_out, tilt in ((-1, 1, 31, 36, -0.35), (1, 15, 35, 45, 0.35)):
        apple = pts[jaw] * 0.57 + pts[nose] * 0.43
        apple[1] = (pts[29, 1] + pts[30, 1]) / 2
        blush = cv.blob(apple, 0.3 * u, 0.19 * u, tilt) * face_skin
        res = multiply(res, blush, look["blush_colour"], look["blush"])
        # contour: under the cheekbone, from the ear towards the mouth's corner
        start = pts[jaw] * 0.8 + pts[jaw + side * 1] * 0.2
        end = start + (pts[48 if side < 0 else 54] - start) * 0.45
        hollow, _ = along(np.vstack([start, end]), 40)
        contour = cv.stroke(hollow + [0, 0.1 * u], np.linspace(0.14, 0.06, 40) * u, soft=0.07 * u) * face_skin
        jawline, _ = along(spline(pts[(list(range(3, 7)) if side < 0 else list(range(13, 9, -1)))]), 60)
        centre = pts[30]
        inside = jawline + (centre - jawline) * 0.06
        contour = np.maximum(contour, cv.stroke(inside, np.full(60, 0.1 * u), soft=0.06 * u) * face_skin)
        res = multiply(res, contour, (0.9, 0.92, 0.96), look["contour"] / 0.08)
        # light on the cheekbone, above the blush and out towards the temple
        bone = apple + (pts[eye_out] - apple) * 0.55 + [side * 0.06 * u, 0]
        res = lighten(res, cv.blob(bone, 0.17 * u, 0.07 * u, tilt) * face_skin, look["highlight"])
    bridge, _ = along(np.vstack([pts[27], pts[30] + (pts[29] - pts[30]) * 0.3]), 40)
    res = lighten(res, cv.stroke(bridge, np.full(40, 0.05 * u), soft=0.03 * u) * face_skin, look["highlight"] * 1.1)
    bow = (pts[50] + pts[52]) / 2 + up * 0.035 * u
    res = lighten(res, cv.blob(bow, 0.06 * u, 0.025 * u) * (1 - lips), look["highlight"])
    chin = pts[8] + up * 0.1 * u
    res = lighten(res, cv.blob(chin, 0.1 * u, 0.06 * u) * face_skin, look["highlight"] * 0.8)

    # ---- lips
    lip_shape = gauss(np.maximum(cv.poly(pts[48:60]), smoothstep(0.3, 0.8, part["lips"])) * 0.5 + cv.poly(pts[48:60]) * 0.5, 0.008 * u)
    lip_shape = np.clip(lip_shape * 1.15, 0, 1)
    Lr = lum(res)
    target = np.asarray(look["lips_colour"], np.float32)
    rose = target[None, None] * (Lr / float(lum(target[None])[0]))[..., None]
    k = (lip_shape * look["lips"])[..., None]
    res = res * (1 - k) + rose * k
    edge = np.clip(lip_shape - gauss(cv2.erode(lip_shape, disc(0.012 * u)), 0.006 * u), 0, 1)
    res = multiply(res, edge, (0.85, 0.82, 0.9), look["lip_edge"] / 0.12)
    lower = (pts[57] + pts[66]) / 2 + up * 0.01 * u
    res = lighten(res, cv.blob(lower, 0.09 * u, 0.035 * u) * lip_shape, look["lip_light"])

    out_full[y0:y1, x0:x1] = np.clip(res, 0, 255)
    return out_full
