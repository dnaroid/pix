#!/bin/bash
set -euo pipefail
# Explicit output required: use a unique .pi/artifacts/<run>/ directory.
if [[ $# != 1 ]]; then
  echo 'Usage: bash scripts/audio-listener-probe/build.sh OUTPUT_DIRECTORY' >&2
  exit 2
fi
source_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$1"
output_dir="$(cd "$1" && pwd)"
if [[ -e "$output_dir/listener-probe" ]]; then
  echo 'Refusing to overwrite an existing probe; choose a new run directory.' >&2
  exit 2
fi
xcrun swiftc -parse-as-library -target arm64-apple-macosx13.5 \
  "$source_dir/Probe.swift" "$source_dir/Decode.swift" "$source_dir/DecodeReference.swift" "$source_dir/Capture.swift" "$source_dir/CaptureLifetime.swift" \
  "$source_dir/MicrophoneCapture.swift" "$source_dir/CaptureCompletion.swift" "$source_dir/CapturePermission.swift" "$source_dir/AudioSink.swift" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$source_dir/Info.plist" \
  -o "$output_dir/listener-probe"
codesign --force --sign - --identifier dev.pix.audio-listener-probe "$output_dir/listener-probe"
echo "$output_dir/listener-probe"
