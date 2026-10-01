#!/usr/bin/env sh
# Assemble l'application dans dist/ (fichiers à la racine) puis crée le zip.
#
# Variables d'environnement facultatives :
#   BUILD_DATE  date et heure de génération (par défaut : maintenant, heure de Paris)
#   ZIP_NAME    nom du zip (par défaut : virtualpunaise_<date>.zip)
set -eu
cd "$(dirname "$0")/.."

BUILD_DATE="${BUILD_DATE:-$(TZ=Europe/Paris date '+%Y-%m-%d %H:%M:%S %Z')}"
STAMP="$(echo "$BUILD_DATE" | sed -E 's/^([0-9-]+) ([0-9]+):([0-9]+).*/\1_\2h\3/')"
ZIP_NAME="${ZIP_NAME:-virtualpunaise_${STAMP}.zip}"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo inconnu)"

rm -rf dist
mkdir -p dist
cp -R index.html css js README.md dist/

# Date de génération : affichée dans la page et écrite dans version.txt.
cat > dist/js/build-info.js <<JS
// Fichier généré par scripts/package.sh
export const BUILD_INFO = { date: '${BUILD_DATE}', commit: '${COMMIT}' };
JS
printf 'VirtualPunaise\nGénéré le : %s\nCommit : %s\n' "$BUILD_DATE" "$COMMIT" > dist/version.txt

rm -f "$ZIP_NAME"
(cd dist && zip -qr "../$ZIP_NAME" .)
echo "$ZIP_NAME"
