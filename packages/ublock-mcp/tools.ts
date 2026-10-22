import { z } from "zod/v4";

const hostname = z.string().min(1).max(253);
const selectors = z.array(z.string().min(1).max(4096)).min(1).max(100);
const tab = { tabId: z.number().int().nonnegative(), url: z.string().url() };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const setting = z.enum([
  "autoReload",
  "showBlockedCount",
  "strictBlockMode",
  "popupBlockMode",
  "developerMode",
]);
const ruleKind = z.enum(["sandbox", "dnr"]);
export const tools = [
  [
    "filters_list",
    "Lit les filtres cosmétiques natifs, éventuellement d'un domaine exact.",
    { hostname: hostname.optional() },
  ],
  [
    "filters_add",
    "Ajoute des sélecteurs cosmétiques CSS ou procéduraux permanents pour ce domaine et ses sous-domaines. Relit la persistance. Recharger pour appliquer.",
    { hostname, selectors },
  ],
  [
    "filters_remove",
    "Retire seulement les sélecteurs du domaine exact, sans modifier ceux de ses parents. Recharger pour appliquer.",
    { hostname, selectors },
  ],
  [
    "tabs_list",
    "Liste les onglets HTTP(S) non privés pour choisir une cible explicite.",
    {},
  ],
  [
    "elements_inspect",
    "Compte et décrit les éléments CSS de l'onglet ciblé, sans lire les champs de formulaire. URL attendue obligatoire.",
    { ...tab, selector: z.string().min(1).max(4096) },
  ],
  [
    "tab_reload",
    "Recharge uniquement l'onglet HTTP(S) dont l'URL correspond exactement. L'acquittement ne prouve pas la fin du chargement.",
    tab,
  ],
  [
    "settings_get",
    "Lit les paramètres globaux, capacités et permissions actuelles, sans secrets.",
    {},
  ],
  [
    "setting_set",
    "Modifie un paramètre global natif et vérifie sa persistance.",
    { name: setting, value: z.boolean() },
  ],
  [
    "filtering_get",
    "Lit les modes par domaine, le mode par défaut et le mode effectif d'un domaine facultatif.",
    { hostname: hostname.optional() },
  ],
  [
    "filtering_set",
    "Définit le mode d'un domaine, ou le défaut sans hostname : 0 désactivé, 1 basique, 2 optimal, 3 complet. Ne peut pas accorder les permissions navigateur.",
    { hostname: hostname.optional(), level: z.number().int().min(0).max(3) },
  ],
  [
    "rulesets_list",
    "Liste les listes natives et importées et leurs états d'activation.",
    {},
  ],
  [
    "rulesets_set",
    "Remplace les listes activées, après vérification du hash retourné par rulesets_list. Ne télécharge pas de nouvelle URL.",
    { ids: z.array(z.string().min(1).max(2048)).max(200), expectedHash: hash },
  ],
  [
    "list_import",
    "Importe une liste HTTP(S) par son URL dans le moteur natif, puis vérifie son activation et rapporte ses compteurs.",
    { url: z.string().url().max(2048) },
  ],
  [
    "list_remove",
    "Désactive et retire une liste importée par son URL exacte, sans modifier les autres listes.",
    { url: z.string().url().max(2048) },
  ],
  [
    "lists_update",
    "Demande au moteur natif la mise à jour des listes importées et rapporte l'état relu.",
    {},
  ],
  [
    "rules_get",
    "Lit l'éditeur de filtres utilisateur (sandbox) ou de règles réseau avancées (dnr), son hash et les règles effectives.",
    { kind: ruleKind },
  ],
  [
    "rules_set",
    "Remplace le texte d'un éditeur natif après validation et contrôle du hash. Sauvegarde avant mutation ; toute erreur de compilation reste une erreur, même si le texte est enregistré.",
    { kind: ruleKind, text: z.string().max(1000000), expectedHash: hash },
  ],
  [
    "configuration_get",
    "Exporte la configuration native complète et son hash, sans tokens MCP/OAuth.",
    {},
  ],
  [
    "configuration_set",
    "Restaure une configuration native complète après contrôle du hash courant. Sauvegarde locale préalable ; ne recharge aucun onglet.",
    { snapshot: z.json(), expectedHash: hash },
  ],
  [
    "configuration_backups",
    "Lit les sauvegardes locales créées avant les remplacements MCP (maximum trois).",
    {},
  ],
  [
    "strictblock_get",
    "Lit les exceptions au blocage strict, permanentes et de session.",
    {},
  ],
  [
    "strictblock_set",
    "Ajoute ou retire une exception exacte au blocage strict et reconstruit les règles natives.",
    {
      hostname,
      scope: z.enum(["permanent", "session"]),
      excluded: z.boolean(),
    },
  ],
  [
    "diagnostics_get",
    "Lit les capacités, règles actives, scripts enregistrés et journal natif pour vérifier l'application des réglages.",
    {},
  ],
  [
    "sync_get",
    "Lit l'état de synchronisation Drive, sa configuration et le dernier résultat sans identifiants OAuth.",
    {},
  ],
  [
    "sync_configure",
    "Active ou désactive la synchronisation Drive automatique. Ne lance pas le consentement Google.",
    { enabled: z.boolean() },
  ],
  [
    "sync_run",
    "Synchronise ou publie/restaure explicitement les réglages Drive. upload choisit le local comme référence ; download restaure une version distante. Nécessite une connexion Google préalable.",
    {
      mode: z.enum(["sync", "upload", "download"]),
      revision: z.string().max(128).optional(),
    },
  ],
] as const;
