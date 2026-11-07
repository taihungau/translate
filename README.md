# Subtitle Translator (EN ⇄ RU)

A small web app that translates English movie subtitles into Russian in real time, using Claude.
The **EN ⇄ RU** button at the top swaps the languages, so it translates Russian into English too
(speech recognition then listens for Russian, and subtitle files are read as Russian).

It has two modes:

- **Live (microphone).** Press Start, allow the microphone and play the movie out loud. The
  browser transcribes the English it hears, and each phrase is shown in large Russian text a
  moment after it is spoken, then fades like a real subtitle. With Chrome's built-in translator,
  Russian appears while the sentence is still being spoken and is corrected when it ends. The
  app is always dark for use in a cinema, and the controls fade out while it is listening. Fullscreen fills the screen with
  the subtitle panel; English can be shown underneath if you want it. Each phrase is sent with
  the previous few lines so the translation keeps context (who is "you", ты vs вы, running jokes).
- **Video + subtitle file.** Load a local video and its English `.srt` or `.vtt` file. Translation
  begins at the playhead and runs ahead of it in parallel batches, so you can press play almost
  right away. Seeking moves the translation to the new position. Russian subtitles (or Russian
  + English) are drawn over the video, including in fullscreen. You can download the result as
  a Russian `.srt` file at any time.

## Pronunciation

Under each line the app shows how to say it in the other alphabet, so either side can read it
aloud:

- **Russian in English letters:** "Что ты делаешь сегодня?" → *Shto ty delayesh sevodnya?*
  Spelled the way it is said (что → *shto*, его → *yevo*, кажется → *kazhetsa*).
- **English in Russian letters:** "I don't know what you're talking about." →
  *Ай доунт ноу уат юр то́кинг аба́ут.* Words are looked up in the CMU Pronouncing Dictionary
  (downloaded once from jsDelivr, about 1 MB compressed, then kept for offline use) and the
  stressed syllable is marked. Words it doesn't know fall back to spelling rules.

Both can be turned off in Settings → Pronunciation.

## English course (Learn)

`learn.html` (the book tab, or "Курс английского" on the start screen) is an English course for a
Russian speaker, explained in Russian: **124 units, 991 phrases, in three tracks and seven levels,
A to G** (roughly CEFR A0, A1, A2, B1, B2, C1, C2; a letter means the same in every track), each
unit with its own icon.

- **Каждый день (every day), 58 units, A → G:** first words and "I don't understand", meeting
  people, family, likes, time, routine, café, shopping, clothes, home, weather, directions,
  transport, travel, hotel, the movies, groceries, the doctor, phone calls, bank and post, small
  talk, invitations, hobbies, opinions, plans, stories, complaints, health, phones and the
  internet; then diplomacy, discussion, feelings, money, news and advice; then shades of meaning,
  persuading, humor, phrasal verbs, formal and informal, storytelling, disagreeing and keeping a
  conversation going; and at G native idioms, slang, sounding natural, American culture, big ideas,
  hedging, emphasis and eloquence.
- **Грамматика (grammar), 44 units, B → G:** from pronouns, *to be*, articles and the present
  tenses, through the past, future, modals, comparison, Present Perfect and *if*, to Past
  Continuous, *used to*, quantity, *too/enough*, -ing or *to*, relative clauses, the passive, Past
  Perfect, reported speech, the third and mixed conditionals, deduction, *I wish*, question tags,
  inversion, cleft sentences, participle clauses and more. Each has the rule, a table of forms and
  the mistakes Russian speakers typically make (wrong → right, and why).
- **Работа (work), 22 units, C → G:** introducing yourself, colleagues, requests, calls, meetings,
  updates, feedback, emails, presentations, interviews, negotiating, networking, leading a team,
  difficult conversations, pitching, strategy, public speaking and talking to executives.
- **Five tasks per unit, one per skill**, shown as a checklist (the unit turns green when all are
  done): *Карточки* (learn every phrase), *Аудирование* (hear a phrase and pick what was said),
  *Чтение* (read a phrase and pick its meaning), *Говорение* (say it in English: checked by speech
  recognition in the app, self-checked elsewhere) and *Письмо* (the written test). Each exercise
  has 8 phrases and is passed with 6.
- Every phrase has the Russian meaning and the English **written in Russian letters** (the same
  spelling as under live subtitles; `test/learn.test.js` keeps them in sync).
- **Practice cards** in two modes: *Понимать* (English → Russian) and *Говорить* (Russian → English).
- **Read aloud in American English:** every phrase and word plays at normal or slow speed with
  Deepgram's Aura-2 voices (Thalia, or Orion for a male voice), through `GET /api/tts`, at
  0,5×, 1×, 1,5× or 2× speed (one remembered setting for every play button). It is real
  audio, so it plays even when an iPhone is on silent. The same line always gives the same MP3, so
  Vercel's CDN keeps it a year and each line is generated once. Without `DEEPGRAM_API_KEY` the
  page falls back to the phone's own US English voice.
- **A checklist for every lesson:** two tasks, *learn the phrases* (each one "Знаю" at least once)
  and *pass the test* (6 of 8 or better). The course list shows each lesson's progress as a ring
  that fills up and turns into a green tick when both are done, with ✓ chips for the two tasks;
  every phrase on a lesson page gets its own tick; each level counts its finished lessons and its
  bar turns green when all are done.
- **Daily goal and streak:** 5, 10 or 20 cards a day with a progress ring, days in a row, and a
  small celebration when the goal is met or a unit is finished.
- **Speaking check:** she says the phrase, Deepgram writes down what it heard, and the missed words
  are marked in red with a score.
- **Written test** at the end of every unit (`#test-<unit>`): the unit's phrases in Russian, in a
  new order, typed in English and marked like a written test. Case, punctuation and contractions
  ("I'm" = "I am") don't matter, but every word must be there and nothing extra. Wrong or extra
  words are struck out, missing ones shown in the right answer, a word one letter off is pointed
  out ("work → works"), and "Мой ответ тоже верный" accepts another correct wording. Results feed
  spaced repetition and the daily goal; the best score per unit is kept; mistakes can be practised
  as cards. A Russian keyboard is noticed and she is asked to switch.
- **Her own sentences:** after the test she can write sentences of her own on the unit's topic.
  `POST /api/check-writing` has Claude mark each one (correct / almost / wrong), rewrite it as an
  American would and explain the rule in Russian. This part appears only when `ANTHROPIC_API_KEY`
  is set on the server.
- **Spaced repetition:** a known phrase comes back after 1, 3, 7, 14 and 30 days; a forgotten one
  comes back in a few cards. **"Из фильмов"** reviews phrases heard in live subtitles.
- **Progress follows a person with a personal code.** With a database connected, the first card
  saves progress on the server under a code like `K7QM-4TZP-9HXW` (12 letters and digits without
  look-alikes), shown in "Мой прогресс" on the course page. Every change is saved within a couple
  of seconds; on another phone she types the code, or opens the link "Поделиться" makes
  (`learn.html?code=…`), and everything comes back. `POST /api/progress` merges what a phone sends
  with what is stored (`public/learn-sync.js`, the same merge on both sides): each card keeps its
  latest answer, each test or exercise its best score, each day its larger card count, so two
  phones never overwrite each other. Codes are kept two years after the last save.
  **Setup:** on Vercel, Storage → Upstash → Redis (free) → connect to the project (any prefix),
  then redeploy. Without it, or in the published copy, progress stays in the browser.
- Lesson icons: [Lucide](https://lucide.dev) 1.56.0 (ISC; some from Feather, MIT), drawn from a
  sprite inside `learn.html`; licence texts in `public/icons-LICENSE.txt`.

## Appearance

Colours are Apple's system colours (iOS Human Interface Guidelines) in light and dark; coloured
text on light backgrounds uses Apple's high-contrast variants. The course's buttons follow Apple's
button styles: filled systemBlue for the main action, gray fill with blue text for the rest, iOS
segmented controls for choices (goal, voice, speed, mode, track), and buttons dim when pressed.
The course sits on a wallpaper with frosted-glass panels, controls and captions, as on an iPhone:
translucent white in light mode, smoked in dark mode. "Фон" on the course page picks a lake at
dawn, by day, at sunset or at dusk, the mountains, or no wallpaper; "Авто" (the default) follows the
time of day. The pictures are WebP files in `public/backgrounds/` (with small thumbnails for the
picker); the browser bar takes each picture's sky colour.
A sun/moon button at the top of the course switches between light and dark in one tap, and
"Тема" (Авто / Светлая / Тёмная) sets it for good; it is the same setting as the subtitles app's
Appearance, so both pages match. "Авто" follows the phone, or the app the page is shown in.

Settings → Appearance: Automatic (follows the phone), Light or Dark. Full-screen (cinema) mode is
always dark so the screen doesn't light up the room. The course uses the same setting.

## Translation engines

Pick the engine at the top of the page:

- **Chrome built-in (default, free).** Desktop Chrome 138 or later has an on-device
  translator. No API key or server is needed, and the first use downloads Chrome's Russian
  language pack. Translation is literal and doesn't use earlier lines for context.
- **On-device model (free, works on phones).** Opus-MT English→Russian (or Russian→English) running in the browser
  with transformers.js, used automatically where Chrome's translator is missing (phones, Safari,
  Firefox). The first use downloads about 80 MB, then it is cached.
- **Claude.** More natural, context-aware subtitles. It needs `ANTHROPIC_API_KEY` set on the
  server, and is the only option in browsers without the built-in translator (Safari, Firefox,
  and Chrome on phones).

## Speech recognition (live mode)

**Deepgram Nova-3 (used when `DEEPGRAM_API_KEY` is set on the server).** One of the most
accurate live speech recognisers, with words arriving a few hundred milliseconds after they are
spoken, and it works in any browser, including phones. The microphone is streamed straight to
Deepgram over a WebSocket; the server only hands the browser a short-lived token
(`/api/speech-token`), so the API key never leaves the server. Words are shown while they are
spoken and each sentence is finished at a 300 ms pause (or after 1 s without words, even over
music). Get a key at [console.deepgram.com](https://console.deepgram.com); new accounts come
with free credit.

**Whisper Large v3 Turbo on the device (fallback when no Deepgram key is set).** Runs in the
browser with [transformers.js](https://github.com/huggingface/transformers.js) on the GPU
(WebGPU), using the settings of the library's official demo for this model: half-precision
encoder, 4-bit decoder. It needs Chrome or Edge on a computer with WebGPU (not phones), and a
one-time download of about 1.3 GB.

Audio is cut into 2–12 s stretches at natural pauses (Whisper is most accurate with several
seconds of context), and nothing is dropped by a loudness gate. While a stretch is still being
spoken, Whisper re-reads it whenever it is free, so the caption updates live; the caption rolls
(previous sentence, then the current one). Finished stretches that arrive while Whisper is busy
are transcribed together in its next call, so it never falls behind the film.

The microphone is opened without call-style echo cancellation and noise suppression (which
remove film dialogue), with a selectable boost (default 3×) followed by a compressor so quiet
dialogue is lifted without loud effects clipping. The computer's own microphone (for example
"MacBook Pro Microphone") is preferred over the system default, and the choice is remembered.

## Offline use

After the first download the model is kept in the browser, and a service worker keeps the app
and its library available offline, so it works in a cinema without signal.

## Run it

Requires Node.js 18 or later. An Anthropic API key is only needed for the Claude engine.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
# open http://localhost:3000
```

| Variable            | Default           | Purpose                                                     |
| ------------------- | ----------------- | ----------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | none (required)   | Anthropic credentials, kept on the server only              |
| `TRANSLATE_MODEL`   | `claude-opus-5-5` | Model used for translation                                  |
| `TRANSLATE_EFFORT`  | `low`             | `low` gives the lowest latency; raise it for higher quality |
| `WRITING_MODEL`     | `claude-opus-5-5` | Model that checks sentences written in the course           |
| `WRITING_EFFORT`    | `low`             | Effort for that check                                       |
| `DEEPGRAM_API_KEY`  | none              | Live speech recognition with Deepgram Nova-3 (any device)    |
| `PORT`              | `3000`            | HTTP port                                                   |

Set `ACCESS_CODE` to require a code before anyone can translate (recommended on a public URL).
The page asks for it once and remembers it in that browser.

## Deploy on Vercel

The repo is ready for Vercel: `public/` is served as static files and `api/translate.js` runs
as a serverless function (`local/server.js` is only for running locally).

1. Push the repo to GitHub, then in Vercel choose **Add New… → Project** and import it.
   Leave the framework preset as **Other**; `vercel.json` sets everything else.
2. Under **Settings → Environment Variables**, add `DEEPGRAM_API_KEY` for speech recognition,
   `ANTHROPIC_API_KEY` if you use Claude for translation, and `ACCESS_CODE` so
   strangers who find the URL can't spend your API credit. `TRANSLATE_MODEL` and
   `TRANSLATE_EFFORT` work here too.
3. Deploy, then open the `https://….vercel.app` URL. Vercel serves over HTTPS, which browsers
   require before they allow the microphone.

From the command line instead: `npm i -g vercel`, then `vercel` to preview and
`vercel --prod` to publish. Add the environment variables with `vercel env add`.

Requests use the server-side refusal fallback (`fallbacks: "default"`), so if the model declines
a line, the API retries it on a fallback model inside the same call.

## Notes and limits

- Live mode uses the browser's Web Speech API, which works in Chrome, Edge and Safari but not
  Firefox. Chrome sends the audio to Google for recognition. It listens through the
  **microphone**, so play the movie through speakers, or route system audio into a virtual
  input device (for example BlackHole on macOS or VB-Cable on Windows).
- Live latency is roughly the time it takes the recognizer to end a phrase, plus one short API
  call.
- Repeated lines are cached in memory on the server.
- Video files never leave your machine. Only subtitle text is sent to the server.

## API

`POST /api/translate`

```json
{ "lines": [{ "id": "1", "text": "Wait up!" }], "context": ["earlier English line"], "direction": "en-ru" }
```

returns

```json
{ "translations": [{ "id": "1", "text": "Подожди!" }] }
```

`direction` is `"en-ru"` (the default) or `"ru-en"`. Each request accepts up to 60 lines. Lines the model fails to return are left out of the
response, and the client retries them.

## Development

```bash
npm test
```

The tests cover the SRT/VTT parser and the translator, using a mocked Claude client.
`samples/sample.en.srt` is a short subtitle file for trying out the video mode.
