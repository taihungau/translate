# Subtitle Translator (EN → RU)

A small web app that translates English movie subtitles into Russian in real time, using Claude.

It has two modes:

- **Live (microphone).** Press Start, allow the microphone and play the movie out loud. The
  browser transcribes the English it hears, and each phrase is shown in large Russian text a
  moment after it is spoken, then fades like a real subtitle. Fullscreen fills the screen with
  the subtitle panel; English can be shown underneath if you want it. Each phrase is sent with
  the previous few lines so the translation keeps context (who is "you", ты vs вы, running jokes).
- **Video + subtitle file.** Load a local video and its English `.srt` or `.vtt` file. Translation
  begins at the playhead and runs ahead of it in parallel batches, so you can press play almost
  right away. Seeking moves the translation to the new position. Russian subtitles (or Russian
  + English) are drawn over the video, including in fullscreen. You can download the result as
  a Russian `.srt` file at any time.

## Run it

Requires Node.js 18 or later and an Anthropic API key.

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
