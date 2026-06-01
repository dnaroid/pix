# pi-lsp

Declarative Pi extension for LSP diagnostics and language-server navigation tools.

## Why

`pi-lsp` lets users configure language servers with JSON instead of installing a separate Pi plugin for every language.

It is intentionally separate from [`pi-code-quality`](https://www.npmjs.com/package/pi-code-quality): LSP servers are long-lived JSON-RPC processes, while formatters/linters are short-lived command-line tools.

## Install

```bash
pi install npm:pi-lsp
```

For local development:

```bash
pi install /absolute/path/to/pi-lsp
```

## Configuration

Global config, trusted automatically:

```text
~/.pi/agent/lsp.json
```

Project-local config, requires trust:

```text
.pi/lsp.json
```

Project entries override global entries with the same `id`. A project entry with `"enabled": false` disables the global entry with that `id`.

## Trust and security

Project-local config can auto-run binaries on your machine. For that reason:

- project-local config content is hashed;
- unknown hashes prompt for `Trust once`, `Trust always`, or `Reject`;
- the prompt shows every configured LSP binary;
- `Trust always` stores the hash in `~/.pi/agent/trust/lsp.json`;
- changing the config changes the hash and asks again;
- non-interactive mode rejects project-local config by default;
- servers are spawned as `bin` + `args[]`, never as shell strings.

Global config is considered trusted because it is user-owned agent configuration.

## Example config

```json
{
  "version": 1,
  "servers": [
    {
      "id": "gopls",
      "enabled": true,
      "include": ["**/*.go"],
      "rootMarkers": ["go.mod"],
      "bin": "gopls",
      "args": [],
      "cwd": "{root}",
      "languageIdByExtension": { ".go": "go" },
      "startupTimeoutMs": 45000,
      "diagnosticsWaitMs": 1500,
      "initializationOptions": {},
      "settings": {}
    },
    {
      "id": "pyright",
      "enabled": true,
      "include": ["**/*.py", "**/*.pyi"],
      "rootMarkers": ["pyproject.toml", "setup.py", "requirements.txt"],
      "bin": "pyright-langserver",
      "args": ["--stdio"],
      "cwd": "{root}",
      "languageIdByExtension": { ".py": "python", ".pyi": "python" },
      "startupTimeoutMs": 45000,
      "diagnosticsWaitMs": 2000,
      "initializationOptions": {},
      "settings": {}
    },
    {
      "id": "clangd",
      "enabled": true,
      "include": ["**/*.c", "**/*.h", "**/*.cpp", "**/*.hpp", "**/*.cc", "**/*.cxx"],
      "rootMarkers": ["compile_commands.json", ".clangd"],
      "bin": "clangd",
      "args": ["--background-index"],
      "cwd": "{root}",
      "languageIdByExtension": {
        ".c": "c",
        ".h": "c",
        ".cpp": "cpp",
        ".hpp": "cpp",
        ".cc": "cpp",
        ".cxx": "cpp"
      },
      "startupTimeoutMs": 45000,
      "diagnosticsWaitMs": 2000,
      "initializationOptions": {},
      "settings": {}
    }
  ]
}
```

## Behavior

After a successful `write` or `edit`:

1. finds servers matching `include` / `exclude`;
2. finds `{root}` using `rootMarkers`;
3. starts or reuses one LSP process per `(server id, root)`;
4. reads the current file content;
5. sends `textDocument/didOpen` or `textDocument/didChange`;
6. sends `textDocument/didSave` when the server supports save;
7. waits `diagnosticsWaitMs`;
8. appends the latest diagnostics to the original tool result.

Diagnostics do **not** make `write` / `edit` fail. They are extra context for the model. Summaries that contain issues are also sent as a user-visible, tool-styled diagnostic notice.

On `session_shutdown`, the extension sends `shutdown`, then `exit`, then kills the process as fallback.

## LLM tools

`pi-lsp` registers tools for the model, not slash commands:

- `lsp_diagnostics({ path, force? })` — `force=true` repeats cached diagnostics even when automatic post-edit diagnostics were just shown; use it only for explicit user-requested repeats.
- `lsp_hover({ path, line, character })`
- `lsp_definition({ path, line, character })`
- `lsp_references({ path, line, character, includeDeclaration })`
- `lsp_symbols({ path })`

## Relative paths and placeholders

Path resolution:

1. absolute paths are used as-is;
2. relative `bin`, `config`, and `cwd` values with `/` are resolved relative to `{root}`;
3. bare binary names are resolved through `PATH`.

Placeholders:

- `{workspace}` — Pi working directory or directory containing project `.pi` config
- `{root}` — nearest directory containing one of `rootMarkers`
- `{file}` — absolute file path
- `{relFile}` — file path relative to `{root}`
- `{dir}` — absolute file directory
- `{relDir}` — file directory relative to `{root}`
- `{config}` — resolved server config path
- `{configDir}` — directory containing `{config}`

## Output example

```text
LSP diagnostics:

✅ gopls: clean — no issues found
```

```text
LSP diagnostics:

⚠️ pyright:
src/app.py:12:8 - error: Argument of type "str" cannot be assigned to parameter "int"
```

## Disable a server

```json
{
  "version": 1,
  "servers": [{ "id": "gopls", "enabled": false }]
}
```

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```
