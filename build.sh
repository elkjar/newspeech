#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

pushd sequencer >/dev/null
npm install
npm run build
popd >/dev/null

rm -rf _site
mkdir -p _site
cp *.html *.js *.svg *.png *.txt _site/
cp -r fonts _site/fonts
cp -r sequencer/dist _site/sequencer
