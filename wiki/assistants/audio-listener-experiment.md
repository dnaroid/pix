---
kind: guide
status: experimental
---

# Audio listener feasibility experiment and history

## Status and boundary

The current local Vosk MVP is documented in the [Local Vosk listener guide](local-vosk-listener.md).
It is an explicitly installed, gitignored local development extension, not a
shipped product feature. This page preserves the earlier feasibility evidence
and release investigations; those observations are historical and do not
describe the current MVP's source or supported workflow. Existing
[Deepgram dictation](deepgram-voice-input.md) is unchanged. The phase-one
release gate remains **No-Go**. Earlier oracle clearance applies
only to the prior system-only probe, not the later duration/lifecycle changes.
The prior 39-test capture-lifetime revision was independently reviewed through
`zai/glm-5.3`. Its low-priority publication-lock risk (a stuck file move can block
the watchdog) and post-commit JSON-output failure caveat remain unchanged. The
later F1 permission-wait fix below has not been independently re-reviewed.

The suite contract accepts capability, start, status, stop and cancel requests;
explicit BCP-47 language is required. Consent, credentials, session ownership and model URLs
are not agent-controlled inputs. The pure engine policy prefers configured
Deepgram, then usable Apple Speech (requiring explicit host consent if not
on-device), then an exact-language small Vosk model. Cancellation does not
fallback. These are planned policy/contract semantics, not a runnable product
pipeline.

Each job selects exactly one source: file, general system audio, or default
microphone input; sources are not mixed. Capture defaults to 30 seconds and is
capped at 120 seconds.

## Phase-one evidence (2026-11-05)

- Suite contract/policy tests: 53 passed; suite typecheck passed.
- Native no-capture tests: 35 passed (16 probe/consent/lifetime, 6 microphone
  completion-latch, 13 system-audio media-bound checks including suite parents).
  Native helper builds for arm64 macOS 13.5;
  execution was on macOS 14.8.7 arm64, not the minimum supported OS.
- Speech capability inspection on that Mac reported RU/EN supported and
  available, `onDevice=false`, authorization `notDetermined`. Inspection did
  not request Speech permission or perform recognition.
- Vosk 0.3.42 native arm64 feasibility probe recognized generated RU/EN TTS
  fixtures exactly with word timestamps while network access was denied; silence
  and SIGTERM checks passed. Observed maximum RSS was 213123072 bytes (RU) and
  172670976 bytes (EN). This is not accuracy evidence for real games, noise or
  natural speech.
- The cached official Vosk 0.3.42 ZIP SHA-256 matches
  `scripts/audio-listener-probe/vosk-artifacts.json`; its extracted dylib matches
  the ZIP entry byte-for-byte and contains arm64+x86_64. Fresh offline tests
  against this official runtime passed 6/6 with 0 skipped on macOS 14.8.7 while
  network access was denied. Evidence: `.pi/artifacts/listener-official-reuse-eebPhQ/`
  (`runtime-verification.json`, `vosk-tests.log`). No repeat download, capture,
  key access or cloud STT occurred. This verifies reuse/functionality on this
  host, not release packaging or target-OS support.
- Models are cached outside disposable project artifacts at
  `~/Library/Caches/Pix/listener-feasibility/vosk`; observed pins/provenance are
  recorded in the probe manifest. The downloaded runtime/probe remains in the
  temporary evidence directory. This is not a product-safe downloader/cache.
- A user directly ran the existing native-v5 probe twice with typed consent.
  The first capture was confirmed silent by the user (no sound was playing).
  The second captured Russian speech: `system.m4a` decoded to PCM with duration
  10.639625 s, peak 21059, RMS 4283.679965, and 169916 nonzero of 170234 samples.
  Native `vosk-probe-v2` with small RU 0.22, under `sandbox-exec` denying
  `network*`, produced 33 words with native timings. Transcript text is omitted;
  accuracy was not measured against a reference. The requested capture was 10 s,
  so the 10.639625 s decoded duration leaves precise capture duration unresolved.
- This demonstrates user-operated capture → decode → local Vosk on macOS 14.8.7
  arm64, not behavior on macOS 13.5 or a general platform/STT matrix. The capture
  command requires an interactive terminal and typed `RECORD SYSTEM AUDIO`; it
  captures the general system mix (including other apps/notifications), no
  microphone, and writes no video file. Internal unused ScreenCaptureKit frames
  are minimized to 2x2 at 1 fps. The user must run it directly; an agent/harness
  must not bypass confirmation with a pseudo-terminal. This is not a product
  consent boundary. Signals cancel; a second signal or deadline hard-stops and
  unlinks the private partial.
- The new microphone path is development-only and has **not** been used for a
  recording or permission request. Its command requires an interactive TTY and
  typed `RECORD MICROPHONE` before OS access, records only the default macOS
  input as PCM CAF, and has a native duration limit plus fail-closed duration
  validation before publishing. The watchdog/cancel path prevents publication
  of a cancelled or incomplete capture. `inspect` reads microphone authorization
  status only; it does not request access. The default input can be a virtual
  device: users must verify the selected input themselves. Real recording,
  device disconnect, and input route changes remain unverified. No system audio
  capture stream or video output is opened by this microphone command; actual
  audio content depends on the selected input device.
  The process watchdog allows the requested duration plus 15 seconds for setup
  and teardown (up to 135 seconds); it is not a precise recording-duration timer.
  Permission waiting is outside that recording watchdog: cancellation ends the
  local wait without waiting for the OS reply, while the OS dialog itself cannot
  be dismissed. Late or duplicate permission replies cannot start capture. Once
  permission is granted, the watchdog is armed under the capture lifetime's
  terminal-state lock before device/recorder setup; cancellation during the
  unarmed wait arms a 15-second hard escape if cooperative cleanup stalls.
  The F1 change builds for arm64/macOS 13.5 and its nine no-device Node tests
  passed, with two consecutive full focused runs at 48 passed, 0 skipped each,
  on macOS 14.8.7. Evidence: `.pi/artifacts/listener-permission-fixed-mJDTGB/`
  and `.pi/artifacts/listener-permission-verify-bUF0D7/`. No permission request
  or real capture occurred. Earlier AAC converter, AudioMix and varispeed
  experiments failed and were not retained; the trace probe timed out and is
  incomplete. These remain historical, not the current decoder state. The
  development-only decoder derives a fail-closed duration reference from
  AVAudioFile length validated against packet metadata: LPCM requires one frame
  per packet and matching packet count; AAC-LC requires 1024 frames per packet,
  matching valid-frame count, nonnegative priming/remainder and overflow-safe
  packet accounting. Accepted metadata covers whole rates 8–192 kHz,
  1–8 channels and durations up to 120 s, with one contiguous unit-rate audio
  segment. Timeline cross-check allows AAC priming and is not the expected
  output reference. There is no fallback for MP3, HE-AAC, ADTS without a valid
  packet table, or edited/ambiguous/inconsistent metadata. The container's
  existing 120 s safety cap remains. Format eligibility does not guarantee a
  successful decode: valid media can exhaust all three attempts.

  Each attempt uses a fresh AVAssetReader and unique mode-0600 partial. Published
  duration must be at least reference minus 1 ms. The upper bound allows only
  output-frame rounding: ceil(exact reference frames × 16,000 / source rate),
  strictly less than one output frame (62.5 μs) above the reference. Retry
  (maximum three attempts) occurs only for a significant deficit;
  there is no padding or concatenation. Exhausted, invalid or cancelled decode
  publishes nothing and cleans partials. Size/mtime/inode checks are best-effort
  stable-source detection, not a hostile-input snapshot guarantee. Diagnostic
  stderr uses fixed fields without paths. Native build passed and focused Node
  tests passed twice at 105/105 on macOS 14.8.7 arm64 (target macOS 13.5),
  including fractional-frame coverage:
  `.pi/artifacts/listener-decode-rounded-verify-tBGVej/tests-1.log` and
  `tests-2.log`; native build:
  `.pi/artifacts/listener-decode-rounding-Frgy2y/build.log`. Tests cover real
  fractional PCM 48/44.1 kHz, stereo PCM 96 kHz, AAC 48/44.1 kHz and stereo AAC
  48 kHz, plus deterministic ceiling, one-extra-frame rejection and lower
  boundary. Synthetic 96 kHz AAC generation was rejected by ExtAudioFileWrite
  (-50), so it is not claimed verified. Earlier 95-test evidence belongs to
  the prior strict-upper-bound revision.
  The final rounded-revision stress run (400×1 s and 20×120 s) covered
  420 cases: 418 successful
  decodes and 2 safely exhausted with no output; zero unsafe outputs or partial
  leaks. All 400 one-second cases succeeded (16 retried, max 2 deficits); at
  120 seconds, 18/20 succeeded and 2 exhausted after three attempts (11
  retried, max 3 deficits). Successful output sizes were 31,988/32,000 bytes
  (1 s) and 3,839,988 bytes (120 s). This confirms the safety invariant, not
  420 successful decodes or a decoder fix; the native shortfall persists and
  retry independence is unproven. Evidence:
  `.pi/artifacts/listener-decode-rounded-stress-yekjzX/results.json` and
  `stress.log`. The earlier strict-upper-bound stress result is superseded.
  Mutation checks restoring the strict upper bound and disabling the lower
  bound were each caught by regressions (mutant exit 1):
  `.pi/artifacts/listener-decode-rounded-mutation-BF5VyL/exhaust.log` and
  `rounding-up.log`. A separate 8 kHz
  120-second WAV probe repeatedly yielded 1,919,968/1,920,000 frames and was
  safely rejected at a 2 ms deficit; exact-120-second PCM success regression
  uses 16 kHz, and the original 8 kHz 1-second test is unchanged. No universal
  8–192 kHz decode-success claim. Deterministic tests cover exhaustion, later
  attempt success, cleanup/private partials, cancellation, overwrite race,
  invalid edits/table overflow and 3-second video with 1-second audio; remuxed
  inconsistent AAC metadata, ADTS and HE-AAC fail closed. Evidence:
  `.pi/artifacts/listener-decode-format-gate-a0BVUN/results.json`, and
  `.pi/artifacts/listener-decode-mutation-CrsDKy/red.log` (deficit-gate mutation
  caught by exhaustion regression). A temporary early-watchdog mutation failed
  the delayed-grant regression as expected
  (`.pi/artifacts/listener-permission-mutation-AuAF8e/red.log`). The F1 permission
  change has not received independent re-review; its prior review covered the
  earlier 39-test revision only. The decoder duration guard received a separate
  bounded oracle review; its fractional-frame rounding blocker was fixed and
  the resolution confirmed by code review, not another independent test run.
- The system-audio probe bounds published media to the requested duration. The
  first valid 48 kHz stereo PCM timestamp anchors the media window; boundary
  buffers are clipped to whole frames and later buffers are ignored. Invalid
  formats and non-monotonic timestamps fail closed. Writer finalization uses
  the last retained frame, and late callbacks cannot reopen it. Before publish,
  both asset and decoded-frame durations are validated against the request.
  Existing wall-clock sleep/stop and watchdog behavior is unchanged: this
  output-media bound does not establish precise device capture stop timing.
- Capture lifetime teardown is idempotent and terminal: `close()` marks the
  owner closed before cancelling its timer/signal sources and owned task;
  closed owners reject start/publication, and late cancel/deadline callbacks
  cannot terminate the process. Deterministic no-capture regressions cover
  close with late callbacks, before start/publication, and while work is
  running. Fresh arm64/macOS 13.5-target build and all 39 no-capture tests
  passed on macOS 14.8.7 (0 skipped); evidence:
  `.pi/artifacts/listener-close-fixed-K4xkKw/`. No real capture or permission
  request occurred. This revision was subsequently independently reviewed;
  real-device lifecycle checks remain open, and the later F1 fix has not been
  independently re-reviewed.
- No audio upload, Deepgram key read, or Apple recognition/permission request
  occurred. Scratch evidence under `.pi/artifacts/audio-listener-phase1-20261105-1104/`
  is temporary and may be cleaned.

## Vosk redistribution evidence (2026-11-05)

The cached `vosk-osx-0.3.42.zip` contains only a directory, `libvosk.dylib`,
and `vosk_api.h`; it has no LICENSE, COPYING, or NOTICE file. The cached
`vosk-model-small-ru-0.22` and `vosk-model-small-en-us-0.15` archives each
contain a README but no license/copying/notice-named file. The RU README gives
description/WER information; the EN README includes “Copyright 2020 Alpha
Cephei Inc” and description/accuracy/speed/latency information.

The upstream runtime's [COPYING file for v0.3.42](https://raw.githubusercontent.com/alphacep/vosk-api/v0.3.42/COPYING)
contains Apache License 2.0. The [Vosk model catalog](https://alphacephei.com/vosk/models)
lists these exact RU and EN model versions as Apache 2.0. These upstream
declarations are evidence, not license files included in the cached packages
or legal clearance for redistribution. Any redistribution must include the
license text and retain applicable notices. Provenance and licenses/notices
for statically incorporated dependencies still need assessment. Inspection of
the upstream v0.3.42 source at commit
[`b1b216d4c87d708935f1601287fe502aa11ee4a9`](https://github.com/alphacep/vosk-api/tree/b1b216d4c87d708935f1601287fe502aa11ee4a9)
adds evidence of this gap: [`recognizer.cc`](https://github.com/alphacep/vosk-api/blob/b1b216d4c87d708935f1601287fe502aa11ee4a9/src/recognizer.cc#L16)
includes [`json.h`](https://github.com/alphacep/vosk-api/blob/b1b216d4c87d708935f1601287fe502aa11ee4a9/src/json.h),
whose header credits nbsdx/SimpleJSON and says “Do what the fuck you want
public license.” This header text alone does not establish the exact license
version. The [`Makefile`](https://github.com/alphacep/vosk-api/blob/b1b216d4c87d708935f1601287fe502aa11ee4a9/src/Makefile)
defaults to `USE_SHARED=0`, listing Kaldi and OpenFST static archives and,
conditionally, OpenBLAS/CLAPACK archives; it also offers shared-library and
Accelerate alternatives. These are source build options, not proof of the
composition or dependency versions of the exact macOS release binary. The
inspected tree and Travis configuration likewise do not establish pinned
macOS release-build provenance. The top-level Apache license therefore is
not a complete component/license inventory. Before redistribution, obtain
exact build inputs and notices from upstream, or make a controlled pinned
source build and validate its distribution contents. The observed `otool`
dylib dependencies do not establish the absence of statically incorporated
components. The manifest's SHA-256 pins are observed official-download hashes,
not upstream signatures. Signed packaging, complete dependency review, and
independent review remain gates; phase one remains **No-Go**.

### SimpleJSON provenance follow-up (deferred source-build investigation)

Pinned-source comparison establishes the origin of Vosk `src/json.h`: the
initial import at `41446c980cbcdfa1e122788f2cd79056fade6346`, after removing
its six added attribution lines, is byte-identical to `nbsdx/SimpleJSON`
`json.hpp` at commit
[`b3a4ba66a16b50468b2cbc3cd384b57c0331d5a1`](https://github.com/nbsdx/SimpleJSON/tree/b3a4ba66a16b50468b2cbc3cd384b57c0331d5a1).
Changes from import to pinned Vosk are recorded in `vosk-initial-to-pinned.patch`.
The pinned upstream README says only “Do what the fuck you want public
license”; the complete pinned tree has no separate license file, and observed
upstream head has the same declaration. Exact version and full terms remain
unestablished. This is not clearance; do not assign SPDX `WTFPL-2.0`. Evidence
(downloads, trees, history and patches) is temporary under
`.pi/artifacts/listener-simplejson-f4ek2ly6/`. The user has since selected
reuse of the ready official Vosk runtime instead of continuing source-build
investigation. Upstream clarification or dependency replacement is deferred,
not an active blocker for the prototype; this evidence remains relevant to any
future source-build or release inventory. No-Go and all other release gates
remain.

An incremental inventory pass relinked the existing pinned archive objects
into a separate `libvosk-inventory.dylib` with a linker map; the original
dylib and source were unchanged. The map lists 117 archive objects (107 Kaldi,
10 OpenFST). `kaldi-io.o` includes `basic_filebuf` symbols from the pinned
modified libc++ header, which carries MIT OR Illinois/NCSA licensing and
embedded notice/credits; `srfft.o` is loaded with the source's Malvar permission
notice under Apache 2.0. SimpleJSON symbols are loaded, but the exact license
version remains unestablished. No Mikolov object appears in this map, so its
BSD-3-Clause notice is retained only as a source-scope candidate, not claimed
as loaded code. This is a partial header/license inventory, not complete
clearance. Offline tests against the separate relink passed 6/6 with 0 skipped
on macOS 14.8.7; network was denied. Candidate notice copies and hashes are
scratch evidence, not a durable/final distribution notice bundle. Evidence:
`.pi/artifacts/listener-license-inventory-tooistb9/` (`inventory.json`,
`link-command.json`, `link-map.txt`, `objects.txt`, `vosk-tests.log`,
`candidate-notices/`). No capture, cloud service, key access, or product source
change occurred. Complete inventory, exact SimpleJSON license provenance,
final notice/package contents, signing and target-OS validation remain open;
phase one remains **No-Go**.

## Controlled source-build investigation (historical; deferred)

The earlier investigation selected a controlled pinned source build rather than
relying on provenance claims for the upstream release binary. The user has
since changed direction to reuse the ready official Vosk runtime; this source
build is historical and deferred, not the active prototype path. Candidate inputs
are Vosk v0.3.42 at [`b1b216d4c87d708935f1601287fe502aa11ee4a9`](https://github.com/alphacep/vosk-api/tree/b1b216d4c87d708935f1601287fe502aa11ee4a9),
the `alphacep/kaldi` Vosk branch at [`bc5baf14231660bd50b7d05788865b4ac6c34481`](https://github.com/alphacep/kaldi/tree/bc5baf14231660bd50b7d05788865b4ac6c34481)
(2024-08-23), and `alphacep/openfst` at [`7dfd808194105162f20084bb4d8e4ee4b65266d5`](https://github.com/alphacep/openfst/tree/7dfd808194105162f20084bb4d8e4ee4b65266d5)
(declares 1.8.0). This pinned combination has now completed a controlled
source build and offline feasibility tests; this does not establish
reproducibility or clearance to redistribute it.

The investigation host is arm64 macOS 14.8.7 with Apple clang 16 and SDK 15.
A C++17 CBLAS `cblas_sdot` smoke build targeted macOS 13.5, ran with the
expected result, and recorded `LC_BUILD_VERSION` minimum 13.5. It emitted a
legacy CBLAS deprecation warning; this does not validate Kaldi's full math
pipeline or execution on 13.5. OpenFST was bootstrapped with private Automake
1.16.5 and existing Autoconf 2.72/glibtoolize 2.5.4; its static build/install
and weighted-FST roundtrip smoke passed. Kaldi's static Accelerate build
(`online2`, `lm`, `rnnlm`) and `matrix-lib-test` passed. Vosk's five translation
units and dylib then built with `USE_SHARED=0`,
`HAVE_OPENBLAS_CLAPACK=0`, `HAVE_ACCELERATE=1`, explicit arm64/macOS 13.5
deployment target and SDK sysroot, using the legacy ABI. The dylib is arm64,
records minos 13.5/SDK 15, and has dynamic dependencies only on Accelerate,
libc++, and libSystem. A fresh native probe compiled against the pinned source
header and dynamically loaded this library; the
existing offline Vosk suite passed 6 tests (RU/EN synthesized speech with
timestamps, silence, and SIGTERM cancellation; sandbox denied network).
Separate network-denied resource runs against this dylib observed RU 1.06 s /
207,519,744-byte maximum RSS and EN 1.03 s / 176,603,136-byte maximum RSS.
These are single-run observations, not benchmarks. Execution was on macOS
14.8.7, not 13.5. The CBLAS deprecation warning and
upstream unused SSE-flag warnings were non-fatal; do not silently switch to a
new ILP64 ABI. These results establish a successful pinned build and bounded
feasibility, not release reproducibility, target-OS runtime validation, or
redistribution clearance.

Archive hashes were recorded and extracted files compared with archive baselines; only six
OpenFST autotools-generated files changed, recorded in
`openfst-autoreconf.patch`; Kaldi/Vosk extracted files were unchanged. A full
Vosk archive extraction was rejected because an unrelated training symlink
escapes its root; only `src/` and `COPYING` were extracted, retaining the full
archive. Evidence and build logs are temporary under
`.pi/artifacts/listener-bootstrap-hmRACc/`. Complete component/notice inventory
and controlled packaging are follow-up only if source build resumes. The
official runtime still requires release notices/provenance review, signing and
platform-matrix validation before distribution. No capture,
cloud service, or credentials were used. Earlier native 35 and suite 53 test
counts are historical and unchanged; this stage adds the 6 Vosk tests against
the newly built library. Independent microphone/duration review and real-device
testing remain open; phase one remains **No-Go**.

## Reproduce focused checks

From the repository root, on macOS with Xcode command-line tools:

```sh
bun test --isolate external/pi-tools-suite/test/audio-listener-contract.test.ts
npm --prefix external/pi-tools-suite run typecheck
run_dir=".pi/artifacts/audio-listener-manual-$(date +%Y%m%d-%H%M%S)"
bash scripts/audio-listener-probe/build.sh "$run_dir"
LISTENER_PROBE_BIN="$PWD/$run_dir/listener-probe" node --test \
  scripts/audio-listener-probe/probe.test.mjs \
  scripts/audio-listener-probe/lifetime.test.mjs \
  scripts/audio-listener-probe/completion.test.mjs
node --test scripts/audio-listener-probe/audio-sink.test.mjs
```

The audio-sink tests synthesize PCM without opening a capture stream or
requesting permissions. They verify the output-media bound, not real-device
capture timing. Decoder output may be up to 1 ms shorter than its validated
reference; significant deficits retry, but valid formats may exhaust retries.

The build creates its output directory and refuses to overwrite an existing
probe. These tests do not
record audio or request OS permissions. `listener-probe inspect` only prints a
capability snapshot. Capture is a distinct, consent-gated manual action:

```sh
"$run_dir/listener-probe" capture --acknowledge-general-system-audio 10 "$run_dir/system.m4a"
```

The distinct microphone action (not run as part of automated checks) is:

```sh
"$run_dir/listener-probe" microphone --acknowledge-microphone 10 "$run_dir/microphone.caf"
```

It prompts for the exact typed confirmation before requesting microphone
permission. Do not run it without the user's deliberate action, and check that
the system's default input is the intended microphone rather than a virtual
loopback device.

For the Vosk suite, build the native `vosk-probe` against the verified archive
header and provide `VOSK_PROBE_BIN`, `VOSK_LIBRARY`, `VOSK_MODEL_ROOT`, and
`LISTENER_FIXTURE_DIR` to `node --test scripts/audio-listener-probe/vosk.test.mjs`.
It runs under macOS `sandbox-exec` with network denied. Exact cached inputs and
pins are in `scripts/audio-listener-probe/vosk-artifacts.json`; this procedure
is a development feasibility test, not a supported installation workflow.

## Remaining gates

Before considering product integration, verify behavior on macOS 13.5 and the
current platform, establish signed release packaging plus runtime/model license
and provenance verification, and resolve precise recording-duration behavior.
Also assess real-world RU/EN accuracy and resource use; synthetic TTS and this
unreferenced capture do not establish it. No product downloader, model cache,
runtime distribution, or permission UX is implemented. Keep this experiment
separate from shipped capability until those gates and independent review are
resolved.
