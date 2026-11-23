# Déploiement sur la VPS (Docker, mise à jour automatique)

À chaque push sur `main`, GitHub Actions exécute les tests puis construit l'image `ghcr.io/corbeils/slsc-tarifs:latest` pour amd64 et arm64. Watchtower, déjà en place sur la VPS, récupère la nouvelle image et redémarre le conteneur.

## 1. Installation (une seule fois)

```bash
sudo mkdir -p /opt/slsc-tarifs && cd /opt/slsc-tarifs
sudo curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/corbeils/slsc-tarifs/main/deploy/docker-compose.yml
printf 'ADMIN_TOKEN=%s\nCRON_US=30 3 * * 1\nCRON_FX=15 17 * * 1-5\nTZ=America/Toronto\n' "$(openssl rand -hex 24)" | sudo tee .env
docker compose pull && docker compose up -d
curl -s http://127.0.0.1:8085/api/health      # → {"ok":true}
```

Le dépôt est public. Ton `docker login ghcr.io` (fait pour `slscload`) donne de toute façon accès à l'image. Pour la rendre téléchargeable sans connexion : GitHub → ton profil → *Packages* → `slsc-tarifs` → *Package settings* → *Change visibility* → **Public**.

## 2. Nginx Proxy Manager (`npmplus`)

`npmplus` tourne en mode réseau **host** : il voit directement les ports du VPS. Inutile (et impossible) de le brancher sur un réseau Docker.

Dans NPM, crée un hôte, par exemple `tarifs.stevecorbeil.net` :

| Champ | Valeur |
|---|---|
| Scheme | `http` |
| Forward Hostname / IP | `127.0.0.1` |
| Forward Port | `8085` |
| SSL | certificat Let's Encrypt + Force SSL |

Si NPM tourne un jour dans un réseau Docker classique (pas `host`) : `docker network connect slsc-tarifs_default <conteneur NPM>`, puis cible `slsc-tarifs:8080`.

## 3. Mises à jour

- **Automatiques** : push sur `main` → image construite (environ 5 à 8 min avec ARM) → Watchtower la récupère.
- **Manuelles** : `cd /opt/slsc-tarifs && docker compose pull && docker compose up -d`
- **Revenir en arrière** : remplacer `:latest` par `:<sha du commit>` dans `docker-compose.yml`.

Ton Watchtower doit surveiller ce conteneur. S'il tourne avec `--label-enable`, l'étiquette est déjà dans le compose. Pour vérifier qu'il l'a repéré : `docker logs watchtower --tail 20`.

## 4. Premier chargement des données

Page **Admin** : compte par défaut **CORBEILS / admin**, à changer tout de suite dans *My account*. D'autres administrateurs peuvent être ajoutés dans *Administrator accounts*.

Si tu oublies le mot de passe : `docker compose exec slsc-tarifs node -e "const D=require('better-sqlite3');new D('/data/tarifs.sqlite').exec('DELETE FROM users;DELETE FROM sessions')" && docker compose restart` recrée le compte par défaut.

1. *Tarif américain → Importer en ligne*
2. *Taux de change → Banque du Canada*
3. *Tarif canadien* : téléverser le fichier Excel de l'ASFC
4. *Listes de codes* : coller les annexes des décrets de surtaxe (voir README)

## 5. Sauvegardes

Toutes les données sont dans `/opt/slsc-tarifs/data` (SQLite) et `/opt/slsc-tarifs/rules` (YAML) :

```bash
cd /opt/slsc-tarifs && tar czf ~/slsc-tarifs-$(date +%F).tgz data rules
```

## Dépannage

| Symptôme | Commande / cause |
|---|---|
| `no matching manifest` | le premier build n'est pas terminé : onglet *Actions* du dépôt |
| `denied` au `pull` | refaire `docker login ghcr.io -u corbeils` avec un jeton `read:packages` |
| 502 dans NPM | npmplus en mode host : cible `127.0.0.1:8085` (vérifier `curl -s http://127.0.0.1:8085/api/health`) |
| Le conteneur redémarre | `docker compose logs --tail=50 slsc-tarifs` |

## Règles YAML et mises à jour

Au démarrage, un fichier de `rules/` identique à une version par défaut déjà publiée (donc jamais modifié) est remplacé par la nouvelle version, et l'ancien est gardé en `.bak`. Un fichier que tu as modifié n'est jamais touché. Les empreintes des versions publiées sont dans `rules-history.sha256` : à chaque modification des règles par défaut, ajouter la nouvelle empreinte (`sha256sum rules/*.yaml`).
