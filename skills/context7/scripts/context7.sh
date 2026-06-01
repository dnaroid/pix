#!/usr/bin/env bash
# Context7 — fetch up-to-date library documentation via the Context7 MCP API
#
# Usage:
#   context7.sh resolve "React" "how to use hooks"
#   context7.sh docs "/facebook/react" "useEffect cleanup examples"
#   context7.sh docs "/vercel/next.js/v16.0.3" "App Router setup"
#
# Two-step workflow:
#   1. resolve — find the Context7 library ID for a package
#   2. docs    — query documentation for a resolved library ID
#
# Requires CONTEXT7_API_KEY env var (falls back to hardcoded default).

set -euo pipefail

API_KEY="${CONTEXT7_API_KEY:-ctx7sk-d3b58838-f015-48a3-8059-93562f78837d}"
BASE_URL="https://mcp.context7.com/mcp"

call_mcp() {
  local method="$1"
  local name="$2"
  local arguments="$3"

  # Extract the id from a simple counter
  local response
  response=$(curl -s -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$(jq -n \
      --argjson id "$RANDOM" \
      --arg method "$method" \
      --arg name "$name" \
      --argjson args "$arguments" \
      '{
        jsonrpc: "2.0",
        id: $id,
        method: $method,
        params: { name: $name, arguments: $args }
      }')")

  # MCP responses come as SSE events — extract the JSON data line
  if echo "$response" | grep -q "^data:"; then
    echo "$response" | grep "^data:" | sed 's/^data: //' | jq '.result.content[0].text // .result.content'
  else
    echo "$response" | jq '.'
  fi
}

cmd="${1:?Usage: context7.sh [resolve|docs] ...}"

case "$cmd" in
  resolve)
    LIBRARY_NAME="${2:?Usage: context7.sh resolve \"Library Name\" \"query\"}"
    QUERY="${3:-$LIBRARY_NAME}"
    call_mcp "tools/call" "resolve-library-id" \
      "$(jq -n --arg lib "$LIBRARY_NAME" --arg q "$QUERY" '{libraryName: $lib, query: $q}')"
    ;;

  docs)
    LIBRARY_ID="${2:?Usage: context7.sh docs \"/org/project\" \"query\"}"
    QUERY="${3:?Usage: context7.sh docs \"/org/project\" \"query\"}"
    call_mcp "tools/call" "query-docs" \
      "$(jq -n --arg id "$LIBRARY_ID" --arg q "$QUERY" '{libraryId: $id, query: $q}')"
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    echo "Usage: context7.sh [resolve|docs] ..." >&2
    exit 1
    ;;
esac
