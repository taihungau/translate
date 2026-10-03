import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript, LOCAL_MODELS } from "../public/local-asr.js";

test("drops text speech models invent for music and silence", () => {
  for (const junk of ["[Music]", "(applause)", "♪♪", "Thank you.", "Thanks for watching!", " you ", "...", "[BLANK_AUDIO]"]) {
    assert.equal(cleanTranscript(junk), "", junk);
  }
});

test("keeps real dialogue and strips inline sound tags", () => {
  assert.equal(cleanTranscript("Get down! [gunshot] Now!"), "Get down! Now!");
  assert.equal(cleanTranscript("Thank you for coming."), "Thank you for coming.");
});

test("every model option names a kind and at least one repo", () => {
  for (const [key, m] of Object.entries(LOCAL_MODELS)) {
    assert.ok(["whisper", "moonshine"].includes(m.kind), key);
    assert.ok(m.repos.length > 0, key);
  }
});
