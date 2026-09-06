# Find a Cig 🚬📍

Mini PWA « compteur de déchets » : marque la position GPS de chaque mégot repéré
au sol, avec la **Poké Ball Plus** comme télécommande (bouton du dessus = +1),
puis cartographie et statistiques temporelles.

## Stack

- **Web Bluetooth** pour la ball (characteristic `6675e16c-…e6`, décodage boutons)
- **Geolocation API** (`watchPosition`, haute précision)
- **IndexedDB** — tout est stocké en local, rien ne quitte l'appareil
- **Leaflet 1.9.4** vendorisé (hash sha512 vérifié contre le registre npm, 0 advisory OSV)
- Service worker → fonctionne hors-ligne (sauf tuiles de carte)

## Compatibilité

| Plateforme | Statut |
|---|---|
| macOS Chrome / Edge | ✅ |
| Android Chrome / Edge | ✅ (installable en PWA) |
| Safari / iOS | ❌ pas de Web Bluetooth (le comptage manuel marche) |

## Lancer en local (macOS)

```bash
cd app
python3 -m http.server 8000
# → http://localhost:8000 dans Chrome (localhost = contexte sécurisé, Web Bluetooth OK)
```

## Utiliser sur Android

Web Bluetooth exige HTTPS (hors `localhost`). Deux options :

1. **Test rapide via adb** : téléphone branché en USB, débogage activé, puis
   `chrome://inspect` → *Port forwarding* → `8000 → localhost:8000`.
   Le téléphone voit alors `http://localhost:8000` = contexte sécurisé.
2. **Déploiement** : n'importe quel hébergeur statique HTTPS (GitHub Pages, etc.).
   Ensuite « Ajouter à l'écran d'accueil » pour l'installer en PWA.

## Utilisation

1. **Connecter la ball** (bouton du dessus de la ball → LED blanche → choisir
   « Pokemon PBP » dans le sélecteur Chrome).
2. **Démarrer une session** → autorise la géolocalisation.
3. À chaque mégot repéré : **bouton du dessus** de la ball (ou gros bouton à
   l'écran). Bip + vibration du téléphone en retour.
4. Onglets **Carte** (points OSM) et **Stats** (par heure, par jour, exports
   GeoJSON/CSV).

## Extension prévue

- Autres types de déchets : ajouter une entrée dans `TYPES` (`js/app.js`) et
  mapper le clic du stick (`ball.addEventListener('stick', …)`), déjà décodé.
- Vibration / haut-parleur de la ball : non reversé à ce jour ; piste = la
  characteristic `…e7` (write-without-response) du service d'input.
