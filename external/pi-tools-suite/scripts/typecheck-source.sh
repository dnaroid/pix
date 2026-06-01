#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

shim_file="${TMPDIR:-/tmp}/async-subagents-shims.d.ts"
cat > "$shim_file" <<'EOF'
declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(tool: any): void;
    registerCommand(name: string, command: any): void;
    registerMessageRenderer<T = any>(name: string, renderer: (message: { details?: T; content?: any }, options: any, theme: any) => any): void;
    on(event: string, handler: (...args: any[]) => any): void;
    events: { emit(event: string, data?: unknown): void; on(event: string, handler: (data: unknown) => void): void };
  }
}
declare module "@mariozechner/pi-ai" {
  export const Type: any;
}
declare module "@mariozechner/pi-tui" {
  export class Container {
    constructor();
    [key: string]: any;
  }
  export class Text {
    constructor(text?: string, x?: number, y?: number);
    [key: string]: any;
  }
  export function visibleWidth(text: string): number;
  export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
}
EOF

tsc \
  --noEmit \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --skipLibCheck \
  "$shim_file" \
  $(find src/async-subagents -name '*.ts' -print)
