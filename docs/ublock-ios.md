# uBOL Extended sur iPhone

Cette version ajoute une extension Safari via une petite app iOS ; elle ne modifie ni ne remplace Safari. Elle est distincte de l’app uBlock Origin Lite de l’App Store et n’accède pas à ses données privées.

## Préparer le projet

1. Compiler le fork Mac avec `bun run build:ublock` depuis la racine du dépôt.
2. Générer le projet avec `bun run scripts/build-ublock-ios.ts` ; ajouter `--build` pour compiler pour le simulateur iOS.
3. Ouvrir le projet Xcode indiqué par la commande, sélectionner l’iPhone connecté et l’équipe de signature, puis lancer l’app.
4. Dans Réglages → Apps → Safari → Extensions, activer **uBOL Extended** et autoriser l’accès aux sites concernés.

Le script part de l’archive **Safari officielle**, avec SHA256 épinglé, et conserve ses règles réseau et ses adaptations Safari. Il reprend les filtres natifs et les modules Drive du fork Mac. Le pont MCP loopback du Mac est absent de la version iPhone. Safari 18.6/iOS 18.6 minimum.

Les ressources et le projet Xcode sont générés dans `.claude/build/ublock-ios/` et ne sont pas des sources à éditer. Lis [les sources iOS](../packages/ublock-ios/) pour modifier l’app hôte et le gestionnaire natif. Lis [le script de construction](../scripts/build-ublock-ios.ts) pour reproduire la génération. La signature utilise l’identité locale validée de l’utilisateur ; une installation sur un iPhone requiert aussi le provisioning de cet appareil. Une compilation simulateur ne prouve pas cette installation.

## Connecter Google Drive

Les clients OAuth **Chrome** et **iOS** sont distincts, mais doivent appartenir au **même projet Google Cloud**, avec Drive API activée. Le compte Google doit être le même sur les deux appareils. L’espace `appDataFolder` est propre à l’application Google ; deux projets Google séparés ne partagent pas cette configuration.

1. Créer un client OAuth Google de type **iOS** pour le bundle `org.ubol.extended`.
2. Créer à la racine du dépôt le fichier local ignoré `ublock-ios.config.json`, contenant la propriété `googleClientId` avec l’identifiant de ce client iOS. Un client ID est public ; aucun client secret n’est utilisé ou demandé.
3. Reconstruire et réinstaller l’app. Le schéma de retour Google inversé est ajouté automatiquement à son Info.plist.
4. Ouvrir **uBOL Extended**, toucher **Connecter Google Drive** et accepter l’autorisation Google. L’app vérifie ensuite l’accès à son espace Drive avant d’afficher une connexion réussie.
5. Dans le tableau de bord de l’extension Safari, ouvrir **Google Drive**, puis restaurer la version publiée depuis le Mac.

Sans client OAuth iOS configuré, le bouton de connexion de l’app reste désactivé. L’app n’utilise pas le client OAuth de Tampermonkey. La connexion Google utilise `ASWebAuthenticationSession`, le flux authorization code avec PKCE et une vérification du `state` de retour. Les tokens sont stockés dans le trousseau partagé entre notre app et notre extension, sous le groupe `<TEAM_ID>.<BUNDLE_ID>.shared`, et ne sont pas synchronisés vers Drive. Une déconnexion efface seulement l’autorisation locale de cet iPhone ; elle ne révoque pas les autres appareils.

Le gestionnaire natif ne lance pas de connexion depuis l’arrière-plan : l’extension demande un token via `runtime.sendNativeMessage('local.ublock-lite', { type: 'driveToken' })`. Si l’autorisation manque ou ne peut plus être renouvelée, elle invite à rouvrir l’app. Les réglages cloud suivent le même format et les mêmes conflits que sur Mac. iOS peut suspendre l’extension ; la synchronisation manuelle depuis Safari reste nécessaire lorsque l’exécution en arrière-plan n’est pas disponible.

## État de validation

- Archive Safari officielle `2026.1021.1354` épinglée par SHA256 ; le convertisseur Apple génère le projet sans ouvrir ni modifier Safari.
- App et extension compilées pour simulateur iOS arm64, puis signées explicitement avec le certificat de développement attendu et vérifiées avec `codesign --verify --deep --strict`.
- Le module OAuth Swift utilisé par l’app est compilé et exécuté par le test d’intégration : callback valide accepté ; mauvais état, URL étrangère, mauvais chemin, paramètres dupliqués et erreur OAuth rejetés ; challenge PKCE comparé à une implémentation cryptographique indépendante.
- Xcode signe initialement les produits simulateur en ad hoc ; le script remplace cette signature avant d’enregistrer une preuve de signature réussie.
- Les avertissements du convertisseur concernent `background.type` et `background.persistent`, déjà présents dans le paquet Safari officiel. Ils n’établissent pas une validation du comportement dans Safari.
- Aucun iPhone personnel installé, aucune connexion Google ni synchronisation réelle Mac/iPhone vérifiée dans ce run. Aucun simulateur n’était démarré lors de l’inventaire ; seule la compilation et la signature ont été vérifiées.

Sources : consulte [la présentation Apple des extensions Safari](https://developer.apple.com/safari/extensions/), [les versions officielles de uBOL](https://github.com/uBlockOrigin/uBOL-home/releases), [les données privées d’application Google Drive](https://developers.google.com/workspace/drive/api/guides/appdata) et [OAuth pour apps mobiles](https://developers.google.com/identity/protocols/oauth2/native-app).
