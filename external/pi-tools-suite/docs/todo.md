# rpiv-todo

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo">
    <picture>
      <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/cover.png" alt="rpiv-todo cover" width="50%">
    </picture>
  </a>
</div>

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-todo.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Give the model a todo list it can keep across long sessions. `rpiv-todo` adds the `todo` tool and the `/todos` slash command to [Pi Agent](https://github.com/badlogic/pi-mono) - tasks survive `/reload` and conversation compaction, so the model picks up where it left off.

## Features

- **Survives `/reload` and compaction** - tasks replay from the conversation branch, not disk.
- **Status states** - pending, in_progress, completed, plus a deleted tombstone for audit.
- **Dependency tracking** - `blockedBy` with cycle detection, so the model can sequence work.

## Install

```bash
pi install npm:@juicesharp/rpiv-todo
```

Then restart your Pi session.

## Tool

- **`todo`** - create / update / list / get / delete / clear tasks. 4-state
  machine (pending → in_progress → completed, plus deleted tombstone).
  Supports `blockedBy` dependency tracking with cycle detection. Tasks persist
  via branch replay - survive session compact and `/reload`.

### Schema

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",

  // create-only
  subject?: string,                // required for create
  blockedBy?: number[],            // initial dependency ids

  // create + update
  description?: string,
  activeForm?: string,             // present-continuous label shown while in_progress
  owner?: string,
  metadata?: Record<string, unknown>, // pass null per key to delete that key on update

  // update-only
  addBlockedBy?: number[],         // additive merge into blockedBy
  removeBlockedBy?: number[],      // additive removal from blockedBy

  // update / get / delete
  id?: number,                     // task id

  // update (target) or list (filter)
  status?: "pending" | "in_progress" | "completed" | "deleted",

  // list-only
  includeDeleted?: boolean,        // default false - hides tombstones
})
```

Valid status transitions: `pending ⇄ in_progress`, either → `completed`, any → `deleted` (terminal). `delete` keeps the task as a tombstone so historic `blockedBy` references still resolve.

Returns:

```ts
{
  content: [{ type: "text", text: string }], // human-readable summary of the op
  details: {                                 // full snapshot - replay reads this back
    action: TaskAction,
    params: Record<string, unknown>,
    tasks: Array<{
      id: number,
      subject: string,
      description?: string,
      activeForm?: string,
      status: "pending" | "in_progress" | "completed" | "deleted",
      blockedBy?: number[],
      owner?: string,
      metadata?: Record<string, unknown>,
    }>,
    nextId: number,
    error?: string,                          // present only on validation/transition failures
  }
}
```

## Commands

- **`/todos`** - print the current todo list grouped by status.

## License

MIT
