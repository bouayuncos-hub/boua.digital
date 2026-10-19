# Bouadigital SaaS — guide d'installation

Tout se fait depuis les consoles web (Firebase, Stripe, GitHub, Vercel). Aucune ligne de commande.

## Les fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page commerciale : présentation, tarifs, bouton « Essai gratuit » |
| `app.html` | L'application : inscription, entreprise, missions, GPS, CMR, factures, devis, bourse de fret, équipe, abonnement |
| `client.html` | Page publique de chaque transporteur : suivi par code + demande de devis (`client.html?c=ID_ENTREPRISE`) |
| `firestore.rules` | Règles de sécurité : chaque entreprise ne voit que ses données |
| `storage.rules` | Règles des fichiers : documents scannés visibles seulement par l'entreprise |
| `api/deca.js` | Fonction serveur Node.js : génère le PDF DeCA avec QR code et l'enregistre |
| `package.json`, `vercel.json` | Dépendances et réglages de la fonction serveur (Vercel les lit tout seul) |
| `kit-digital.html` | Page Kit Digital (solutions éligibles, montants du Bono Digital) |
| `manifest.json`, `sw.js`, `icons/` | Application installable : bouton « Installer », icône, fonctionnement hors ligne |

**Structure exacte à avoir sur GitHub** (les dossiers `api` et `icons` sont obligatoires) :

```
index.html  app.html  client.html  kit-digital.html
manifest.json  sw.js  package.json  vercel.json
api/deca.js
icons/icon-192.png  icons/icon-512.png  icons/icon-maskable-512.png
icons/apple-touch-icon.png  icons/favicon-32.png  icons/icon.svg
```

Pour envoyer les dossiers : décompressez le ZIP sur l'ordinateur, puis, sur GitHub → **Add file → Upload files**, glissez **tout le contenu** (fichiers ET dossiers) depuis Chrome ou Edge. Ou créez chaque fichier avec **Add file → Create new file** en tapant `api/deca.js`, `icons/…`.

**Nouvelle version du site** : dans `sw.js`, changez la ligne `VERSION` (ex. `bd-2026-10-20-1`). Les utilisateurs verront « Une nouvelle version est disponible → Mettre à jour ».

---

## 1. Firebase (projet dédié)

1. Console Firebase → **Créer un projet** `bouadigital`.
2. **Authentication** → Méthode de connexion → activer **E-mail/Mot de passe**.
3. **Firestore Database** → Créer → région **europe-southwest1 (Madrid)** ou `eur3` (RGPD).
4. Paramètres du projet → **Vos applications** → ajouter une application Web → copier la config.
5. Coller la config à la place des `REPLACE_ME` dans **`app.html`** et **`client.html`** (bloc `firebaseConfig`).
6. **Firestore → Règles** → coller tout le contenu de `firestore.rules` → **Publier**.
7. **Authentication → Paramètres → Domaines autorisés** → ajouter votre domaine Vercel (ex. `bouadigital.vercel.app`).

À ce stade, l'essai gratuit de 30 jours fonctionne déjà, sans Stripe.

## 1 bis. Documents de voyage et DeCA

**Stockage des scans (Firebase Storage)**
1. Firebase → **Storage** → Commencer → même région que Firestore. Le stockage demande le **forfait Blaze** (nécessaire aussi pour Stripe ; gratuit jusqu'à 5 Go environ).
2. **Storage → Règles** → coller `storage.rules` → **Publier** → accepter l'autorisation d'accès à Firestore.
3. Vérifier que `storageBucket` dans la config de `app.html` correspond au nom affiché en haut de la page Storage (souvent `bouadigital.firebasestorage.app`).

**Fonction serveur DeCA (Vercel)**
1. Firebase → Paramètres du projet → **Comptes de service** → **Générer une nouvelle clé privée** (un fichier JSON se télécharge). Ne le mettez **jamais** sur GitHub.
2. Vercel → votre projet → **Settings → Environment Variables** :
   - `FIREBASE_SERVICE_ACCOUNT` = tout le contenu du fichier JSON (copier-coller tel quel)
   - `FIREBASE_STORAGE_BUCKET` = le nom du bucket (ex. `bouadigital.firebasestorage.app`)
3. Glisser `api/deca.js`, `package.json` et `vercel.json` dans le dépôt GitHub → Vercel installe et déploie la fonction tout seul.
4. Réglages de l'entreprise : renseigner le **NIF/CIF** (obligatoire sur le DeCA).

**Utilisation** : onglet **Documents** → pour chaque mission : 📷 Photographier ou 📁 Fichier (photo ou PDF), **Générer le DeCA**, **Afficher le QR** (plein écran, fond blanc, écran maintenu allumé), **Envoyer** (WhatsApp, SMS, email, partage).

**Sans blocage** :
- le QR du DeCA s'affiche même sans réseau (il est recalculé sur le téléphone) ;
- si le serveur ne répond pas, l'application propose **Réessayer** ou **Imprimer la version locale** (QR contenant les données du transport) ;
- les photos sont compressées avant l'envoi et l'envoi reprend tout seul pendant 1 h si le réseau coupe.

## 2. Stripe (paiement des abonnements)

1. Créer un compte Stripe, rester en **mode Test** au début.
2. **Catalogue de produits** → créer 2 produits avec un prix **mensuel récurrent** :
   - **Solo** — 49 € / mois — dans *Métadonnées du produit* : `firebaseRole` = `solo`
   - **Flotte** — 129 € / mois — métadonnée : `firebaseRole` = `flotte`
   La métadonnée est **obligatoire** : c'est elle qui active la bonne formule.
3. Copier les deux **ID de prix** (`price_…`) dans `app.html`, bloc `STRIPE`.
4. Stripe → Paramètres → **Portail client** → activer (gestion de carte, factures, résiliation).
5. Firebase → passer le projet en **forfait Blaze** (paiement à l'usage ; quasi gratuit au début).
6. Firebase → **Extensions** → installer **« Run Payments with Stripe »** :
   - Région Cloud Functions : `europe-west1` (même valeur que `functionsRegion` dans `app.html`)
   - Collection clients : `customers` · Collection produits : `products`
   - Clé API Stripe : une clé **restreinte** (l'extension indique les droits nécessaires)
7. Une fois installée, l'extension affiche une **URL de webhook** et une liste d'événements : les ajouter dans Stripe → Développeurs → Webhooks, puis recopier le **secret de signature** dans la configuration de l'extension.
8. Tester avec la carte `4242 4242 4242 4242`. Quand tout marche, refaire les étapes 2 à 7 en **mode Live**.

## 3. Mise en ligne (GitHub → Vercel)

1. Glisser-déposer `index.html`, `app.html`, `client.html` dans le dépôt GitHub. Vous pouvez aussi y mettre `README.md` et `firestore.rules` : le site ne les utilise pas.
2. Dans `manifest.json`, mettre `"start_url": "/app.html"` pour que l'application installée s'ouvre directement sur l'espace de travail.
3. Dans `sw.js`, **changer le nom/version du cache** pour forcer la mise à jour, et vérifier qu'il ne met pas en cache les requêtes vers `firestore.googleapis.com`.

## 4. Vérifications avant d'ouvrir au public

- [ ] Documents : photographier un albarán depuis le téléphone → il apparaît sous la mission
- [ ] Générer un DeCA → le PDF s'ouvre et son QR, scanné avec un autre téléphone, télécharge le même PDF
- [ ] Mode avion → Afficher le QR fonctionne toujours
- [ ] Créer un compte → l'entreprise apparaît avec 30 jours d'essai
- [ ] Créer une mission → copier le lien de suivi → l'ouvrir en navigation privée
- [ ] Sur un téléphone : Démarrer le trajet → partager la position → la position apparaît sur le lien client
- [ ] Marquer livrée avec signature → la facture est créée et s'imprime
- [ ] Inviter un chauffeur (code) → il ne voit que ses missions
- [ ] Créer un 2ᵉ compte entreprise → il ne voit **aucune** donnée de la première
- [ ] Payer en mode Test → la formule passe à Solo/Flotte dans « Abonnement »
- [ ] Envoyer une demande de devis depuis `client.html?c=…` → elle arrive dans « Devis reçus »

## 5. Avant de vendre (important)

- **Veri\*factu (Espagne)** : un logiciel qui émet des factures pour des entreprises espagnoles doit respecter le règlement des systèmes de facturation (Real Decreto 1007/2023). Faites valider le module factures par un gestor/asesor avant de le commercialiser, ou présentez-le comme « brouillon de facture » en attendant.
- **RGPD** : rédiger CGU, politique de confidentialité et un contrat de traitement des données (vous hébergez les données des clients de vos clients).
- **Mentions légales** sur `index.html` (nom, NIF, adresse de l'éditeur).
- **DeCA** : le document reprend les données exigées par l'Orden FOM/2861/2012 (cargador, transportista, origen, destino, mercancía, peso, matrícula). Faites vérifier le modèle par votre gestoría ou une asociación de transportistas avant de le proposer à vos clients.

## Limites connues de cette version

- Le GPS n'envoie la position que lorsque l'application est **ouverte** sur le téléphone du chauffeur (limite des applications web ; l'écran est maintenu allumé). Pour un suivi en arrière-plan, il faudra l'app Android native.
- La limite de chauffeurs par formule est contrôlée dans l'application, pas encore dans les règles.
- Un seul responsable par entreprise ; pas encore de suppression de compte en libre-service.
- Le formulaire de devis public peut recevoir du spam : activer **Firebase App Check** plus tard.
