# Meta prompt: the AI English teacher

A brief for an AI coding agent (or a developer) working in this repository. It describes what to
build, why, and how to know it is done. Paste it as the task, or work through it section by
section.

---

## 1. Role and goal

You are a senior product engineer and language-teaching designer. Turn this English course into
an app whose **main page is a live, talking AI English teacher**: a realistic face on screen that
the learner simply talks to, in real time, in English and Russian. Every lesson should feel like a
conversation with a funny, warm, endlessly patient tutor who keeps asking questions, plays games,
and quietly follows a real curriculum underneath.

The bar: **it must never be boring, and it must feel instant.** A learner should be laughing and
speaking English within ten seconds of opening the app.

## 2. Who it is for

- A Russian-speaking adult woman learning English on her iPhone, at any level from A (first words)
  to G (near native). Her level comes from the course's placement test or her own choice.
- Interested in beauty and cosmetology (the course has a cosmetology track), everyday life,
  travel, films.
- She may be shy about speaking. The teacher must make speaking feel safe and fun: praise effort,
  never shame mistakes, always give her something easy to say next.
- The whole interface is in Russian. English appears where she is learning it.

## 3. What exists already (read these first)

| Part | Where | What it gives you |
| --- | --- | --- |
| Course UI | `public/learn.html`, `public/learn.js` | Vanilla JS, no framework. Routes by hash (`route()`): `#daily` etc. (course main page), `#skill-speak/listen/read/write` (skill pages), lessons, practice, tests, workout, placement, `#look` (face colours). `setView()` renders a screen. |
| Curriculum | `public/lessons.js` | 4 tracks, levels A–G, 160 units; each unit has a title, goal, grammar tip in Russian and phrases `{ en, say, ru }` (`say` = pronunciation in Russian letters). |
| Learner state | `learn.js` (`localStorage`) | `progress` (spaced repetition per phrase), `placement.level`, `stats` (daily goal, streak), `skills`, `tests`, `voiceChoice`, `faceLooks`. Helpers: `myLevel()`, `nextLesson(track)`, `countCard()`, `confetti()`. |
| Talking face | `public/avatar.js` | three.js engine for two photo-real busts. `avatarStage(voice)`, `avatarSay(text, mediaElement, words)` (lips follow any `<audio>` clock), `avatarReact(good)`, `avatarListen(ms)`, colour options. |
| Speech in | `public/cloud-asr.js` | Deepgram Nova-3 streaming from the browser (16 kHz linear16 over WebSocket, short-lived token from `GET /api/speech-token`). |
| Speech out | `GET /api/tts` (`lib/handler.js`) | Deepgram Aura-2 English voices (Thalia, Orion), MP3, cached by the CDN for a year. |
| Claude | `translator.js`, `lib/writing.js` | `@anthropic-ai/sdk`, key `ANTHROPIC_API_KEY` on Vercel only. |
| Other repo | `taihungau/translate-georgian` | Same Deepgram streaming design (language per connection, keep-alive, reconnect with back-off). |

Secrets live only in Vercel environment variables (`DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`,
optional `ACCESS_CODE`). Never put a key in the browser or in git.

## 4. What to build

### 4.1 Save the current version first

Keep the course exactly as it is today in a branch or tag before changing anything
(`saved/course-before-ai-teacher`). The published claude.ai copy of the course stays as it is.

### 4.2 Navigation

- A fixed **tab bar at the bottom** with six tabs, in this order:
  **Учитель** (AI avatar, the new main page) · **Говорить** · **Слушать** · **Читать** · **Писать** ·
  **Главная** (the course's current main page).
- The four skill tabs open the existing skill pages (`#skill-speak`, …). Главная opens the course
  page of the current track.
- `learn.html` with no hash opens the teacher. The tab bar shows on these top-level pages and hides
  inside exercises, tests and the face-colour page (which have their own back links). It respects
  the iPhone's safe area and the existing glass/backdrop look, in light and dark themes.

### 4.3 The teacher page

- The face, large, at the top: the woman or the man, matching the chosen voice, with the colours
  picked on `#look`.
- A status line that always says what is happening: «Нажми, чтобы начать», «Слушаю…» (with a
  live level meter while she speaks), «Думаю…», «Говорю…».
- Captions: what the teacher is saying (English and Russian styled differently, English bold),
  and what the learner is saying, live as she speaks.
- Lesson cards that appear when useful: a phrase to repeat (English, pronunciation in Russian
  letters, meaning, play button), a correction ("~~I am agree~~ → I agree"), answer buttons
  for quick quizzes (she may tap or say the answer).
- Stars for good answers, counting towards the daily goal and streak; confetti at milestones.
- Lesson modes as chips before starting and at any time: **Урок дня** (the next unit of her
  track), **Болтаем** (free conversation), **Игры**, **Ролевая игра** (café, beauty salon,
  airport, hotel, doctor, shop, date, job interview), **Повторение** (phrases due for review).
- Controls: one big round button (start / pause listening), «Стоп» to interrupt the teacher,
  a keyboard button to type instead of speaking, slower speech toggle.
- Works with no microphone (typing and tapping only), and explains clearly if the microphone is
  blocked.

### 4.4 Realtime voice (the heart of it)

Target: **the teacher starts answering about 1 to 1.5 s after the learner stops speaking**, and stops
talking within ~0.3 s when the learner interrupts.

Pipeline:

1. **Listen**: Deepgram **Flux STT Multilingual** (`wss://api.deepgram.com/v2/listen`,
   `model=flux-general-multi`, `language_hint=en`, `language_hint=ru`, linear16 16 kHz, 80 ms
   chunks), opened from the browser with the short-lived token. Flux detects end of turn
   itself (`StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`). Learners pause
   to think: use a patient `eot_timeout_ms` (about 4 s) and `eot_threshold` about 0.75.
   Fallback if Flux cannot connect: Nova-3 `language=multi` with the app's own end-of-turn timer.
2. **Think**: on `EagerEndOfTurn`, start the Claude request speculatively; on `TurnResumed`,
   abort it; on `EndOfTurn` with the same transcript, keep it (Flux guarantees the transcript
   matches). `POST /api/teacher` streams Claude's answer as plain text, line by line.
3. **Speak**: each complete line is sent to TTS at once and played in order while later lines
   are still being written (pipelining: fetch line n+1 while line n plays).
   - English lines: a native American voice.
   - Russian lines: a native Russian voice, **Deepgram Flux TTS** (`POST /v2/speak`,
     `flux-natalia-ru` / `flux-mikhail-ru`, same API key). If that fails, the phone's own Russian
     voice.
   - The face's lips follow every line, English and Russian (Russian letters map to mouth
     shapes).
4. **Barge-in**: when Flux reports `StartOfTurn` while the teacher is talking, stop the audio,
   drop the queue, abort the stream, and remember what was actually said. Guard against echo:
   ignore "speech" that only repeats the teacher's own recent words (echo cancellation on
   the microphone stays on).
5. **Continuations**: if the learner keeps talking after a turn ended but before the teacher
   started speaking, merge the two and ask again, so a thinking pause never cuts her off.

### 4.5 Teaching design: maximum fun

The teacher's own system prompt (server side) must make her:

- **Ask a question in every turn.** Almost every turn ends with a question or a tiny task she
  can do in one breath. The learner talks more than the teacher.
- **Short turns**: 1 to 3 short sentences (spoken!), never a lecture. One new thing at a time.
- **Bilingual by level**: at A–B mostly Russian with short English bits; C–D half and half;
  E–G mostly English, Russian only to unblock. Each spoken line is in one language, so it is read
  by a native voice. New English is always said in English, slowly, and shown on a card.
- **Vary the activity every few turns**: quick-fire questions, "would you rather", guess the word
  from a description, two truths and a lie, story chain, emoji/riddle cards, find the
  teacher's mistake, role-play scenes, pronunciation challenges (ship/sheep, th, w/v), fast
  translation races, "teach me a Russian word and I'll teach you the English one".
- **Correct like a good tutor**: recast the right version, praise what was right, one short
  Russian explanation only if it helps, then ask her to say it again. Never more than one
  correction per turn.
- **Personal and warm**: use her name once known, remember what she shares (job, hobbies, plans)
  and bring it back later; humour, surprise, small celebrations.
- **Follow the curriculum quietly**: in Урок дня, work through the unit's goal, grammar tip and
  phrases (introduce, repeat, use in a personal question, quiz), and weave in phrases due for
  review. Mark what she has learned.
- **Never get stuck**: if recognition looks garbled, she answers in Russian, or she says
  "не знаю", help with a hint, a choice of answers, or the first word.

### 4.6 Protocol between the model and the app

Plain text, one tagged line at a time, so the app can act on each line while the rest streams:

```
ru: Привет! Я Эмма. Давай познакомимся.
en: What's your name?
card: My name is … | Меня зовут …
choices: Anna | Maria | Olga
star: said a full sentence
fix: I am agree → I agree
mood: happy            (happy | laugh | surprised | thinking | proud | kind)
note: works as a cosmetologist   (a fact to remember about her)
learned: Nice to meet you.       (an English phrase from the course she used correctly)
```

Only `ru:` and `en:` lines are spoken. Unknown or malformed lines are ignored. The learner's
turns are sent as text, with how they came: `[said] …`, `[typed] …`, `[tapped] …`, `[start]`.

### 4.7 Server

- `POST /api/teacher` (`api/teacher.js` → `lib/teacher.js`): validates the conversation (roles,
  sizes), builds the system prompt (static part, cached, plus the learner's context: level,
  mode, current unit, phrases due, notes), streams Claude's text back (`text/plain`, chunked,
  no cache). Low latency over depth: a fast, strong model with extended thinking off
  (`claude-sonnet-5-5`, `thinking: {type: "between_tools"}`, effort `low`), overridable with
  `TEACHER_MODEL` / `TEACHER_EFFORT`. Prompt caching on the system prompt and conversation.
  Handles refusals and errors with a friendly spoken fallback.
- `GET /api/tts?…&lang=ru` (and the teacher's voices): Deepgram Flux TTS batch, MP3, CDN-cached
  like today; English course audio unchanged.
- The same `ACCESS_CODE` rule as the other endpoints. `vercel.json`: a 60 s limit for the
  teacher.

### 4.8 Front-end modules

- `public/teacher-core.js`: pure, testable logic: line protocol parser, spoken-line splitter, echo
  guard, Russian mouth shapes, learner-context builder.
- `public/teacher-asr.js`: Flux client (and Nova-3 fallback): microphone, events, mute, reconnect.
- `public/teacher.js`: the page and the voice loop (states: idle → listening → thinking → speaking).
- `learn.js`: tab bar, default route, hooks into stars, daily goal, progress and pronunciation.
- `avatar.js`: Russian lip-sync, moods (laugh, surprise, thinking), listening pose.

## 5. Constraints

- No framework, no build step; ES modules; works on iPhone Safari first, also Android and desktop.
- The first tap unlocks audio and the microphone (iOS rules). Audio plays through an
  `<audio>` element, so it works with the ring/silent switch on silent.
- Keep the Russian interface consistent with the course (tone, typography, components).
- Keep existing features working: course, exercises, skill pages, face colours, live subtitles
  app at `/`, the published copy.
- Costs stay small: short turns, cached system prompt, history trimmed to the last ~30 messages
  plus the remembered notes.

## 6. Done means

1. Unit tests: protocol parser, echo guard, Russian visemes, request validation, system prompt
   content (level policy, unit phrases, protocol), TTS routing (English vs Russian voice, Flux
   fallback). `npm test` passes.
2. Browser test (Playwright, fake microphone, fake Flux socket, mocked streaming endpoint): opens
   on the teacher, greets in both languages with lip movement, shows a card and choices, a tap
   answers, a spoken answer is sent on `EndOfTurn`, barge-in stops speech, stars count towards
   the daily goal, every tab navigates, light and dark, 390 px wide, no horizontal scroll, no
   console errors.
3. Live checks after deploy: `/api/teacher` streams a real lesson opening in the protocol; Russian
   and English teacher voices return audio; the page loads on the production URL.
4. Committed in stages, pushed, deployed, and verified on the production site; the saved copy of
   the old course is still there.
