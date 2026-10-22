# uBOL Extended

Fork indépendant de uBlock Origin Lite (uBOL) **2026.1021.1354**, avec moteur et stockage de filtres natifs. L’archive de Chrome reste intacte et ses fichiers sont vérifiés par SHA256 au build. Les modifications sont dans [les sources locales](../packages/ublock-extension/). La licence GPL et les crédits amont sont conservés ; ce fork est publié indépendamment sous GPL-3.0-or-later.

## Construire et installer dans Chrome

1. Exécuter `bun run build:ublock` dans le workspace.
2. Exporter les réglages de la version Store depuis son tableau de bord.
3. Charger le dossier généré `extensions/ublock-lite` comme extension non empaquetée, puis importer la sauvegarde native.
4. Désactiver l’autre bloqueur avant d’utiliser le fork ; ne pas supprimer sa configuration avant validation du fork.
5. Recharger le fork après chaque nouveau build.

L’identité du fork vient de la clé publique stable dans [fork.json](../packages/ublock-extension/fork.json). Aucune clé privée n’est distribuée. La version Store ne met pas ce fork à jour.

## MCP

Le tableau de bord contient l’onglet **MCP**, avec le même panneau que Tampermonkey : activation enregistrée immédiatement, host fixe `127.0.0.1`, port par défaut **17374**, token masqué, afficher/copier/régénérer et Enregistrer. Le pont reste désactivé jusqu’à configuration. Le port diffère de Tampermonkey pour permettre leur utilisation simultanée.

1. Générer un token dans le panneau, le conserver dans Keychain avec `creds set browser-extensions/dev/ublock-mcp-token`, puis l’enregistrer dans le panneau.
2. Relever l’ID du fork dans les détails Chrome ; utiliser cet ID pour `UBOL_EXTENSION_ID` si le serveur est lancé manuellement.
3. Démarrer le serveur avec `UBOL_MCP_TOKEN` injecté depuis Keychain, `UBOL_MCP_PORT=17374` et `UBOL_EXTENSION_ID`. Le serveur Node est [main.ts](../packages/ublock-mcp/main.ts).

Configuration Codex à ajouter après chargement et configuration du fork :

```toml
[mcp_servers.ubol-extended]
url = "http://127.0.0.1:17374/mcp"
http_headers_helper = "/opt/homebrew/bin/node /CHEMIN/ABSOLU/ubol-extended/scripts/ublock-codex-headers.ts"
startup_timeout_sec = 20
tool_timeout_sec = 90
```

Le helper charge le token depuis Keychain, déduit l’ID de la clé publique du fork et démarre le serveur local au besoin. Il ne faut pas le lancer directement dans un terminal sans capturer stdout, qui contient le header destiné au client MCP. Aucun secret ne figure dans la configuration Codex. Après ajout ou évolution des outils, recharger le fork et redémarrer le serveur et les MCP du client.

| Outil | Effet |
|---|---|
| `filters_list` | Lire les sélecteurs natifs, tous ou d’un domaine exact. |
| `filters_add` | Ajouter des filtres cosmétiques CSS ou procéduraux permanents pour un domaine et ses sous-domaines ; relire la persistance. |
| `filters_remove` | Retirer les sélecteurs du seul domaine propriétaire, sans toucher les parents. |
| `tabs_list` | Choisir explicitement un onglet HTTP(S) hors navigation privée. |
| `elements_inspect` | Compter les éléments visés et lire leurs balises/classes/visibilité, sans lire les champs ou le texte. |
| `tab_reload` | Demander le rechargement de l’onglet dont l’URL correspond exactement. |

Le MCP expose aussi les réglages disponibles dans le tableau de bord natif :

| Outils | Paramètres pilotables |
|---|---|
| `settings_get`, `setting_set` | Rechargement automatique, compteur de blocages, blocage strict, pop-ups et mode développeur. |
| `filtering_get`, `filtering_set` | Mode par défaut et modes par domaine : désactivé, basique, optimal, complet. |
| `rulesets_list`, `rulesets_set` | Listes intégrées et importées : inventaire et activation. |
| `list_import`, `list_remove`, `lists_update` | Import HTTP(S), retrait et mise à jour des listes externes. |
| `rules_get`, `rules_set` | Texte des filtres utilisateur, dont les scriptlets natifs, et éditeur DNR avancé. |
| `configuration_get`, `configuration_set`, `configuration_backups` | Export/restauration des réglages natifs et trois sauvegardes de récupération. |
| `strictblock_get`, `strictblock_set` | Exceptions exactes au blocage strict, permanentes ou de session. |
| `diagnostics_get` | Capacités, règles réseau effectives, scripts enregistrés et journal natif. |
| `sync_get`, `sync_configure`, `sync_run` | État Drive, activation automatique et synchronisation/publication/restauration. |

Les remplacements de listes, d’éditeurs et de configuration nécessitent le `expectedHash` retourné par la lecture correspondante. Une modification concurrente détectée bloque le remplacement. Avant un remplacement, le MCP conserve une sauvegarde récupérable via `configuration_backups`, incluant le registre des listes importées ; restaurer sa propriété `snapshot` avec `configuration_set` et le hash courant. Les restaurations MCP conservent les listes importées désactivées ; utiliser `list_remove` pour les retirer explicitement. Les textes des deux éditeurs sont validés avant restauration. Une erreur de compilation ou d’application réseau est rapportée même si le texte a été enregistré. Le résultat distingue la persistance et la vérification de l’effet navigateur ; inspecter les diagnostics et la page après rechargement.

Le MCP utilise les parseurs et le moteur natifs ; il ne propose pas une évaluation JavaScript générale. Les scriptlets passent par l’éditeur natif et nécessitent les permissions de scripts utilisateur. Les tokens MCP/OAuth et les consentements navigateur/Google restent locaux et ne sont pas exposés par les outils. Pour les compilations/imports pouvant durer jusqu’à une minute, le serveur uBlock attend au plus 75 secondes ; le client doit autoriser 90 secondes par outil.

Les filtres s’appliquent après rechargement et restent éditables dans le tableau de bord natif. Une erreur de délai ou de connexion ne déclenche aucun rejeu automatique de mutation : relire avant de recommencer.

## Google Drive

Le tableau de bord contient **Google Drive**. Le premier raccordement demande de choisir explicitement **Publier les réglages de cet appareil** ou **Restaurer depuis Drive** si les deux configurations diffèrent. La synchronisation automatique est désactivée par défaut, avec intervalle de 15 minutes lorsqu’elle est activée et que le navigateur le permet.

- Les sauvegardes utilisent le format natif : filtres cosmétiques, règles personnalisées, listes sélectionnées/importées, modes de filtrage par domaine et réglages de blocage.
- Les tokens MCP/OAuth, le port local et les identifiants de l’appareil sont exclus. Les autorisations de sites accordées par le navigateur restent propres à chaque appareil.
- Chaque publication ajoute une révision immuable dans `appDataFolder`. Une divergence locale/distante provoque un conflit. Des publications simultanées conservent plusieurs versions ; choisir ensuite une version distante ou publier explicitement le local.
- Une restauration conserve la configuration locale précédente, téléchargeable depuis le panneau. Elle remplace la configuration, sans fusionner automatiquement les règles.
- Les réglages stockés dans Drive sont en JSON ; il n’y a pas de chiffrement de bout en bout ajouté par le fork. Les domaines de filtres peuvent révéler des centres d’intérêt.
- Les versions historiques sont conservées ; aucun nettoyage ou effacement Drive automatique n’est effectué.

### Configuration OAuth nécessaire

Il faut un projet Google Cloud propre à cette application, avec **Google Drive API** activée et le scope `https://www.googleapis.com/auth/drive.appdata`. Aucun identifiant Tampermonkey n’est réutilisé.

Pour Chrome, créer un client OAuth **Chrome Extension** associé à l’ID stable du fork. Placer son identifiant public dans le fichier local ignoré `ublock.config.json`, puis reconstruire :

```json
{"googleClientId":"IDENTIFIANT_DU_CLIENT.apps.googleusercontent.com"}
```

Sans cet identifiant, le panneau indique la configuration manquante et ne prétend pas être connecté. L’utilisateur effectue le consentement Google lors du premier raccordement. Aucun client secret n’est requis dans l’extension.

Pour l’iPhone, lire [le guide Safari/iOS](ublock-ios.md). Les deux clients OAuth doivent appartenir au **même projet Google** et utiliser le même compte pour accéder au même espace applicatif. Notre fork ne peut pas modifier les données privées d’une app uBlock installée depuis l’App Store.

Sources : lire [l’API Chrome Identity](https://developer.chrome.com/docs/extensions/reference/api/identity) et [le stockage applicatif Google Drive](https://developers.google.com/workspace/drive/api/guides/appdata).

## Validation et limites

Exécuter `bun run build`, `bun run check`, `bun run lint` et `bun test --timeout 10000`. Le build vérifie les empreintes de l’archive amont. Le test OAuth Swift nécessite macOS et les outils Xcode.

Les tests couvrent le transport MCP réel sous Node, la validation native CSS, la persistance ciblée, les erreurs et les conflits Drive avec API simulée. Le 22 octobre 2026, un essai réel dans Chrome a validé la connexion Google, l’envoi et la relecture d’une version Drive, puis la restauration d’un réglage local modifié (affichage du compteur) et sa persistance après rechargement. Une synchronisation suivante a retourné « unchanged ». OAuth reste en mode Test. Les échanges entre deux appareils et les alarmes de synchronisation restent non validés. Une compilation iOS ne prouve ni installation sur l’iPhone, ni consentement Google, ni synchronisation entre deux appareils.
