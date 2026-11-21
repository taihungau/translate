# How the talking faces were made

`public/avatars/woman.glb` and `man.glb` are built from two downloaded sample busts with the
scripts here. Nothing in this folder runs in the app or on the server; it is kept so that the
models can be rebuilt, or another face prepared the same way.

## What goes in

- The "Head 2.0" sample busts (GLB, about 27 MB each) from <https://avatarsdk.com/avatars/>:
  one mesh, 66 face shapes (ARKit's and 14 visemes), the bones `chest → neck → head → eyeLeft,
  eyeRight`, and one 4096×2048 texture that is mostly empty. Most of the head is painted straight
  from the photo it was made from (a patch about 520 px wide); the middle of the face has a
  denser island of its own.
- For the woman's hair: `avatars/avaturn.glb` from
  <https://github.com/met4citizen/TalkingHead> (hair cards on two meshes).
- Three networks, as ONNX files, from <https://huggingface.co/facefusion/models-3.0.0>:
  `gfpgan_1.4.onnx`, `gpen_bfr_1024.onnx` (face restoration) and `bisenet_resnet_34.onnx` (face
  parsing: which pixel is skin, brow, lip, hair…).

See `public/avatars/LICENSE.txt` for what these may be used for.

## Steps

```sh
# once
npm i --no-save @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer sharp
pip install onnxruntime numpy opencv-python-headless

# 1. the texture: sharper, compact, with the map of hair, lips and skin (about 20 s each on a CPU)
FACE_MODELS=models python tools/avatar/bake.py female.glb out/female
FACE_MODELS=models python tools/avatar/bake.py male.glb out/male beard

# 2. the model
node tools/avatar/prep-bust.mjs female.glb public/avatars/woman.glb atlas=out/female hair=avaturn.glb
node tools/avatar/prep-bust.mjs male.glb public/avatars/man.glb atlas=out/male
```

`bake.py` (with `bust.py`, which reads the GLB):

1. lays the texture's islands out again in 2048×1568, the photo three times larger;
2. finds the eyes, the nose and the mouth from the mesh, cuts the face out of the photo the way
   the networks expect it (512 px, FFHQ alignment), restores it with GFPGAN and then GPEN, and
   lays it back over the enlarged photo (its overall tone brought back to the photo's);
3. paints the middle of the face again from that photo, wherever the camera could see it. The
   map from a place on the head to a pixel of the photo is known on the rim of the hole the
   photo's mesh has there; a thin-plate spline carries it inside. (Painting it from the
   *unrestored* photo reproduces the sample's own texture to within 3 of 255: the map is right.)
   The upper lids get smooth skin where they unfold in a blink, with a darker edge;
4. paints the eyeballs again: what shows between the lids from the photo, white elsewhere, and
   the iris completed under the lids from the part that shows, so that the eyes can turn;
5. writes the map: red = hair (with blue: brows and beard; on the eyeballs: the iris), green =
   lips, blue = skin. Hair, brows, lips and skin come from the parsing network; a beard (the
   `beard` argument) is found by its colour, since the network reads it as skin.

`prep-bust.mjs` adds smooth normals, splits skin, eyes, teeth and the inside of the mouth into
parts, drops the face shapes the engine never uses and stores the rest as 16-bit numbers, takes
the new texture and its map (in the occlusion slot at strength 0, where `public/avatar.js` picks
it up), fits the hair (the two models' eyes meet; bound to the bust's bones; the head's own
painted hair is pushed in by up to 7 mm under it) and compresses everything with meshopt.

A new face needs the same kind of bust (Avatar SDK's "Head 2.0"), or `bust.py` taught to read
another layout.
