#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# The web sequencer build is decommissioned (2026-07-02) — Sequence is
# native-only. The sample packs are still published at sequencer/samples/
# because samples.html and live.html load their manifests + WAVs from
# that path.
rm -rf _site
mkdir -p _site

# pre-bake the samples.html tree (one fetch instead of one per pack)
node tools/build-samples-manifest.mjs

# generate the news section (posts/*.md → news/, news.html, feed.xml)
node tools/build-news.mjs

cp *.html *.js *.svg *.png *.txt _site/
cp samples-manifest.json _site/
if [ -d news ]; then
  cp -r news _site/news
  cp feed.xml _site/
fi
cp -r fonts _site/fonts
mkdir -p _site/sequencer
cp -r sequencer/public/samples _site/sequencer/samples
