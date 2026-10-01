#!/usr/bin/env sh
# Assemble l'application dans dist/ (fichiers à la racine) puis crée virtualpunaise.zip.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist virtualpunaise.zip
mkdir -p dist
cp -R index.html css js README.md dist/
(cd dist && zip -qr ../virtualpunaise.zip .)
echo "dist/ et virtualpunaise.zip créés"
