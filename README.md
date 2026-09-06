# Find a Cig 🚬📍

Compteur de déchets géolocalisé, piloté par une **Poké Ball Plus** : chaque appui
sur le bouton du dessus marque la position GPS d'un mégot repéré au sol.
Cartographie (OpenStreetMap) et statistiques temporelles intégrées.

**App live : <https://jcotineau.github.io/find-a-cig/>**

## Contenu du repo

| Dossier | Description |
|---|---|
| [`app/`](app/) | La PWA (Web Bluetooth + Geolocation + IndexedDB + Leaflet) — voir son [README](app/README.md) |
| [`pokeball-plus/`](pokeball-plus/) | Outillage Python (`bleak`) pour sniffer le protocole BLE de la ball |

## Démarrage rapide

1. Ouvrir l'app dans **Chrome/Edge** (macOS ou Android — Safari/iOS n'a pas Web Bluetooth).
2. Appuyer sur le bouton du dessus de la Poké Ball Plus (LED blanche clignotante).
3. « Connecter la ball » → choisir **Pokemon PBP**.
4. « Démarrer une session », autoriser la géolocalisation, et marquer chaque mégot
   d'un appui sur la ball.

## Protocole Poké Ball Plus (reverse engineering communautaire)

- BLE, advertise sous le nom `Pokemon PBP`
- Notifications d'input : characteristic `6675e16c-f36d-4567-bb55-6b51e27a23e6`
  (17 octets : compteur, boutons, stick X/Y, IMU 6× int16 LE)
- Vibration / LED / haut-parleur : non reversés (certification propriétaire)

Crédits : [pokeball-plus-4-windows](https://github.com/rna0/pokeball-plus-4-windows),
[pokeball-plus-mouse](https://github.com/TwinPeaksTownie/pokeball-plus-mouse),
[PokeBall-Plus-Controller-Driver-App-Mac](https://github.com/bmyhny/PokeBall-Plus-Controller-Driver-App-Mac).

## Licence

MIT — projet personnel, non affilié à Nintendo / The Pokémon Company.
