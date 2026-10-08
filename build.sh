#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# The web sequencer build is decommissioned (2026-07-02) — Sequence is
# native-only. The sample packs are still published at sequencer/samples/
# because samples.html loads its manifests + WAVs from that path.
rm -rf _site
mkdir -p _site

# pre-bake the samples.html tree (one fetch instead of one per pack)
node tools/build-samples-manifest.mjs

# generate the news section (posts/*.md → news/, news.html, feed.xml)
node tools/build-news.mjs

# generate the product pages (shop.json → shop/<id>.html)
node tools/build-shop.mjs

# generate the about page (about.md → about.html)
node tools/build-about.mjs

cp *.html *.js *.css *.svg *.png *.jpg *.txt _site/
cp samples-manifest.json shop.json _site/
cp -r shop _site/shop
if [ -d news ]; then
  cp -r news _site/news
  cp feed.xml _site/
fi
cp -r fonts _site/fonts
# waves.html's wave library (tools/wave-harvest.mjs)
cp -r waves _site/waves
if [ -d assets ]; then
  cp -r assets _site/assets
fi
# edit — the hardware synth editor (tools/rack), unlisted at /edit/
node tools/build-edit.mjs
mkdir -p _site/sequencer
cp -r sequencer/public/samples _site/sequencer/samples
