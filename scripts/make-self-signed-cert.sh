#!/usr/bin/env bash
# Creates the self-signed code-signing certificate that signs Astro Editor+
# releases, and prints what to store as GitHub secrets.
#
#   scripts/make-self-signed-cert.sh [output-dir]
#
# Needs macOS (`security`) and `openssl`. Writes astro-editor-plus-signing.p12
# to the output dir (default: a new temp dir), checks it imports into a
# throwaway keychain, then prints:
#   MACOS_CERT_P12_BASE64   the .p12, base64 encoded
#   MACOS_CERT_PASSWORD     a random password for it
# Nothing is added to your login keychain and no GitHub secret is set.
#
# Keep the .p12: every release must be signed with the SAME certificate, or
# macOS treats each update as a different app and re-asks for permissions.
# The certificate is valid for 10 years.
set -euo pipefail

NAME="Astro Editor+ Self-Signed"
out_dir="${1:-$(mktemp -d)}"
mkdir -p "$out_dir"
password="$(openssl rand -hex 16)"
work="$(mktemp -d)"
keychain="$work/verify.keychain-db"
trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

cat > "$work/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -config "$work/openssl.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null

# macOS's `security import` can't read the newer AES-based .p12 format that
# OpenSSL 3 writes by default, so ask for the legacy one when it exists
legacy=()
if openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then legacy=(-legacy); fi
openssl pkcs12 -export "${legacy[@]}" \
  -inkey "$work/key.pem" -in "$work/cert.pem" -name "$NAME" \
  -out "$out_dir/astro-editor-plus-signing.p12" -passout "pass:$password"

# Check that macOS accepts it and sees a code-signing identity
security create-keychain -p "$password" "$keychain"
security import "$out_dir/astro-editor-plus-signing.p12" -k "$keychain" \
  -P "$password" -T /usr/bin/codesign >/dev/null
security find-certificate -c "$NAME" "$keychain" >/dev/null

echo "Created $out_dir/astro-editor-plus-signing.p12 (identity: $NAME)" >&2
echo >&2
echo "MACOS_CERT_PASSWORD=$password"
echo "MACOS_CERT_P12_BASE64=$(base64 < "$out_dir/astro-editor-plus-signing.p12" | tr -d '\n')"
