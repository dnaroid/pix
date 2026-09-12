# Browser auth guide

Load this guide only when a browser task actually requires authentication:
profile discovery, form-auth scaffolding, or an auth update flow. Public QA
needs no credentials and must not create `.pi/qa_auth.jsonc`.

`PI_BROWSER_QA_RUNNER` names the installed trusted browser backend. Invoke it
directly only for the commands in this guide; all probe/run browser execution
still goes through `node "$PI_UI_QA_RUNNER"`.

Never read, print, grep, copy, or edit credential values from
`.pi/qa_auth.jsonc` yourself.

## Profile discovery

When a task requires authenticated behavior, first run:

```sh
node "$PI_BROWSER_QA_RUNNER" profiles
```

A missing auth config returns an empty list without creating
`.pi/qa_auth.jsonc`. Choose an auth profile only when the task names its id,
safe profile traits make the choice unambiguous, or a public run proves that
the requested page requires login. Profiles live in project-local
`.pi/qa_auth.jsonc` (mode `0600` on POSIX) and every profile declares its own
exact `allowedOrigins`; listing output exposes only profile ids, descriptions,
and traits.

When an explicit authenticated request finds no usable profile, run:

```sh
node "$PI_BROWSER_QA_RUNNER" profiles --require-auth
```

Only `auth scaffold` and `profiles --require-auth` may create the private auth
file.

## Form-auth scaffolding

When a public HTTPS login page (or loopback HTTP page for local development) is
known and there is no usable profile, invoke the trusted runner once:

```sh
node "$PI_BROWSER_QA_RUNNER" auth scaffold \
  --profile <safe-id> \
  --login-url <public-login-url>
```

The runner discovers the login form and privately writes a target-specific
`.pi/qa_auth.jsonc` containing `__PI_QA_SECRET_n__` values. It may create the
file or replace only the runner's own empty generated template; it refuses to
overwrite invalid or non-empty auth configuration. Never inspect the result.
Relay `QA_AUTH_SCAFFOLD_CREATED`, the reported file, profile, placeholder count,
and action, then ask the user to replace only those placeholder values. Browser
QA must resume in a new run after the user confirms that edit.

By default, login succeeds when the discovered form becomes hidden. A form-less
page therefore requires an explicit deterministic signal using either
`--success-url <glob>` or `--success-selector <selector>` with optional
`--success-state attached|detached|visible|hidden`. Use `--base-url <url>` only
to override the profile's same-origin application root. These are public
metadata; never put credential values in command arguments or environment
variables.

Do not scaffold cookie, bearer, storage, storage-state, MFA, CAPTCHA, or
federated login. For those modes, use the generic empty-template flow below and
ask the user to configure the profile themselves.

Do not request credentials merely because `.pi/qa_auth.jsonc` is absent. If the
task explicitly requires authenticated behavior, or a public run reaches the
flow's `authRejectedIf` check, and `profiles` returned no usable profile, run
form-auth scaffolding when supported. Otherwise run
`node "$PI_BROWSER_QA_RUNNER" profiles --require-auth`. Only these paths
may create the private auth file.

## Scaffold safety and edge cases

The trusted runner discovers the most likely form, fillable fields, submit
control, and form container on the unauthenticated page. It writes only
discovered selectors and generated placeholders to the private `0600` config.
The agent treats that config as opaque and user-owned. Scaffold status exposes
only the file path, profile id, counts, and action, never inspected DOM text,
input values, URLs, or selectors.

Scaffolding rejects pages without a discoverable fillable field or submit
control, form-less pages without an explicit success condition, remote HTTP
login pages, cross-origin base URLs, malformed success options, symlinked or
permissive auth paths, and invalid or non-empty existing configuration. Report
these blockers; do not bypass them. No generated profile is usable until the
user replaces its secret placeholders.

## Blocked auth runs

If a scaffold/profile command or an authenticated run returns
`QA_AUTH_UPDATE_REQUIRED`, stop and explicitly report that authenticated
browser QA requires credentials or an auth-config update. Ask the user to fill
the reported file and rerun QA. If `templateCreated` is true, say that a
private empty template was created at that path. Relay only the runner's
profile, file, reason, action, and template-created state; never read the
generated file or attempt to recover by exposing or replaying credentials. If
the action is `fill_credentials`, also relay the placeholder count and tell the
user to replace only the generated placeholder values.

For any other blocked run, report the runner status and redacted reason. Do not
claim that browser QA passed based on source inspection, unit tests, or a
build.

After any runner invocation that actually performed browser testing, include
all non-empty `artifacts.screenshots`, `artifacts.videos`, and
`artifacts.traces`, and `artifacts.downloads` groups in the final response.
These links are mandatory so the user can open the evidence directly. Also
include `visualInspection` with `inspected` or `unavailable`; never infer a
visual pass from a successful runner status alone.
