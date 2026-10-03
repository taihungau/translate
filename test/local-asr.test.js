import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript, MODEL } from "../public/local-asr.js";

test("drops text speech models invent for music and silence", () => {
  for (const junk of ["[Music]", "(applause)", "♪♪", "Thank you.", "Thanks for watching!", " you ", "...", "[BLANK_AUDIO]"]) {
    assert.equal(cleanTranscript(junk), "", junk);
  }
});

test("keeps real dialogue and strips inline sound tags", () => {
  assert.equal(cleanTranscript("Get down! [gunshot] Now!"), "Get down! Now!");
  assert.equal(cleanTranscript("Thank you for coming."), "Thank you for coming.");
});

test("uses Whisper Large v3 Turbo with a half-precision encoder", () => {
  assert.equal(MODEL.repo, "onnx-community/whisper-large-v3-turbo");
  assert.equal(MODEL.dtype.encoder_model, "fp16");
});

test("collapses the loops models produce over music", () => {
  assert.equal(cleanTranscript("go go go go go"), "go");
  assert.equal(cleanTranscript("I'm here. I'm here. I'm here. I'm here."), "I'm here.");
  assert.equal(cleanTranscript("No, no. Listen to me."), "No, no. Listen to me.");
});
