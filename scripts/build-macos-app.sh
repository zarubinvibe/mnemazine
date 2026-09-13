#!/bin/bash
set -euo pipefail

# Local development bundle, without distribution signing or notarization.
project_root="$(cd "$(dirname "$0")/.." && pwd)"
build_root="$project_root/.mnemazine/tmp/macos-build"
app_root="$project_root/.mnemazine/tmp/Mnemazine.app"
swift build --package-path "$project_root/macos" --scratch-path "$build_root" -c release
binary_root="$(swift build --package-path "$project_root/macos" --scratch-path "$build_root" -c release --show-bin-path)"
mkdir -p "$app_root/Contents/MacOS"
mkdir -p "$app_root/Contents/Resources" "$build_root/AppIcon.iconset"
icon_source="$project_root/docs/assets/pantheon/app-icon-mnemazine.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon_source" --out "$build_root/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  sips -z "$retina_size" "$retina_size" "$icon_source" --out "$build_root/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$build_root/AppIcon.iconset" -o "$app_root/Contents/Resources/AppIcon.icns"
cp "$binary_root/Mnemazine" "$app_root/Contents/MacOS/Mnemazine"
cp "$project_root/macos/Info.plist" "$app_root/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :MnemazineRepository string $project_root" "$app_root/Contents/Info.plist"
if node_binary="$(command -v node)"; then
  /usr/libexec/PlistBuddy -c "Add :MnemazineNode string $node_binary" "$app_root/Contents/Info.plist"
fi
codesign --force --sign - "$app_root"
printf '%s\n' "$app_root"
