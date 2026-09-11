# Plan — App Android native (GPS + BLE écran verrouillé)

> Objectif : une vraie app Android installable (`.apk`) qui **continue à logger le
> GPS et à recevoir les appuis de la Poké Ball même écran verrouillé / app en
> arrière-plan** — ce que la PWA ne peut pas faire (le WebView suspend GPS et JS
> au verrouillage, et n'a pas Web Bluetooth).
>
> Principe directeur : **on ne réécrit pas l'app**. Tout le code web actuel
> (UI, IndexedDB, carte, stats, Supabase) est réutilisé tel quel dans un WebView
> Capacitor. On ajoute une **couche native** pour le fond, et une **couche
> d'abstraction d'entrée** côté JS qui route vers les API web (PWA) ou les
> plugins natifs (APK) selon l'environnement.

## 1. La contrainte Android, en une phrase

Le seul mécanisme qui empêche Android de suspendre l'app écran verrouillé est un
**foreground service** (service de premier plan avec notification persistante,
type `location` + `connectedDevice`). Tout le reste en découle : le GPS de fond
et la connexion BLE doivent **vivre dans ce service**, pas dans le WebView.

## 2. Architecture cible

```
┌──────────────────────────────────────────────┐
│  WebView (app actuelle inchangée)              │
│  UI · IndexedDB · carte · stats · Supabase     │
│         ▲ événements            │ commandes     │
│         │ (fix GPS, appui)      ▼               │
│  ┌──────────────────────────────────────────┐  │
│  │  Couche d'abstraction d'entrée (JS)        │  │  ← nouveau, petit
│  │  isNative ? plugins Capacitor : API web    │  │
│  └──────────────────────────────────────────┘  │
└───────────────────────┼────────────────────────┘
                        │ pont Capacitor
┌───────────────────────▼────────────────────────┐
│  FOREGROUND SERVICE natif (notif persistante)   │  ← le cœur du chantier
│  • GPS continu  • connexion BLE Poké Ball        │
│  émet fix + appuis → WebView, même écran off     │
└─────────────────────────────────────────────────┘
```

## 3. Briques et plugins précis

| Brique | Plugin / techno | Notes |
|---|---|---|
| Conteneur natif | **Capacitor 6** (`@capacitor/core`, `/cli`, `/android`) | `webDir: app`, bundle offline |
| Service de premier plan | **`@capawesome-team/capacitor-android-foreground-service`** | notification obligatoire ; types `location` + `connectedDevice` |
| GPS de fond | **`@capacitor-community/background-geolocation`** | fixes continus, filtrage distance ; alimente la logique existante |
| BLE natif | **`@capacitor-community/bluetooth-le`** | remplace `navigator.bluetooth` ; re-porter le protocole Poké Ball (characteristic `6675e16c-…e6`, décodage octet 1) |
| Permissions | plugin permissions Capacitor | voir §4 |

## 4. Permissions & implications

- `ACCESS_FINE_LOCATION` **+ `ACCESS_BACKGROUND_LOCATION`** — l'utilisateur doit
  choisir explicitement « **Autoriser tout le temps** » (Android l'impose en 2
  étapes ; prévoir un écran d'explication avant la demande).
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` + `FOREGROUND_SERVICE_CONNECTED_DEVICE`.
- `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` (Android 12+), avec
  `neverForLocation` sur le scan si possible.
- `POST_NOTIFICATIONS` (Android 13+) pour la notif du service.
- **Play Store** : la localisation en arrière-plan déclenche un **formulaire de
  déclaration** et une revue renforcée. Pour un cercle de testeurs, on **installe
  l'APK directement** (hors Store) au début — pas de revue.

## 5. Refactor côté JS : couche d'abstraction d'entrée

Aujourd'hui l'app appelle directement `navigator.geolocation.watchPosition`
(`app.js`) et `navigator.bluetooth` (`ball.js`). On introduit deux petits
adaptateurs qui exposent la **même interface** et choisissent l'implémentation :

```js
// input/geo.js
export const geo = Capacitor.isNativePlatform()
  ? nativeBackgroundGeo   // plugin → foreground service
  : webGeo;               // navigator.geolocation (PWA, inchangé)

// input/ball.js  (même idée)
export const ball = Capacitor.isNativePlatform() ? nativeBle : webBle;
```

Le reste de l'app ne change pas : elle consomme `geo.watch(cb)` et
`ball.on('top', cb)` comme avant. **C'est le seul refactor du code existant.**

## 6. Le foreground service (cœur)

- Démarré au « Démarrer une session », arrêté à « Terminer ».
- Tient la notification « 🧹 Collecte en cours — N ramassés ».
- Héberge le watch GPS natif **et** la connexion BLE (les deux survivent au
  verrouillage tant que le service tourne).
- Repousse chaque fix / appui vers le WebView via un événement Capacitor ; la
  logique existante (marquage, affinage, trajet, IndexedDB) tourne au réveil du
  WebView, ou on bufferise côté natif si le WebView est gelé (à décider en §8).

> Point d'attention : quand l'écran est verrouillé, **le WebView lui aussi peut
> être gelé**. Deux stratégies : (a) le service natif bufferise les événements et
> les rejoue au déverrouillage ; (b) on déporte l'écriture (IndexedDB → SQLite
> natif) dans le service. (a) est plus simple pour la v1.

## 7. Build & distribution

- Workflow CI **manuel** (`workflow_dispatch`) : setup Node/Java, scaffold
  Capacitor, `cap sync`, `gradlew assembleDebug`, artefact `.apk`.
- **Signature** : debug pour les tests ; keystore de release (secret GitHub) pour
  une version installable durablement.
- Distribution testeurs : lien de téléchargement de l'APK (hors Play Store).

## 8. Phases

1. **Socle Capacitor** : APK offline qui charge l'app (sans fond). Valide le
   pipeline CI + install sur ton téléphone. *(petit)*
2. **Couche d'abstraction d'entrée** (§5) : l'app marche à l'identique en natif
   avec les API web tant que possible. *(petit)*
3. **Foreground service + GPS de fond** : GPS écran verrouillé qui marque des
   points. **C'est le jalon qui prouve l'objectif.** *(moyen)*
4. **BLE natif** : re-port du protocole Poké Ball dans le service ; appuis écran
   verrouillé. *(moyen-élevé)*
5. **Robustesse** : buffer d'événements, reprise après gel du WebView, batterie,
   permissions edge-cases, keystore de release. *(moyen)*

## 9. Risques

- **Gel du WebView écran verrouillé** → nécessite le buffer natif (§6). Principal
  inconnu ; à dérisquer tôt en phase 3.
- **Fabricants agressifs** (Xiaomi, Huawei…) tuent les services malgré tout →
  documenter les exceptions d'optimisation batterie.
- **Re-port BLE** : l'API du plugin diffère de Web Bluetooth ; le décodage est
  connu (on l'a reversé), le risque est l'appairage/reconnexion natifs.
- **Effort réel** : plusieurs sessions dédiées, avec Android Studio pour débugger
  le service. Ce n'est pas un « build minimal ».

---

**Reco de démarrage** : attaquer **phases 1 → 3** d'abord (socle + GPS de fond).
Si le GPS écran verrouillé marche et que le gel du WebView est gérable, le BLE
natif (phase 4) devient un ajout ciblé. On garde la PWA comme version principale
tant que le natif n'est pas solide.
