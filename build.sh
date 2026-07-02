#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# The web sequencer build is decommissioned (2026-07-02) — Sequence is
# native-only. The sample packs are still published at sequencer/samples/
# because samples.html and live.html load their manifests + WAVs from
# that path.
rm -rf _site
mkdir -p _site
cp *.html *.js *.svg *.png *.txt _site/
cp -r fonts _site/fonts
mkdir -p _site/sequencer
cp -r sequencer/public/samples _site/sequencer/samples
