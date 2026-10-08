---
kind: spec
status: active
---

# Isolated Desktop QA from watch builds

## Behavior

Ordinary macOS native UI QA runs a separate instance of the latest successful
`watch:all` native artifact. The working Desktop and its active agents remain
running, even when that process uses an older build. QA never requests its
Restart control and never starts a second watcher as a freshness workaround.

`npm run qa:desktop -- prepare` verifies a live watcher by exact owner PID,
command and canonical checkout working directory. Legacy PID-only owner markers
are supported. Multiple matching watchers require an explicit `--state` path.
Preparation waits for idle successful state; queued/building states wait within
the deadline, and failed state rejects even if an older target is still present.
The default deadline is 120 seconds; `--timeout-ms` accepts 100..300000.

An automatic discovery limit is not evidence that the watcher is absent.
QA recovery inspects direct `pix-watch-all-*` children of the canonical Node
system temp root (on macOS, not necessarily `/tmp`), identifies the exact live
owner for the checkout, and retries with `--state`. It does not raise safety
limits, recursively scan temporary files, or start another watcher. First-run
onboarding in the disposable QA profile is ordinary setup: QA may continue
through the enabled Continue action and skip optional integrations without
asking the user to prepare the instance.

Preparation copies the published `.app`, not mutable Cargo output, into a new
private run under `.pi/subagents/`. An explicit new `--run-dir` may be inside
`.pi/subagents/` or `.pi/artifacts/` in the checkout. It rereads watcher state
after copying and retries publication/pruning races without deleting or pinning
anything in the watcher's own directory. The result includes `manifestPath`.
Every run gets its own profile UUID, HOME and disposable workspace.

The unified UI-QA runner launches the project script directly:

```json
{
  "target": {
    "application": {
      "launch": {
        "argv": [
          "node", "scripts/qa-desktop.mjs", "launch",
          "--manifest", "<absolute manifestPath>"
        ],
        "cwd": "."
      }
    }
  }
}
```

This is a target fragment; real flows still require backend probing, content
readiness, deterministic UI assertions and evidence. The launcher directly
spawns the pinned `.app` inner executable in its runner-owned process group;
there is no LaunchServices `open` handoff, detached GUI, or name-based attach.
Human invocation is `npm run qa:desktop -- launch --manifest <manifestPath>`.

## Profile and lifecycle

Isolation activates only for `PI_UI_QA=1` with `PI_UI_QA_PROFILE_DIR`. Explicit
invalid profiles fail before Tauri storage/plugins/windows initialize. The
launcher supplies private HOME, PI_CODING_AGENT_DIR, PI_CONFIG_DIR and XDG paths,
and does not forward ambient runtime, watcher, provider-home or credential
overrides. Normal launches and legacy QA without a profile keep their behavior.

The native application uses a UUID-derived runtime application identifier and
nonpersistent/incognito WebViews for every created window. Window membership and
geometry storage resolve in its private application profile. ACP inherits the
private agent/config paths: test sessions, drafts, queues and history do not
share the working user's agent store. The test workspace is separate from the
source checkout. This is state isolation, not a general OS sandbox.

Before spawning, the launcher requires an embedded versioned isolation-capability
marker, so a pre-isolation binary cannot open the working WebView store even
briefly. On setup the native process atomically writes private `runtime.json`
with contract, actual PID/executable/profile and unique application identifier.
The launcher verifies these against the pinned manifest, retains the verified
credential-free `identity.json` beside it for post-run inspection, and reports
`QA isolation verified`. Stale identity is cleared before every launch. Neither
marker is a source hash or proof that every
source edit was included; the build-completion assumption is unchanged.

One prepared profile may have only one launch at a time. A surviving/crashed
owner lock is not automatically stolen; prepare a new run. Cleanup is restricted
to the owned QA process. QA-only SIGINT/SIGTERM/SIGHUP listeners request Tauri's
normal exit worker, allowing it to save state and stop its separately grouped
ACP/terminal children even when the runner signals the whole owned group.
Only that isolated infrastructure cancellation can bypass active-work
confirmation; working-app Quit/Restart and ordinary QA UI actions retain it.
Listener tasks are cancelled on teardown and the live runtime marker is removed.
The runner still has a bounded forced-cleanup deadline; a forced termination is
not evidence of successful persistence or complete graceful cleanup.

## Persistent helper and permission setup

The UI automation helper is infrastructure, not a QA artifact. Source/development
runs share the permanent per-OS-user installation at
`~/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility`. Neither
Registry Clean nor project scratch TTL cleanup reaches it. The path uses the
OS-account home, not the isolated app's temporary HOME. Release runs preserve
their signed-payload helper precedence. See `specs/ui-qa-agent.md` for signing,
migration, locking and release selection details.

`npm run qa:desktop -- doctor` prepares/verifies that same helper and reports its
exact path and current Accessibility/Screen Recording grants, without a watcher,
QA profile or Desktop launch. `doctor --prompt` is an explicit parent/user action
requesting the native permission dialogs; ordinary probes never prompt. It does
not approve anything, reset TCC or manipulate System Settings. The user enables
the exact helper in System Settings > Privacy & Security, then reruns plain
`doctor` in a fresh process. No visible dialog or an immediate missing result
does not prove that requesting failed: user approval may still be pending or
require manual enabling. Exit 0 means both grants, 2 means missing permissions,
and 1 denotes setup/diagnostic failure. This is not native UI verification.

Permanent storage prevents accidental helper deletion, not permission revocation.
The helper may need renewed approval after migration or ad-hoc source updates;
an available signing certificate can stabilize its designated requirement. No
credentials or captured evidence are stored with the installed helper.

## Credentials, limits and failure cases

Default preparation copies no credentials. UI-only flows need none.
`--seed-config` explicitly copies only SDK settings/models and user Desktop/suite
configuration. `--seed-api-keys` explicitly seeds literal API-key entries into
private files. OAuth, session/CLI credential stores, command expressions and
environment-variable references are not shared or resolved; no secrets are
printed. These seeds are not a complete authentication migration. Missing model
availability/authentication must be reported, not repaired by attaching to the
working app. Parent agents must not inspect or populate `.pi/qa_auth.jsonc`.

QA profiles may contain private configuration, API keys and test history. Keep
them mode-private under the owned run; never export the entire profile with UI
evidence. Scratch retention follows the project cleanup policy; export only
sanitized evidence that must survive cleanup.

The pin contains native and embedded web assets. Development ACP still resolves
its backend files from the checkout, so this is not a frozen release-runtime
snapshot. QA does not run another build inside the bounded launch step.

The default ephemeral WebView cannot validate production localStorage persistence
or the watcher's Restart handoff. Explicit restart/recovery testing needs its
own safe scenario; an unrelated active working run remains a legitimate blocker
for that scenario, not for ordinary isolated UI QA.

Missing/ambiguous watcher, failed build, deadline, unsafe path, invalid manifest,
unsupported isolation capability, native startup failure, inaccessible UI or
missing host permissions are explicit failures/blockers. An old working window,
window title alone, static checks or browser preview cannot turn them into a pass.

## Implementation

- `scripts/qa-desktop.mjs`
- `scripts/qa-desktop/cli.mjs`
- `scripts/qa-desktop/doctor.mjs`
- `scripts/qa-desktop/prepare.mjs`
- `scripts/qa-desktop/watch.mjs`
- `scripts/qa-desktop/paths.mjs`
- `scripts/qa-desktop/seed.mjs`
- `scripts/qa-desktop/launch.mjs`
- `desktop/src-tauri/src/qa_profile.rs`
- `desktop/src-tauri/src/startup_theme.rs`
- `desktop/src-tauri/src/lib.rs`
- `.pi/skills/pix-desktop-qa/SKILL.md`

## Tests and verification

- `tests/qa-desktop-doctor.test.ts`
- `tests/qa-desktop-prepare.test.ts`
- `tests/qa-desktop-launch.test.ts`
- `desktop/src-tauri/src/qa_profile.rs` (unit tests)

Run the focused Node tests and native profile/lifecycle tests. Native acceptance
must identify the pinned source and actual QA PID, verify a real rendered UI in
the disposable project, retain accessibility/pixel evidence, verify owned cleanup,
and show that the working Desktop executable/PID was not restarted or closed.
