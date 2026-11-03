#!/bin/bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_dir="$(cd -- "$source_dir/../.." && pwd -P)"
test_host_dir="$project_dir/artifacts/codex-test-host"
app_dir="$test_host_dir/ReviewSlate Client Test Host.app"
mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources" "$test_host_dir/.build/module-cache"
/usr/bin/xcrun swiftc -swift-version 5 -O -target arm64-apple-macos13.0 \
  -module-cache-path "$test_host_dir/.build/module-cache" \
  -framework AppKit -framework WebKit \
  "$source_dir/main.swift" -o "$app_dir/Contents/MacOS/ReviewSlateClientTestHost"
/bin/cp "$source_dir/Info.plist" "$app_dir/Contents/Info.plist"
/bin/cp "$source_dir/shell.html" "$app_dir/Contents/Resources/shell.html"
/usr/bin/plutil -lint "$app_dir/Contents/Info.plist"
/usr/bin/codesign --force --sign - --identifier org.reviewslate.codextesthost "$app_dir"
/usr/bin/codesign --verify --strict "$app_dir"
printf '%s\n' 'Built independent ReviewSlate Client Test Host. No application was opened.'
