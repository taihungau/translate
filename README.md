# Subtitle Translator (EN → RU)

A small web app that translates English movie subtitles into Russian in real time, using Claude.

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

## Translation engines

Pick the engine at the top of the page:

- **Chrome built-in (default, free).** Desktop Chrome 138 or later has an on-device
  translator. No API key or server is needed, and the first use downloads Chrome's Russian
  language pack. Translation is literal and doesn't use earlier lines for context.
- **On-device model (free, works on phones).** Opus-MT English→Russian running in the browser
  with transformers.js, used automatically where Chrome's translator is missing (phones, Safari,
  Firefox). The first use downloads about 80 MB, then it is cached.
- **Claude.** More natural, context-aware subtitles. It needs `ANTHROPIC_API_KEY` set on the
  server, and is the only option in browsers without the built-in translator (Safari, Firefox,
  and Chrome on phones).

## Speech recognition (live mode)

Also chosen on the page, and free either way:

- **Chrome (default).** The browser's own recognizer, which sends audio to Google. Fast, but it
  struggles with music, effects and echo.
- **On device: Moonshine Tiny/Base, Whisper Tiny/Base/Small, Distil-Whisper Small, Whisper
  Large v3 Turbo.** Open models that run in the
  browser with [transformers.js](https://github.com/huggingface/transformers.js), on the GPU
  (WebGPU) when available. They usually cope better with film sound. The first use downloads
  the model (tens of MB for Tiny, about 1 GB for Large Turbo), then it is cached. All audio is
  transcribed (nothing is dropped by a loudness gate); it is cut into 2.5–6 s chunks at pauses,
  or at the quietest moment during continuous music, with partial results every 0.6 s.
  Distil-Whisper Small is a good balance; Large Turbo is the most accurate but needs a powerful
  GPU, and on a computer or phone without WebGPU stick to the Tiny models.

The microphone is opened without call-style echo cancellation and noise suppression (which
remove film dialogue), with a selectable boost (default 3×) followed by a compressor so quiet
dialogue is lifted without loud effects clipping. The computer's own microphone (for example
"MacBook Pro Microphone") is preferred over the system default, and the choice is remembered.

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
| `PORT`              | `3000`            | HTTP port                                                   |

Set `ACCESS_CODE` to require a code before anyone can translate (recommended on a public URL).
The page asks for it once and remembers it in that browser.

## Deploy on Vercel

The repo is ready for Vercel: `public/` is served as static files and `api/translate.js` runs
as a serverless function (`local/server.js` is only for running locally).

1. Push the repo to GitHub, then in Vercel choose **Add New… → Project** and import it.
   Leave the framework preset as **Other**; `vercel.json` sets everything else.
2. Under **Settings → Environment Variables**, add `ANTHROPIC_API_KEY`, and `ACCESS_CODE` so
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
{ "lines": [{ "id": "1", "text": "Wait up!" }], "context": ["earlier English line"] }
```

returns

```json
{ "translations": [{ "id": "1", "text": "Подожди!" }] }
```

Each request accepts up to 60 lines. Lines the model fails to return are left out of the
response, and the client retries them.

## Development

```bash
npm test
```

The tests cover the SRT/VTT parser and the translator, using a mocked Claude client.
`samples/sample.en.srt` is a short subtitle file for trying out the video mode.
