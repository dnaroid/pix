---
kind: guide
status: experimental
---

# Local Vosk listener

An opt-in, local development extension for Russian or English speech transcription.
It supports audio files and a confirmed recording from the default microphone.
It does not capture system audio, use cloud recognition, download dependencies,
or listen continuously. This is not a shipped feature or distribution promise.

## Setup

On macOS arm64 with Xcode command-line tools and the matching cached RU/EN
models, install the already-obtained official Vosk 0.3.42 ZIP (checksum-verified;
setup itself downloads nothing):

```sh
node scripts/audio-listener/setup.mjs /path/to/vosk-osx-0.3.42.zip
```

Setup refuses to replace an existing installation. The cached runtime and models
are under `~/Library/Caches/Pix/`; setup requires those models to be present.
For explicit local opt-in, create `.pi/extensions/listener.ts` containing:

```ts
export { default } from "../../scripts/audio-listener/extension.ts";
```

`.pi/extensions` is
gitignored, so this entry must be created separately in each checkout where
the listener is wanted. Restart/reload Pi to discover it.

## Sub-agent role

The project also defines a `listener` sub-agent in `.pi/agents/listener.md`,
described as “Local Vosk transcription with on-demand language model setup.”
Select it with `subagentType: "listener"` for audio-file transcription in the
requested language using local Vosk. At task time, the role discovers available
models and installs a missing official Vosk language model into a reusable user
cache, then loads that selected model and transcribes the audio in the same task;
a download or model-load check alone is not completion. A missing model is the
child's setup work, not a handoff to the parent or user. It does not assume a
fixed installed-language inventory. It preserves the spoken language and can
respond in a separately requested response language.
The role may reuse the native decoder and runner with the selected model when a
convenience wrapper's language allowlist is incompatible, without editing
project source. Project roles are discovered on the next sub-agent spawn, so
adding or editing this role does not require restarting Pi. This role uses
`read` and `bash`; it does not inject or load the listener extension in the
child. These are role instructions; automatic model installation has not been
verified as implemented behavior.

The existing parent `listener` tool and setup remain unchanged and limited to
their currently supported RU/EN models; the role's on-demand model setup does
not extend that tool. Microphone capture remains parent-owned: the parent must
use its interactive `listener` tool and obtain user confirmation, then pass the
resulting transcript to the child. If asked directly to capture microphone audio, the child returns
`NEEDS_PARENT_MICROPHONE`. This role's next-spawn discovery is separate from
extension registration: changes to `.pi/extensions/listener.ts` still require
the extension reload/restart described above.

## Use

The `listener` tool accepts `operation: "status"`, `"file"`, or `"microphone"`.
Transcription requires an explicit requested language (currently only `"ru"`
or `"en"` is supported by the runtime/models) and is limited to
120 seconds. File mode takes a local absolute audio `path`. Supported input is
single-track PCM or AAC-LC audio; other or ambiguous formats fail closed.
Microphone mode records only the default input and asks for confirmation before
recording; check that the selected input is the intended microphone, not a
loopback device. Stop/cancellation discards the recording.

Example tool arguments:

```json
{"operation":"status"}
```
```json
{"operation":"file","language":"ru","path":"/absolute/path/speech.wav"}
```
```json
{"operation":"microphone","language":"en","seconds":30}
```

Audio stays local and normal completion, error, and abort/session-switch cleanup
remove the recording. On session shutdown, cleanup is best-effort and bounded to
3 seconds; if it times out, a warning is logged. A parent-process kill or crash
may leave private scratch audio under `.pi/artifacts/` and a helper running until
its native duration/watchdog limit. There is no stale-audio sweeping.
Returned transcript text enters the chat and may be sent to the chat's LLM.
No real microphone/UI test is documented as completed; this guide does not imply
real-device validation.

## Local verification

The final focused suite passed 25/25, including fake-child shutdown draining
and SDK auto-discovery in an isolated project; strict TypeScript checking passed.
The unchanged native consent/lifetime suite remains 36/36. Evidence:
`.pi/artifacts/listener-shutdown-fixed-m21Xpr/tests.log`,
`.pi/artifacts/listener-shutdown-LbVF97/types.log`, and
`.pi/artifacts/listener-final-checks-ieBhX3/native.log`. No real microphone
capture was run. The bounded shutdown cleanup finding was resolved by the
shutdown-drain regression; these checks do not establish real-device behavior.

See the [feasibility experiment](audio-listener-experiment.md) for preserved
historical evidence and deferred release considerations.
