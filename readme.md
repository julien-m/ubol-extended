# uBOL Extended

Fork indépendant de [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home), avec un serveur MCP local pour gérer les filtres et réglages, et une synchronisation des réglages via Google Drive.

Projet expérimental sous **GPL-3.0-or-later**, sans affiliation avec Raymond Hill, uBlock Origin, Google ou Tampermonkey. Base amont : **2026.1021.1354**. Aucun code Tampermonkey ou Poper Blocker n’est inclus dans ce dépôt.

## Construire et installer

Prérequis : Bun et Node.js ≥ 22.18. Le test OAuth Swift et la génération iOS nécessitent macOS et les outils Xcode.

```bash
bun install --frozen-lockfile
bun run build
bun run check
bun run lint
bun test
```

Dans Chrome, ouvrez `chrome://extensions`, activez le mode développeur, puis chargez le dossier généré `extensions/ublock-lite`. Cette version ne reçoit pas automatiquement les mises à jour du Chrome Web Store.

Les builds n’effacent pas les réglages du profil navigateur. Exportez néanmoins une sauvegarde depuis le tableau de bord avant de changer de version. Les ajouts du fork sont dans `packages/ublock-extension`, le transport MCP partagé dans `packages/mcp-server/server.ts`, et les outils dans `packages/ublock-mcp`.

## MCP et Google Drive

Lisez [le guide de configuration](docs/ublock-lite.md) pour activer le MCP authentifié sur loopback et configurer votre client. Le pont reste désactivé tant que vous ne l’activez pas. Utilisez votre propre token ; aucun token réel n’est livré.

**Drive nécessite un projet Google Cloud dédié, l’API Drive et votre propre client OAuth Chrome Extension.** Le bouton ne peut pas connecter un compte sans cette configuration. Définissez `googleClientId` dans le fichier local ignoré `ublock.config.json`, puis reconstruisez et rechargez l’extension. Aucun client secret n’est nécessaire. Le 22 octobre 2026, la connexion OAuth, l’envoi, la relecture et la restauration des réglages ont été vérifiés sur une installation Chrome réelle. Un réglage d’affichage modifié localement a été restauré depuis Drive et son retour a persisté après rechargement. La synchronisation a ensuite confirmé l’égalité des versions. Les échanges entre deux appareils, iOS et les déclenchements automatiques restent à valider. Le projet OAuth utilisé pour cet essai reste en mode Test ; ses identifiants locaux ne sont pas distribués.

- Synchroniser : transmet les modifications si un seul côté a changé ; refuse les conflits.
- Publier : choisit les réglages locaux comme nouvelle référence sur Drive.
- Restaurer : applique la version distante, avec sauvegarde locale préalable.

Les réglages sont stockés dans l’espace applicatif privé Drive, sans chiffrement de bout en bout ajouté. Les tokens MCP et OAuth ne sont pas synchronisés.

## Safari / iPhone

Lisez [le guide iOS expérimental](docs/ublock-ios.md). Les sources de l’app et de l’extension Safari sont présentes ; ce dépôt ne fournit pas d’app App Store. Pour générer le projet avec Xcode, définissez vos `bundleId`, `teamId` et `signingIdentity` dans le fichier ignoré `ublock-ios.config.json`. Aucune identité de signature personnelle n’est fournie. La génération et les tests locaux ne prouvent pas l’exécution sur un iPhone physique.

## Licence et provenance

Lisez [la licence GPL](LICENSE). Les ajouts de ce fork sont distribués sous GPL-3.0-or-later. Les avis de copyright et les licences tiers restent conservés dans l’archive amont. Celle-ci contient les fichiers livrés par uBOL ; les patchs sont appliqués au build et vérifiés avec les empreintes de provenance. Consultez [les instructions amont](upstream/ublock-lite/2026.1021.1354/README.md) pour reconstruire uBOL depuis ses sources officielles.

Cette publication initiale contient le code et les tests, sans jetons, paramètres personnels, sauvegardes de navigateur ni binaires iOS signés.
