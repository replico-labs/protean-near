#!/usr/bin/env bash
# Gets everything a local NEAR sandbox run needs, into .sandbox/ at the repo
# root: the near-sandbox node, and in .sandbox/wasm every contract the
# scripts install. Safe to re-run; anything already there is kept.
#
#   ./bot/scripts/sandbox-prepare.sh
#
# Needs git, curl, Node 20+, Rust (rustup) and cargo-near. macOS (Apple
# Silicon or Intel) and Linux x86_64. The first run takes a while: it builds
# Sputnik, the Orbits contracts and LiNEAR (with Rust 1.69, which it installs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/.sandbox"
WASM="$WORK/wasm"
SRC="$WORK/src"
SANDBOX_VERSION="2.13.0"
SPUTNIK_REV="5434a59dec23ee0c49df8c8c4350c208a7e75b0b"
mkdir -p "$WASM" "$SRC" "$WORK/bin"

step() { printf '\n== %s\n' "$1"; }
have() { [ -s "$WASM/$1" ]; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. $2" >&2; exit 1; }; }

need git "Install it from git-scm.com."
need curl ""
need node "Install Node 20+ from nodejs.org."
need cargo "Install Rust from rustup.rs."
need rustup "Install Rust from rustup.rs."
cargo near --version >/dev/null 2>&1 || {
  echo "Missing cargo-near. Install it with:" >&2
  echo "  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh" >&2
  exit 1
}

# A shallow clone of only `paths` from `repo`, into $SRC/<name>.
fetch() {
  local repo="$1" name="$2"; shift 2
  if [ ! -d "$SRC/$name/.git" ]; then
    git clone -q --depth 1 --filter=blob:none --sparse "https://github.com/$repo" "$SRC/$name"
  fi
  git -C "$SRC/$name" sparse-checkout set "$@"
}

step "The near-sandbox node"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="Darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="Darwin-x86_64" ;;
  Linux-x86_64) PLATFORM="Linux-x86_64" ;;
  *) echo "No near-sandbox build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
if [ ! -x "$WORK/bin/near-sandbox" ]; then
  curl -sSfL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$PLATFORM/$SANDBOX_VERSION/near-sandbox.tar.gz" | tar xz -C "$WORK/bin"
  mv "$WORK/bin/$PLATFORM/near-sandbox" "$WORK/bin/near-sandbox" && rmdir "$WORK/bin/$PLATFORM"
  # macOS may block a downloaded binary; this is NEAR's own build.
  [ "$(uname -s)" = Darwin ] && xattr -dr com.apple.quarantine "$WORK/bin" 2>/dev/null || true
fi
echo "near-sandbox $SANDBOX_VERSION ($PLATFORM)"

step "Sputnik DAO (the factory and the DAO contract), at the revision Orbits is tested against"
if ! have sputnikdao2.wasm || ! have sputnikdao_factory2.wasm; then
  [ -d "$SRC/sputnik/.git" ] || git clone -q https://github.com/near-daos/sputnik-dao-contract "$SRC/sputnik"
  git -C "$SRC/sputnik" checkout -q "$SPUTNIK_REV"
  rm -f "$SRC/sputnik/rust-toolchain.toml"
  # The same near-sdk as Orbits, so it builds with today's Rust for NEAR's current protocol.
  (cd "$SRC/sputnik" && cargo update -q -p near-sdk -p near-contract-standards --precise 5.29.1)
  for c in sputnikdao2 sputnikdao-factory2; do (cd "$SRC/sputnik/$c" && cargo near build non-reproducible-wasm); done
  cp "$SRC"/sputnik/target/near/*/*.wasm "$WASM/"
fi
echo "sputnikdao2.wasm, sputnikdao_factory2.wasm"

step "Orbits: the nine modules, staking, the token, and the sandbox signer"
for dir in "$ROOT"/orbits/modules/* "$ROOT/orbits/orbit-staking" "$ROOT/orbits/governance-token" "$ROOT/orbits/testing/mock-signer"; do
  (cd "$dir" && cargo near build non-reproducible-wasm >/dev/null)
done
cp "$ROOT/orbits/target/near/governance_token/governance_token.wasm" "$ROOT/orbits/target/near/mock_signer/mock_signer.wasm" "$WASM/"
echo "Built into orbits/target/near (publish-contracts.js reads them there)"

step "Rhea's exchange (the released Ref contract)"
if ! have ref_exchange_release.wasm; then
  fetch marco-sundsk/ref-contracts ref releases
  cp "$SRC/ref/releases/ref_exchange_release.wasm" "$WASM/"
fi
echo "ref_exchange_release.wasm"

step "Wrapped NEAR and the NEAR Intents Verifier"
if ! have wnear.wasm || ! have defuse-0.2.10.wasm; then
  fetch near/intents intents releases
  cp "$SRC/intents/releases/wnear.wasm" "$SRC/intents/releases/defuse-0.2.10.wasm" "$WASM/"
fi
echo "wnear.wasm, defuse-0.2.10.wasm"

step "LiNEAR (built with Rust 1.69, as the project pins)"
if ! have linear.wasm; then
  [ -d "$SRC/linear/.git" ] || git clone -q --depth 1 https://github.com/linear-protocol/LiNEAR "$SRC/linear"
  rustup toolchain install 1.69.0 --profile minimal --target wasm32-unknown-unknown >/dev/null
  (cd "$SRC/linear" && RUSTUP_TOOLCHAIN=1.69.0 RUSTFLAGS='-C link-arg=-s' cargo build -q -p linear --target wasm32-unknown-unknown --release)
  cp "$SRC/linear/target/wasm32-unknown-unknown/release/linear.wasm" "$WASM/"
fi
echo "linear.wasm"

step "Bot dependencies"
(cd "$ROOT/bot" && npm install --silent)

cat <<EOF

Ready. Everything is in $WORK.

1. Start the node in its own terminal tab, and leave it running:

   ulimit -n 65535
   $WORK/bin/near-sandbox --home $WORK/home init     # first time only
   $WORK/bin/near-sandbox --home $WORK/home run

2. In another tab:

   cd $ROOT/bot
   node scripts/sandbox-setup.js $WORK/home $WASM
   node --env-file=.env.sandbox scripts/publish-contracts.js --yes
   node scripts/sandbox-venues.js $WORK/home $WASM
   node --env-file=.env.sandbox scripts/sandbox-flow.js      # the main flow and the integrations
   node --env-file=.env.sandbox scripts/sandbox-models.js    # each governance model's own mechanics

To start over: stop the node, delete $WORK/home and bot/.env.sandbox, and repeat.
EOF
