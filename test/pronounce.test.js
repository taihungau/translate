import { test } from "node:test";
import assert from "node:assert/strict";
import { ruToLatin, enToCyrillic, phonesToCyrillic, pronounce } from "../public/pronounce.js";

test("writes Russian in Latin letters the way it is said", () => {
  assert.equal(ruToLatin("Привет, как дела?"), "Privet, kak dela?");
  assert.equal(ruToLatin("Что ты делаешь сегодня?"), "Shto ty delayesh sevodnya?");
  assert.equal(ruToLatin("Мне кажется, это его решение."), "Mne kazhetsa, eto yevo resheniye.");
  assert.equal(ruToLatin("Красный и синий"), "Krasny i siniy");
  assert.equal(ruToLatin("хорошего дня, но много дел"), "khoroshevo dnya, no mnogo del");
  assert.equal(ruToLatin("Ещё одна семья"), "Yeshchyo odna semya");
});

test("writes dictionary phones in Russian letters with the stress marked", () => {
  assert.equal(phonesToCyrillic("HH AH0 L OW1"), "хало́у");
  assert.equal(phonesToCyrillic("M Y UW1 Z IH0 K"), "мью́зик");
  assert.equal(phonesToCyrillic("W ER1 L D"), "уорлд");
  assert.equal(phonesToCyrillic("Y EH1 S"), "ес");
  assert.equal(phonesToCyrillic("B EH1 D"), "бед");
});

test("writes English in Russian letters, keeping punctuation and capitals", () => {
  const dict = { "i": "AY1", "don't": "D OW1 N T", "know": "N OW1", "you": "Y UW1", "mary": "M EH1 R IY0" };
  assert.equal(enToCyrillic("I don't know, you!", dict), "Ай доунт ноу, ю!");
  assert.equal(enToCyrillic("Mary's", dict), "Ме́риз");
  assert.equal(enToCyrillic("The end", dict), "Зэ енд"); // "end" isn't in this dictionary: spelling rules
});

test("adds nothing when the text is already in the other alphabet", () => {
  assert.equal(pronounce("Hello", "ru"), "");
  assert.equal(pronounce("", "en"), "");
});
