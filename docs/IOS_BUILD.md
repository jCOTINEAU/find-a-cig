# Build iOS (local, sur Mac)

Le projet iOS Capacitor est scaffoldé dans `ios/`. Contrairement à Android (APK
buildé en CI et installable par lien), iOS impose la chaîne Apple.

## Prérequis (une fois)
1. **Xcode** complet (App Store, ~7 Go) — pas seulement les Command Line Tools.
   Puis : `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
2. **CocoaPods** : `brew install cocoapods`
3. **Node deps** : `npm install --registry https://registry.npmjs.org/`

## Builder / installer sur un iPhone (Apple ID gratuit)
```bash
npm install --registry https://registry.npmjs.org/
# Injecter la config Supabase dev (sinon carte de ville désactivée) :
printf "export const SUPABASE_URL='...';\nexport const SUPABASE_ANON_KEY='...';\nexport const ENV='dev';\n" > app/config.js
npx cap sync ios          # copie l'app + installe les pods (BLE, background-geo)
npx cap open ios          # ouvre Xcode
```
Dans Xcode :
1. Cible **App** → onglet **Signing & Capabilities** → coche *Automatically manage
   signing* → sélectionne ton **équipe personnelle** (ton Apple ID gratuit).
2. Branche l'iPhone en USB, choisis-le comme destination, **Run** (▶).
3. Sur l'iPhone : Réglages → Général → VPN et gestion de l'appareil → **fais
   confiance** à ton certificat développeur.

⚠️ Avec un Apple ID **gratuit**, l'app **expire après 7 jours** — il faut rebrancher
et relancer depuis Xcode pour la renouveler. Un compte **Apple Developer (99 €/an)**
débloque **TestFlight** (installation par lien, 90 jours, mises à jour auto).

## Permissions déjà configurées (`ios/App/App/Info.plist`)
- Localisation (when-in-use + always) → GPS de fond.
- Bluetooth → Poké Ball.
- `UIBackgroundModes` : `location`, `bluetooth-central` → exécution en fond.

## Limites iOS connues
- **Web Bluetooth absent de Safari** → la ball ne marche QUE dans l'app native
  (pas dans la PWA iOS).
- BLE en arrière-plan iOS plus restreint qu'Android (scan throttlé, pas de filtre
  par nom en fond) — à valider.
