#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

shim_file="${TMPDIR:-/tmp}/async-subagents-shims.d.ts"
cat > "$shim_file" <<'EOF'
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerTool(tool: any): void;
    registerCommand(name: string, command: any): void;
    registerMessageRenderer<T = any>(name: string, renderer: (message: { details?: T; content?: any }, options: any, theme: any) => any): void;
    sendMessage(message: any, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
    on(event: string, handler: (...args: any[]) => any): void;
    events: { emit(event: string, data?: unknown): void; on(event: string, handler: (data: unknown) => void): void };
  }
}
declare module "@earendil-works/pi-ai" {
  export interface Api {}
  export interface Model<T = Api> {
    [key: string]: any;
  }
  export function complete(model: Model<any>, input: any, options?: any): Promise<any>;
  export const Type: any;
}
declare module "@earendil-works/pi-tui" {
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
