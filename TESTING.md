# Checklist de test — Find a Cig

Merci de tester 🙏 ! Ouvre l'app dans **Chrome ou Edge** (Android ou ordinateur —
pas Safari/iPhone, qui n'a pas le Bluetooth web).

- **Environnement de test (dev)** : https://jcotineau.github.io/find-a-cig/dev/  ← utilise **celui-ci** pour tester
- Version stable (prod) : https://jcotineau.github.io/find-a-cig/

En haut à gauche, un badge **DEV** (orange) confirme que tu es sur la version de test.
Pour installer l'app : menu du navigateur → « Ajouter à l'écran d'accueil ».

> Si tu vois un comportement bizarre, note **ce que tu faisais**, **ton téléphone/navigateur**,
> et une capture d'écran si possible.

## 1. Session & comptage
- [ ] Démarrer une session **Détection**, marquer quelques mégots avec le gros bouton `+1`.
- [ ] Le compteur monte, un bip + vibration se déclenchent.
- [ ] « Annuler le dernier » décrémente bien.
- [ ] Refaire une session en mode **Collecte** — le vocabulaire passe à « ramassés ».
- [ ] Terminer la session.

## 2. Déclencheurs sans la ball (optionnel)
- [ ] Poké Ball Plus : bouton du dessus = +1 (voir README pour l'appairage).
- [ ] Télécommande photo Bluetooth (~5 €) : une touche = +1.

## 3. GPS
- [ ] Autoriser la localisation ; attendre le statut **vert** (≤ 15 m) avant de marquer.
- [ ] Vérifier que les points marqués ont une position (onglet Carte → Mes points).
- [ ] Note : garde l'app ouverte, écran allumé (le suivi se met en pause sinon).

## 4. Carte, Stats, Historique
- [ ] Onglet **Carte → Mes points** : tes points + ton trajet s'affichent.
- [ ] Onglet **Stats** : détectés / ramassés, graphiques par heure/jour, temps entre mégots.
- [ ] Onglet **Historique** : renommer une session, en supprimer une.

## 5. Carte de la ville (communautaire)
- [ ] Onglet **Carte → Carte de la ville**.
- [ ] **Contribuer mes données** → lire le consentement → Confirmer.
- [ ] Déplacer/zoomer la carte : les points se rechargent pour la zone visible.
- [ ] Une zone n'apparaît qu'à partir de **2 contributeurs** différents — donc à
      plusieurs, allez marquer une même rue pour la faire apparaître !

## Ce qu'on veut savoir
- Est-ce **fluide** et **clair** à l'usage sur le terrain ?
- La **précision GPS** est-elle correcte chez toi ?
- Un nom mieux que « Find a Cig » ? (suggestions bienvenues)
