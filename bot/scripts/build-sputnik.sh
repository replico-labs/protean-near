#!/usr/bin/env bash
# Builds Sputnik's DAO contract and factory, unmodified, at the revision
# Orbits is tested against, into .sandbox/wasm at the repo root (git ignores
# it). scripts/deploy-factory.js and the sandbox read them there. Safe to
# re-run; a build already there is kept.
#
#   ./bot/scripts/build-sputnik.sh
#
# Needs git, Rust (rustup) and cargo-near.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WASM="$ROOT/.sandbox/wasm"
SRC="$ROOT/.sandbox/src"
SPUTNIK_REV="5434a59dec23ee0c49df8c8c4350c208a7e75b0b"
mkdir -p "$WASM" "$SRC"

if [ -s "$WASM/sputnikdao2.wasm" ] && [ -s "$WASM/sputnikdao_factory2.wasm" ]; then
  echo "Sputnik is already built in $WASM"
  exit 0
fi
[ -d "$SRC/sputnik/.git" ] || git clone -q https://github.com/near-daos/sputnik-dao-contract "$SRC/sputnik"
git -C "$SRC/sputnik" checkout -q "$SPUTNIK_REV"
rm -f "$SRC/sputnik/rust-toolchain.toml"
# The same near-sdk as Orbits, so it builds with today's Rust for NEAR's current protocol.
(cd "$SRC/sputnik" && cargo update -q -p near-sdk -p near-contract-standards --precise 5.29.1)
for c in sputnikdao2 sputnikdao-factory2; do (cd "$SRC/sputnik/$c" && cargo near build non-reproducible-wasm); done
cp "$SRC"/sputnik/target/near/*/*.wasm "$WASM/"
echo "Built sputnikdao2.wasm and sputnikdao_factory2.wasm into $WASM"
