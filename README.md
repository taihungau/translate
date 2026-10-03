# Subtitle Translator (EN → RU)

A small web app that translates English movie subtitles into Russian in real time, using Claude.

It has two modes:

- **Live (microphone).** Play the movie out loud. The browser transcribes the English speech,
  and each phrase is translated into Russian as soon as the speaker finishes it. The Russian
  line is shown in a large subtitle panel that can go fullscreen, with a scrolling transcript
  below it. Each phrase is sent with the previous few lines so the translation keeps context
  (who is "you", ты vs вы, running jokes).
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
