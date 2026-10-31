# 0062 — Accessibility-gated macOS dictation-key interception

- Status: accepted
- Recorded: 2026-10-07
- Decided: 2026-10-07
- Owner / approval evidence: user requested the actual microphone-position F5
  key, accepted Accessibility permission in this task conversation, and required
  system dictation to remain available when Pix dictation is not configured.
- Governing spec: [Deepgram voice input](../assistants/deepgram-voice-input.md)
- Replaces / replaced by: none

## Context

macOS handles the microphone key as a system dictation action even when a Pix
text field has focus. The requested shortcut must activate Pix voice input in
the foreground Pix window, without replacing system dictation in other apps or
when no Desktop Deepgram credential is configured.

## Observations and sources

- User-reported observation: macOS dictation takes the key while an input field
  is focused. This is conversation evidence, not a retained native capture.
- AppKit local event monitors run after the system's early key routing and do
  not provide reliable suppression of the hardware dictation action.
- Core Graphics provides HID head-insert filtering event taps; the installed
  `core-graphics` API can drop events and release its callback/port on teardown.
  Filtering keyboard taps require macOS trust; Pix checks and prompts using
  `AXIsProcessTrustedWithOptions`.
- [Karabiner microphone-key work](https://github.com/pqrs-org/Karabiner-Elements/pull/3913)
  identifies microphone-position F5; the Carbon virtual F5 key is `0x60`.
- Native probe (2026-10-21, user's Apple keyboard): the microphone-position
  F5 key without Fn reaches the HID tap as ordinary KeyDown/KeyUp with virtual
  keycode `0xB0` (flags only `NX_SECONDARYFNMASK`), not `0x60` and not a
  `systemDefined` payload. Pix accepts both `0x60` (Fn+F5 / function-key mode)
  and `0xB0`.

## Decision

Use a narrow Core Graphics HID event tap only for configured Desktop dictation
and registered eligible Pix composers. Route the accepted F5 press only to the
active key Pix window. Suppress the accepted down/up pair and repeats; other
keys, modifiers and other apps pass through. Keep secrets and credential
presence resolution native, with blocking config I/O outside the event callback.

Do not request Accessibility or install a tap without a Desktop credential.
Permission denial leaves system dictation and the on-screen Pix microphone
available. Window teardown, configuration removal and exit release native
resources. External config edits refresh on the next Pix activation.

## Alternatives

- WebView keydown or AppKit local monitor: lower permission cost, but insufficient
  to reliably override the actual system microphone action in a focused input.
- Leave the hardware key to macOS and use an ordinary shortcut: avoids broader
  trust but does not satisfy the user's selected hardware-key behavior.

## Consequences

Accessibility grants broader process trust than this narrowly scoped feature
uses. Pix must neither log unrelated keystrokes nor expose the credential to JS.
Only key presence is checked; an invalid configured key can still intercept F5
and then produce a normal Deepgram error. A HID tap observes F5 (`0x60`) and the dedicated microphone key (`0xB0`) at the
virtual-key level; other keyboards may use other codes.
The event callback must remain short to avoid macOS disabling the tap.

## Revisit when

Native QA shows the physical key bypasses HID F5 on a supported macOS/keyboard,
permission cannot reliably enable the tap, or a narrower supported API becomes
available. Revisit key identity filtering if ordinary function-key use conflicts
with this shortcut.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"fd67fac9f43298c47c001d2845bfbe47aac8e701fb76ff46b4be4be146290109","checkedAt":"2026-10-30T23:35:08.014Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":63,"reportLanguage":"ru"} -->
