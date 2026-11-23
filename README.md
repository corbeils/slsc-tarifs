# SLSC TARIFF SIMULATOR — simulateur de droits Canada ⇄ États-Unis

Simulateur auto-hébergé (dans l'esprit de tariffs.flexport.com) qui calcule, pour un code HTS / numéro tarifaire, une origine et une valeur :

- **le droit de base** : colonne 1 (NPF), colonne 2 (Cuba, Corée du Nord, Russie, Bélarus), ou taux préférentiel (ACEUM/USMCA/CUSMA et les autres ALE) ;
- **toutes les mesures additionnelles** :
  - **US** : Section 232 (autos, camions, métaux et dérivés, bois, semi-conducteurs, autres), 338 (Canada), 301 Chine, 301 « travail forcé » (60 économies), 201, plus toute autre rubrique 9903 détectée ;
  - **CA** : surtaxes visant les É.-U. (acier/alu, autos, 2025-1, 2026 à 15/25/50 %), surtaxes Chine, contingent tarifaire de l'acier, dérivés de l'acier, acier fondu et coulé en Chine ;
- **les exemptions** : ACEUM (9903.05.93), exclusion 232 (9903.05.90), aéronefs civils, faible teneur en métal, Annexe III, contenu US, remises canadiennes, régimes du ch. 98/99 (9801, 9802, TIB, 9971, 9992, 9993, drawback) ;
- **AD/CVD (US) et LMSI (CA)** : signalement des ordonnances, avec possibilité d'inclure le dépôt dans le calcul (bois d'œuvre résineux) ;
- **licences, permis et exigences des autres agences** : SIMA/AIM, FDA, USDA, EPA, NHTSA, FCC, TTB, Lacey Act… / LMIC (art. 82, GIP 80/81, gestion de l'offre, contingent VE chinois), ACIA, Santé Canada, Transports Canada, ECCC, RNCan ;
- **interdictions d'importation** (Section 338 du 29 sept. 2026) ;
- **frais et taxes** : MPF (min. 34,58 $ / max. 670,86 $ pour l'AF 2027, exemptée pour les marchandises ACEUM), HMF, TPS / TVH.

Le **mode lot** prend un fichier Excel/CSV (une liste de pièces de rechange, par exemple) et renvoie le même fichier enrichi des taux, mesures, alertes et licences.

---

## Déploiement

**Production (VPS)** : image construite automatiquement par GitHub Actions (`ghcr.io/corbeils/slsc-tarifs`, amd64 + arm64) et mise à jour par Watchtower. Voir **[docs/deploiement.md](docs/deploiement.md)** et `deploy/docker-compose.yml`.

**Local** (construction depuis les sources) :

```bash
cp .env.example .env
docker compose up -d --build  # http://localhost:8085
```

Au premier démarrage, l'application charge des **données de démonstration** (marquées `[DÉMO]`) pour qu'on puisse tester tout de suite. Un bandeau le rappelle tant que les tarifs officiels n'ont pas été importés.

Volumes :
- `./data` : base SQLite (tarifs, rubriques du ch. 99, listes de codes, taux de change)
- `./rules` : règles YAML (copiées au premier démarrage, puis jamais écrasées)

---

## Premier chargement des données officielles (page **Admin**)

| Étape | Action | Fréquence |
|---|---|---|
| 0. Connexion | Admin → compte **CORBEILS / admin**, puis changer le mot de passe dans *My account* | une fois |
| 1. HTSUS | **Importer en ligne** (USITC, 98 chapitres + ch. 99, ≈ 2–5 min) | automatique chaque lundi (`CRON_US`) |
| 2. Tarif canadien | Téléverser le fichier **Excel** du Tarif des douanes (format CARM publié par l'ASFC à partir du 1er déc. 2026) ou un CSV | à chaque modification du tarif (`CA_TARIFF_URL` pour automatiser) |
| 3. Taux USD/CAD | **Banque du Canada (Valet)** | automatique les jours ouvrables (`CRON_FX`) |
| 4. Listes des surtaxes canadiennes | Admin → *Listes de codes* : coller l'annexe du décret / de l'avis | à chaque nouveau décret |
| 5. (optionnel) Indicateurs PGA CBP, dossiers AD/CVD | CSV | au besoin |

### Pourquoi l'étape 4 ?

Côté US, l'USITC rattache chaque ligne aux rubriques 9903 qui la visent (notes de bas de page), et le taux de chaque rubrique se lit dans la colonne « General ». **Tout est donc automatique**, y compris les nouvelles rubriques que l'administration ajoute.

Côté Canada, les surtaxes sont définies par **décrets avec des annexes de numéros tarifaires** qui ne figurent pas dans le fichier du Tarif. Il faut donc importer ces listes. L'extracteur reconnaît tous les formats (`7208.10.00`, `72081000`, `7208.10.00.10`…) dans un texte collé ou une page web ; cochez « Lire le taux » pour une liste mixte à 15/25/50 %. Mesures à alimenter :

| Mesure (id) | Source de la liste |
|---|---|
| `CA-US-SA` (acier/alu É.-U., 50 % / 25 %) | Annexe du DORS/2025-95, modifié par DORS/2026-187 |
| `CA-US-AUTO` (véhicules É.-U.) | Décret de surtaxe (véhicules automobiles 2025) |
| `CA-US-2025-1` (25 %, biens non ACEUM) | Décret de surtaxe (2025-1) |
| `CA-US-2026-15`, `-25`, `-50` | DORS/2026-186 ; Avis des douanes 26-23 ; liste des Finances du 8 sept. 2026 |
| `CA-CN-EV`, `CA-CN-SA` | Décret de surtaxe (Chine) 2024 |
| `CA-STEEL-TRQ`, `CA-CN-MELT` | DORS/2025-148 (mod. DORS/2026-119), DORS/2025-154 |
| `CA-STEEL-DERIV` | DORS/2025-267 ; Avis des douanes 25-33 |
| `US-338-BAN` (alcool, produits laitiers) | Annexes des proclamations du 8 sept. 2026 |

Tant qu'une liste n'est pas importée, la mesure s'applique par **préfixe indicatif**, et le résultat l'indique clairement (« préfixe indicatif (liste non importée) »). Dès qu'une liste existe, elle fait foi.

---

## Fonctionnement du moteur

**Importation aux États-Unis**
1. Droit de base : colonne 2 si l'origine y est soumise ; sinon taux préférentiel si réclamé et admissible (indicateur S/S+ pour le Canada et le Mexique, ou l'indicateur de l'ALE) ; sinon colonne 1.
2. Programmes du ch. 99 (`programs:` dans `us.yaml`) : renvois de la ligne → rubrique → taux additionnel lu dans l'USITC, filtré par pays (détecté dans le texte de la rubrique : « product of Canada », « except products of… »). **Un seul programme 232 par article**, avec priorité autos > camions > métaux > bois. Quand plusieurs rubriques d'un même programme s'appliquent, la plus élevée est retenue et les autres sont proposées dans une liste déroulante.
3. Mesures par origine (`measures:`), par exemple la 301 « travail forcé » : taux par pays, lu automatiquement dans 9903.05.20 à .84, plafonds « net de NPF » (UE, Taïwan, Japon, Corée, Suisse) et exemptions (ACEUM en franchise, 232, liste de produits, aéronefs, dons).
4. AD/CVD, licences, MPF/HMF.

**Importation au Canada**
1. Traitement tarifaire : TÉU/TMÉU/ALE si réclamé et présent sur la ligne, sinon NPF (tarif général pour la Corée du Nord).
2. Surtaxes et mesures : origine, date, portée (liste importée ou préfixe), option requise (hors contingent, acier coulé en Chine), exemptions et remises. Les mesures d'un même **groupe** (`ca-steel`) ne se cumulent pas : seul le montant le plus élevé est retenu, conformément aux règles d'interaction publiées par les Finances.
3. LMSI, permis, puis TPS/TVH sur (valeur + droits + surtaxes).

---

## Règles modifiables (`rules/*.yaml`)

| Fichier | Contenu |
|---|---|
| `us.yaml` | frais, colonne 2, indicateurs ALE, programmes 9903, mesures par origine, régimes du ch. 98 |
| `ca.yaml` | TPS/TVH, traitements préférentiels, partenaires ALE, surtaxes et mesures acier, régimes du ch. 99 |
| `adcvd.yaml` | ordonnances AD/CVD (US) et mesures LMSI en vigueur (CA) |
| `licences.yaml` | exigences des autres agences et ministères, par préfixe HS |

Chaque élément porte un `status` : **vérifié** (confirmé dans une source officielle ou de cabinet) ou **à valider**. L'éditeur de la page Admin valide le YAML avant d'enregistrer et garde une copie `.bak`.

### Points marqués « à valider » au 23 nov. 2026

- **Portée du traitement ACEUM de la 232 sur les métaux** (25 % sur le contenu non américain, plancher de 15 %) : Annexe I-C seulement, ou tous les dérivés ? Proposé en option, désactivé par défaut.
- **Numéros de rubrique des Annexes I-A/I-B/I-C/III** depuis le 6 avril 2026 : ils sont lus automatiquement dans l'USITC. L'option « Annexe III » (total de 15 %) reste manuelle, faute de rubrique dédiée connue.
- **9903.03.15** : l'exclusion 338 pour les marchandises déjà visées par la 232 ne vaut que pour la liste laitière depuis le 15 sept. 2026.
- **Préfixes HS des ordonnances AD/CVD et LMSI** : ils servent à signaler un risque. La portée réelle est définie par le texte de l'ordonnance.
- **Surtaxe Chine sur les VE** : codes 8703/8702 indicatifs.
- Annonce du 25 août 2026 sur la hausse à 50 % des droits sur les autos canadiennes au 1er janvier 2027 : **non intégrée** (aucune proclamation connue).

---

## API

```
GET  /api/search?j=US|CA&q=…           recherche par code ou par mots-clés (FTS5)
POST /api/calc                          { direction: "CA-US"|"US-CA", code, origin, value, currency, preferential, … }
POST /api/batch                         multipart : file + direction, origin, currency, preferential, province, mode
GET  /api/measures                      mesures et programmes actifs
GET  /api/meta                          fraîcheur des données
Admin (en-tête `Authorization: Bearer <session ou ADMIN_TOKEN>`) — POST /api/auth/login, /api/admin/me, /password, /users ; /api/admin/import/us, /import/us-file, /import/ca-file, /import/ca-url,
  /import/fx, /fx, /codes, /import/pga, /import/adcvd, /rules/:key
```

## Ligne de commande

```bash
docker compose exec tarifs node server/dist/cli.js import-us
docker compose exec tarifs node server/dist/cli.js import-ca /data/tarif.xlsx
docker compose exec tarifs node server/dist/cli.js codes CA-US-2026-25 /data/liste25.txt --replace
docker compose exec tarifs node server/dist/cli.js calc CA-US 8462.11.00.35 CA 250000 --pref
```

## Développement

```bash
npm install
ADMIN_TOKEN=dev npm run dev      # API :8080 + Vite :5173
npm test                         # tests du moteur (parseurs et scénarios)
```

Pile technique : Fastify, SQLite (better-sqlite3 + FTS5), React/Vite, TypeScript.

---

*Outil d'estimation. Il ne remplace ni une décision anticipée de classement ou d'origine (CBP / ASFC) ni l'avis d'un courtier en douane agréé.*
