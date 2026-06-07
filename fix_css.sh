#!/bin/bash
CSS="apps/desktop-tauri/src/App.css"

sed -i '' 's/font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;/font-family: var(--font-sans);/g' "$CSS"
sed -i '' 's/font-family: ui-monospace, SFMono-Regular, Menlo, monospace;/font-family: var(--font-mono);/g' "$CSS"
sed -i '' 's/font-family: "JetBrains Mono", ui-monospace, monospace;/font-family: var(--font-mono);/g' "$CSS"

sed -i '' 's/color: var(--bg);/color: var(--on-primary);/g' "$CSS"
sed -i '' 's/color: white;/color: var(--on-primary);/g' "$CSS"
sed -i '' 's/border-radius: 6px;/border-radius: 12px;/g' "$CSS"

sed -i '' 's/background: rgba(187, 154, 247, 0.12);/background: var(--surface-dark-elevated);/g' "$CSS"
sed -i '' 's/border-color: rgba(187, 154, 247, 0.3);/border-color: var(--border);/g' "$CSS"
sed -i '' 's/color: #bb9af7;/color: var(--text-dim);/g' "$CSS"

sed -i '' 's/background: rgba(122, 162, 247, 0.12);/background: var(--surface-dark-elevated);/g' "$CSS"
sed -i '' 's/border-color: rgba(122, 162, 247, 0.3);/border-color: var(--border);/g' "$CSS"

sed -i '' 's/border-color: rgba(122, 162, 247, 0.4);/border-color: var(--accent); opacity: 0.8;/g' "$CSS"
sed -i '' 's/border-color: rgba(247, 118, 142, 0.4);/border-color: var(--error); opacity: 0.8;/g' "$CSS"

sed -i '' 's/color: #9bd687;/color: var(--success);/g' "$CSS"
sed -i '' 's/color: #f7768e;/color: var(--error);/g' "$CSS"

sed -i '' 's/color: #fff;/color: var(--on-primary);/g' "$CSS"
sed -i '' 's/color: var(--warning, #e0af68);/color: var(--warning);/g' "$CSS"

sed -i '' 's/background: rgba(122, 162, 247, 0.14);/background: rgba(255, 255, 255, 0.05);/g' "$CSS"

# Specific tool block changes for dark mode
awk '/\.tool \{/,/\}/ {
  if ($1 == "background:") { print "  background: var(--surface-dark);"; print "  color: var(--on-dark);"; next }
  if ($1 == "border:") { print "  border: 1px solid var(--surface-dark-elevated);"; next }
}1' "$CSS" > temp_css && mv temp_css "$CSS"

awk '/\.tool__header \{/,/\}/ {
  if ($1 == "border-bottom:") { print "  border-bottom: 1px solid var(--surface-dark-elevated);"; next }
}1' "$CSS" > temp_css && mv temp_css "$CSS"

awk '/\.tool__name \{/,/\}/ {
  if ($1 == "color:") { print "  color: var(--on-dark);"; next }
}1' "$CSS" > temp_css && mv temp_css "$CSS"

awk '/\.tool__status \{/,/\}/ {
  if ($1 == "color:") { print "  color: var(--on-dark-soft);"; next }
}1' "$CSS" > temp_css && mv temp_css "$CSS"

