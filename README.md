# VirtualPunaise

Simulateur physique de lancers de punaises (et de jetons) sur une table, sous forme de **site web statique**.

L'objectif est pédagogique (lycée) : estimer la probabilité qu'une punaise retombe
« sur le dos » (pointe en l'air) plutôt que « sur le côté » (pointe au sol) à l'aide
d'un grand nombre de lancers simulés, puis comparer ce résultat à une expérience
réelle menée en classe.

## Fonctionnalités

- **Vue 3D** d'une série de *n* lancers en temps réel (ralenti possible, enchaînement automatique).
- **Visualisation de la physique** pour l'objet suivi (cliquer sur un objet pour le choisir) :
  centre de masse et sa trajectoire, poids, réactions de la table aux points de contact
  (composantes normale et de frottement), vitesse, vitesse angulaire, points de l'enveloppe
  de contact ; pause, pas à pas (1 ms), caméra qui suit l'objet, mesures en direct et
  courbes d'énergie (potentielle, cinétique de translation et de rotation, totale).
- **Simulation rapide** de milliers de lancers en arrière-plan (Web Workers, calcul en parallèle).
- **Dimensions réglables** de la punaise (tête, pointe, matériau de la tête) et **mode jeton** (objet symétrique : pile / face / tranche).
- **Conditions de lancer réglables** : hauteur, rotation, vitesse horizontale, restitution, frottement.
- **Statistiques** : fréquence cumulée, intervalle de confiance, répartition des fréquences par série avec l'intervalle de fluctuation p ± 1/√n, export CSV.
- **Comparaison avec l'expérience réelle** : saisie des résultats par groupe d'élèves, intervalles de confiance, test de comparaison de deux proportions.

## Lancer le site

Le site n'a besoin d'aucune compilation, mais il utilise des modules JavaScript :
il doit être servi en HTTP (l'ouverture directe du fichier `index.html` ne fonctionne pas).

```sh
python3 -m http.server 8080
# ou
npm start
```

puis ouvrir <http://localhost:8080>. Il peut aussi être publié tel quel (GitHub Pages, etc.).
three.js est inclus dans `js/vendor/` : le site fonctionne sans accès à un CDN.

## Paquet zip et releases

Le workflow GitHub Actions `.github/workflows/package.yml` lance les tests puis assemble
l'application dans un zip contenant directement `index.html`, `css/`, `js/`… à sa racine.

- **Chaque push sur `main` publie une release GitHub** (tag `vAAAA.MM.JJ-HHMMSS`) avec le
  fichier `virtualpunaise_AAAA-MM-JJ_HHhMM.zip` : le nom du zip porte la date et l'heure
  de génération (heure de Paris).
- La date de génération figure aussi dans le zip (`version.txt`) et en bas de la page.
- Sur les autres branches et les pull requests, le zip est disponible comme artefact
  `virtualpunaise` de l'exécution du workflow (onglet *Actions*).

Pour utiliser une release : télécharger le zip, le décompresser, puis servir le dossier
(voir « Lancer le site »).

En local : `./scripts/package.sh` (nécessite `zip`).

## Modèle physique

Voir `js/physics.js` et `js/shapes.js`.

- L'objet est un **solide rigide** : masse, centre de masse et inertie sont calculés à
  partir des dimensions (tête et pointe modélisées par des cylindres, densités des matériaux).
- Pour le contact avec la table, seule l'**enveloppe convexe** compte : bords de la tête
  et extrémité de la pointe (punaise), bords des deux faces (jeton).
- Intégration à pas fixe (1 ms) ; le moment cinétique est conservé en repère monde,
  ce qui reproduit la précession d'un solide non sphérique.
- Contacts résolus par **impulsions séquentielles** : coefficient de restitution,
  frottement de Coulomb, légère résistance au roulement, correction de pénétration
  sans apport d'énergie (*split impulse*). Les contacts sont traités du plus enfoncé
  au moins enfoncé : un ordre fixe favoriserait toujours le même côté de l'objet.
- Nombres aléatoires : générateur sfc32 (128 bits d'état) avec des graines de 128 bits
  tirées par le générateur cryptographique du navigateur ; chaque calcul parallèle
  utilise sa propre suite.
- Conditions initiales aléatoires : orientation uniforme, rotation et vitesse horizontale aléatoires.
- Un objet immobile est classé selon l'orientation de son axe de symétrie.
- Les objets d'une même série ne se percutent pas entre eux (lancers indépendants).

La probabilité obtenue dépend des paramètres de contact (restitution, frottement) :
on peut les ajuster pour approcher les conditions réelles (type de table, hauteur de lâcher…).

## Tests

```sh
npm test
```

## Structure

```
index.html          page unique
css/style.css       mise en forme (thèmes clair/sombre)
js/shapes.js        géométrie, masses, inerties, classification des positions
js/physics.js       moteur de dynamique du solide contre un plan
js/stats.js         intervalles de confiance / fluctuation, test de proportions
js/worker.js        simulation en arrière-plan
js/viewer.js        rendu 3D (three.js)
js/overlays.js      visualisation des grandeurs physiques (forces, vitesses…)
js/charts.js        graphiques (canvas)
js/main.js          interface
js/build-info.js    date de génération (remplacé lors de la création du zip)
js/vendor/three/    three.js r170 (licence MIT)
tests/              tests Node.js
scripts/package.sh  assemblage du zip
.github/workflows/  intégration continue (tests + zip)
```
