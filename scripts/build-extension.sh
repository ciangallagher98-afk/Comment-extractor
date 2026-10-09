#!/usr/bin/env bash
# Packages the Chrome extension for download from the website.
#
# Run this after changing anything in extension/ (and bump "version" in
# extension/manifest.json first), then commit the two files it writes:
#   downloads/comment-extractor-extension.zip   the file colleagues download
#   downloads/extension-version.json            lets the site say "update available"
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(node -p "require('./extension/manifest.json').version")
mkdir -p downloads
rm -f downloads/comment-extractor-extension.zip

# Zip the folder itself, so unzipping gives one tidy "comment-extractor-extension" folder.
tmp=$(mktemp -d)
cp -R extension "$tmp/comment-extractor-extension"
(cd "$tmp" && zip -qr - comment-extractor-extension -x '*/.*') > downloads/comment-extractor-extension.zip
rm -rf "$tmp"

printf '{ "version": "%s" }\n' "$version" > downloads/extension-version.json
echo "Packaged extension v$version"
