#!/usr/bin/env bash
#
# Sign + notarize + staple a Saturator plug-in bundle (AU or VST3) for
# distribution. Bundle type is detected from the file extension — same
# codesign + notarize + staple flow for both, only the entitlements
# (AU library-validation disable) and zip naming differ.
#
# Usage:
#   ./sign-and-notarize.sh <path-to-bundle>
#
# Requires APPLE_TEAM_ID, APPLE_DEV_ID_NAME, APPLE_ID, APPLE_APP_PWD
# to be set in the environment OR present in `dist/.signing-config`
# (which this script sources if found). See `.signing-config.example`
# for the format and where to grab each value.
#
# Flow:
#   1. codesign with hardened runtime (--options runtime), secure
#      timestamp, and the dist/Saturator.entitlements file (which
#      enables com.apple.security.cs.disable-library-validation so
#      AU hosts can load the bundle under hardened runtime).
#   2. ditto -c -k --keepParent to zip the bundle for notarytool
#      submission. (notarytool accepts .zip / .dmg / .pkg; zip is
#      simplest.)
#   3. xcrun notarytool submit --wait — blocks until Apple's notary
#      service returns "Accepted" or "Invalid". On reject, dumps the
#      full log so the failing entitlement / signing rule is visible.
#   4. xcrun stapler staple — embeds the notarization ticket into
#      the bundle so Gatekeeper can verify offline on the tester's
#      machine.
#   5. spctl -a -t install — final sanity check that the bundle
#      passes Gatekeeper assessment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/Saturator.entitlements"
SIGNING_CONFIG="$SCRIPT_DIR/.signing-config"

# --- Args ---
[ $# -eq 1 ] || { echo "Usage: $0 <path-to-bundle>"; exit 2; }
BUNDLE="$1"
[ -d "$BUNDLE" ]       || { echo "ERROR: $BUNDLE is not a directory"; exit 2; }
[ -f "$ENTITLEMENTS" ] || { echo "ERROR: entitlements file missing at $ENTITLEMENTS"; exit 2; }

# --- Credentials: env first, fall back to .signing-config ---
if [ -f "$SIGNING_CONFIG" ]; then
  # shellcheck disable=SC1090
  source "$SIGNING_CONFIG"
fi

: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set — fill in $SIGNING_CONFIG or export it}"
: "${APPLE_DEV_ID_NAME:?APPLE_DEV_ID_NAME not set — fill in $SIGNING_CONFIG or export it}"
# notarytool auth: App Store Connect API key preferred (APPLE_API_KEY_PATH /
# APPLE_API_KEY / APPLE_API_ISSUER — same trio release.sh uses); falls back
# to Apple-ID + app-specific password. Apple-ID auth 403s on some accounts
# ("Invalid or inaccessible developer team ID") where the API key works.
if [ -z "${APPLE_API_KEY_PATH:-}" ]; then
  : "${APPLE_ID:?APPLE_ID not set (and no APPLE_API_KEY_PATH) — fill in $SIGNING_CONFIG or export it}"
  : "${APPLE_APP_PWD:?APPLE_APP_PWD not set (and no APPLE_API_KEY_PATH) — fill in $SIGNING_CONFIG or export it}"
fi

# --- Sanity-check the signing identity is actually installed ---
if ! security find-identity -v -p codesigning | grep -q "$APPLE_DEV_ID_NAME"; then
  echo "ERROR: Developer ID '$APPLE_DEV_ID_NAME' not found in keychain."
  echo "Run: security find-identity -v -p codesigning"
  echo "to see what identities are available. If empty, your cert isn't installed —"
  echo "download it from developer.apple.com and double-click to add to Keychain."
  exit 1
fi

# --- 1. Codesign with hardened runtime ---
echo "▸ Codesigning $BUNDLE with hardened runtime + entitlements…"
codesign --force --deep \
  --sign "$APPLE_DEV_ID_NAME" \
  --options runtime \
  --timestamp \
  --entitlements "$ENTITLEMENTS" \
  "$BUNDLE"

# Verify the signature took.
codesign --verify --strict --verbose=2 "$BUNDLE" 2>&1 | head -5
SIG_INFO="$(codesign -dvv "$BUNDLE" 2>&1)"
echo "$SIG_INFO" | grep -q "Signature=adhoc" && { echo "ERROR: signature is still adhoc — sign step didn't take"; exit 1; }
echo "$SIG_INFO" | grep -q "Authority=Developer ID Application" || { echo "ERROR: signed but not by Developer ID Application — got:"; echo "$SIG_INFO"; exit 1; }
echo "  ✓ Hardened runtime + Developer ID signature applied"

# --- 2. Zip for notarytool submission ---
BUNDLE_DIR="$(cd "$(dirname "$BUNDLE")" && pwd)"
BUNDLE_NAME="$(basename "$BUNDLE")"
# Strip the trailing .component / .vst3 (whichever applies) for a clean zip name.
ZIP_BASE="${BUNDLE_NAME%.component}"
ZIP_BASE="${ZIP_BASE%.vst3}"
ZIP="$BUNDLE_DIR/${ZIP_BASE}-$(basename "$BUNDLE" | sed -E 's/.*\.([^.]+)$/\1/').zip"
rm -f "$ZIP"
echo "▸ Zipping for notarization → $ZIP"
( cd "$BUNDLE_DIR" && ditto -c -k --keepParent "$BUNDLE_NAME" "$ZIP" )

# --- 3. Submit to Apple's notary service ---
echo "▸ Submitting to notarytool (blocks until Apple responds; usually minutes)…"
NOTARY_LOG="$(mktemp -t saturator-notary)"
if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  NOTARY_AUTH=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
else
  NOTARY_AUTH=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PWD")
fi
if xcrun notarytool submit "$ZIP" \
    "${NOTARY_AUTH[@]}" \
    --wait \
    --output-format plist > "$NOTARY_LOG" 2>&1; then
  if grep -q "<string>Accepted</string>" "$NOTARY_LOG"; then
    SUBMISSION_ID="$(grep -A1 '<key>id</key>' "$NOTARY_LOG" | tail -1 | sed -E 's/.*<string>(.*)<\/string>.*/\1/')"
    echo "  ✓ Accepted (submission id: $SUBMISSION_ID)"
  else
    echo "ERROR: notarytool returned 0 but result wasn't Accepted. Full plist:"
    cat "$NOTARY_LOG"
    exit 1
  fi
else
  echo "ERROR: notarytool submission failed. Output:"
  cat "$NOTARY_LOG"
  echo
  echo "To see Apple's detailed rejection reasons, find the submission id"
  echo "above and run:"
  echo "  xcrun notarytool log <id> --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password \\\$APPLE_APP_PWD"
  exit 1
fi
rm -f "$ZIP" "$NOTARY_LOG"

# --- 4. Staple the ticket into the bundle ---
echo "▸ Stapling notarization ticket…"
xcrun stapler staple "$BUNDLE"

# --- 5. Gatekeeper sanity check ---
echo "▸ Verifying with spctl (Gatekeeper assessment)…"
if spctl -a -t install -vv "$BUNDLE" 2>&1 | tee /dev/stderr | grep -q "accepted"; then
  echo
  echo "✓ Bundle is signed, notarized, and stapled."
  echo "  $BUNDLE is ready to ship."
else
  echo "WARNING: spctl didn't report 'accepted'. The bundle is signed and notarized but Gatekeeper may still complain on a fresh machine."
  exit 1
fi
