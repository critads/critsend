# LLM local air-gap : Hetzner GEX44 + Ollama + Qwen3 + Vanna AI

Guide A→Z pour déployer un assistant IA **100% local et coupé d'Internet** qui
explore la base Critsend et exécute des requêtes SQL en langage naturel.

**Architecture cible :**

```
┌─────────────────────────────┐         vSwitch Hetzner (VLAN privé)
│  GEX44 (nouveau serveur)    │  10.0.1.2 ◄──────────► 10.0.1.1
│  - Ollama (Qwen3 14B/32B)   │                        ┌──────────────────────────┐
│  - Vanna AI (UI web + agent)│                        │ Serveur Critsend (prod)  │
│  - AUCUN accès Internet     │   compte PG llm_ro     │ 157.180.98.150           │
│    (firewall sortant DENY)  │   (lecture seule)      │ PostgreSQL critsend      │
└─────────────────────────────┘                        └──────────────────────────┘
        ▲ tunnel SSH (toi)
```

**Principes de sécurité :**
1. Le LLM n'accède à la base qu'avec un rôle PostgreSQL **lecture seule** + timeout.
2. Le GEX44 est **air-gap logiciel** : tout le trafic sortant est bloqué au firewall
   une fois l'installation terminée (stratégie « installer connecté, puis couper »).
3. La base n'accepte ce compte que depuis l'IP privée du GEX44 (pg_hba).
4. L'interface web n'est jamais exposée publiquement : accès par tunnel SSH.

---

## Étape 0 — Commander le serveur

1. https://www.hetzner.com/dedicated-rootserver/matrix-gpu/ → **GEX44**
   (RTX 4000 SFF Ada 20 Go, i5-13500, 64 Go RAM, 2× 1,92 To NVMe,
   ~184 €/mois + 79 € de setup, hors TVA).
2. À l'installation via Robot : **Ubuntu 24.04 LTS**, ta clé SSH.
3. Idéalement même datacenter que le serveur Critsend (nécessaire pour le vSwitch :
   les deux serveurs doivent être des dédiés Hetzner Robot).

## Étape 1 — Prérequis système (AVEC Internet, phase d'installation)

```bash
ssh root@<IP_GEX44>

apt update && apt full-upgrade -y
apt install -y build-essential curl git ufw python3.12-venv python3-pip

# Drivers NVIDIA (Ubuntu 24.04 : paquet serveur officiel)
apt install -y nvidia-driver-550-server nvidia-utils-550-server
reboot

# Après reboot, vérifier que le GPU est vu :
nvidia-smi   # doit afficher "NVIDIA RTX 4000 SFF Ada Generation, 20475MiB"
```

## Étape 2 — Ollama + modèles

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama

# Modèle principal : rapide, tient entièrement dans les 20 Go de VRAM
ollama pull qwen3:14b

# Modèle "qualité max" : déborde légèrement en RAM CPU (20 Go VRAM pour ~20 Go
# de poids Q4 + cache), donc plus lent (~10-15 tok/s) mais meilleur sur les
# requêtes complexes. Optionnel mais recommandé.
ollama pull qwen3:32b

# Test :
ollama run qwen3:14b "Écris une requête SQL PostgreSQL qui compte les lignes par jour."
nvidia-smi   # vérifier que la VRAM est utilisée pendant la génération
```

> Conseil : commencer avec `qwen3:14b` au quotidien ; basculer sur `qwen3:32b`
> quand une question est complexe (jointures multiples, fenêtrage). Le modèle
> est un simple paramètre dans Vanna.

Ollama n'a **besoin d'Internet que pour `ollama pull`**. L'inférence est 100%
locale — c'est ce qui rend la coupure de l'étape 7 indolore.

## Étape 3 — Réseau privé vSwitch entre les deux serveurs

Dans **Robot Hetzner** :
1. `Servers → vSwitches → Create vSwitch` (ex. nom `llm-net`, VLAN ID `4000`).
2. Ajouter les DEUX serveurs (Critsend + GEX44) au vSwitch.

Sur **chaque** serveur, créer l'interface VLAN (adapter `enp0s31f6` au nom réel
de l'interface publique, cf. `ip -br link`) :

```bash
# /etc/netplan/60-vswitch.yaml — serveur Critsend (10.0.1.1)
network:
  version: 2
  vlans:
    vlan4000:
      id: 4000
      link: enp0s31f6
      mtu: 1400
      addresses: [10.0.1.1/24]
```

```bash
# /etc/netplan/60-vswitch.yaml — GEX44 (10.0.1.2)
network:
  version: 2
  vlans:
    vlan4000:
      id: 4000
      link: enp0s31f6
      mtu: 1400
      addresses: [10.0.1.2/24]
```

```bash
netplan apply          # sur les deux serveurs
ping -c3 10.0.1.1      # depuis le GEX44 → doit répondre
```

## Étape 4 — Compte PostgreSQL lecture seule (sur le serveur Critsend)

```bash
sudo -u postgres psql -d critsend
```

```sql
-- Rôle dédié, lecture seule, borné
CREATE ROLE llm_ro LOGIN PASSWORD '<MOT_DE_PASSE_FORT>';
GRANT CONNECT ON DATABASE critsend TO llm_ro;
GRANT USAGE ON SCHEMA public TO llm_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO llm_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO llm_ro;

-- Ceintures + bretelles : transactions read-only, requêtes bornées à 60 s,
-- pas plus de 4 connexions simultanées
ALTER ROLE llm_ro SET default_transaction_read_only = on;
ALTER ROLE llm_ro SET statement_timeout = '60s';
ALTER ROLE llm_ro CONNECTION LIMIT 4;
```

PostgreSQL doit écouter sur l'IP privée. Dans `postgresql.conf` :

```
listen_addresses = 'localhost,10.0.1.1'
```

Dans `pg_hba.conf` (UNIQUEMENT ce compte, UNIQUEMENT depuis le GEX44) :

```
hostssl critsend  llm_ro  10.0.1.2/32  scram-sha-256
```

```bash
systemctl reload postgresql
# Test depuis le GEX44 :
psql "postgresql://llm_ro:<MDP>@10.0.1.1:5432/critsend?sslmode=require" -c "SELECT COUNT(*) FROM subscribers;"
psql "postgresql://llm_ro:...@10.0.1.1:5432/critsend?sslmode=require" -c "DELETE FROM subscribers;"  # doit ÉCHOUER (read-only)
```

⚠️ Si le firewall du serveur Critsend filtre, ouvrir 5432/tcp pour 10.0.1.2 uniquement.

## Étape 5 — Vanna AI (sur le GEX44)

> **Note de contexte (juillet 2026) :** le dépôt `vanna-ai/vanna` a été archivé
> en mars 2026 en v2.0.2 (MIT). Le paquet PyPI reste installable et fonctionnel ;
> pour un serveur air-gap, un logiciel figé est même un avantage (aucune mise à
> jour requise). Alternative maintenue si besoin un jour : DB-GPT.

```bash
useradd -m -s /bin/bash vanna
su - vanna
python3 -m venv ~/venv && source ~/venv/bin/activate
pip install "vanna==2.0.2" psycopg2-binary fastapi uvicorn
```

Créer `/home/vanna/app.py` :

```python
"""Vanna 2.0 + Ollama (local) + PostgreSQL Critsend (lecture seule)."""
import os
from fastapi import FastAPI
from vanna import Agent
from vanna.core.registry import ToolRegistry
from vanna.core.user import RequestContext, User, UserResolver
from vanna.servers.base import ChatHandler
from vanna.servers.fastapi.routes import register_chat_routes
from vanna.tools import RunSqlTool

# NB : vérifier les noms exacts des intégrations installées :
#   python -c "import vanna.integrations, pkgutil; print([m.name for m in pkgutil.iter_modules(vanna.integrations.__path__)])"
from vanna.integrations.ollama import OllamaLlmService          # LLM local
from vanna.integrations.postgres import PostgresRunner          # exécuteur SQL

DB_URL = os.environ["LLM_DB_URL"]  # postgresql://llm_ro:...@10.0.1.1:5432/critsend?sslmode=require
MODEL = os.environ.get("LLM_MODEL", "qwen3:14b")  # ou qwen3:32b

app = FastAPI()

class SingleUserResolver(UserResolver):
    """Instance mono-utilisateur derrière un tunnel SSH : pas d'auth applicative."""
    async def resolve_user(self, request_context: RequestContext) -> User:
        return User(id="operator", email="operator@local", group_memberships=["admin"])

llm = OllamaLlmService(model=MODEL, base_url="http://127.0.0.1:11434")
tools = ToolRegistry()
tools.register(RunSqlTool(sql_runner=PostgresRunner(DB_URL)))

agent = Agent(llm_service=llm, tool_registry=tools, user_resolver=SingleUserResolver())
register_chat_routes(app, ChatHandler(agent))
```

Service systemd `/etc/systemd/system/vanna.service` :

```ini
[Unit]
Description=Vanna AI (text-to-SQL local)
After=network-online.target ollama.service

[Service]
User=vanna
Environment=LLM_DB_URL=postgresql://llm_ro:<MDP>@10.0.1.1:5432/critsend?sslmode=require
Environment=LLM_MODEL=qwen3:14b
ExecStart=/home/vanna/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8800
WorkingDirectory=/home/vanna
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now vanna
```

## Étape 6 — Donner le contexte Critsend au modèle

La précision du text-to-SQL dépend surtout du **contexte schéma** fourni. Deux
leviers :

1. **DDL** : exporter le schéma depuis le serveur Critsend et l'injecter dans le
   contexte de l'agent (context enricher Vanna, ou simplement un préambule
   système) :
   ```bash
   sudo -u postgres pg_dump -d critsend --schema-only --no-owner > /tmp/critsend_schema.sql
   scp vers le GEX44 (via l'IP privée)
   ```
2. **Exemples de requêtes métier** : fournir 10–20 paires « question →  SQL »
   typiques (taux d'ouverture par campagne, abonnés par ref/tag, stats bounce,
   volume pressure-guard…). C'est ce qui fait passer la précision de ~60% à >90%.

Conseils spécifiques Critsend à inclure dans le contexte :
- `subscribers.refs`/`tags` sont des `text[]` → utiliser `@>` / `ANY(...)`.
- `campaign_stats` est la table d'événements (type `open`/`click`), volumineuse →
  toujours filtrer par date et/ou campagne.
- `tracking_tokens` est partitionnée par jour, rétention courte en prod (7 j).

## Étape 7 — Coupure Internet (air-gap)

Une fois tout installé et testé :

```bash
# Sur le GEX44
ufw default deny outgoing
ufw default deny incoming
ufw allow in on vlan4000                 # réseau privé
ufw allow out on vlan4000
ufw allow in 22/tcp                      # SSH (restreindre à ton IP si fixe :
                                         #   ufw allow from <TON_IP> to any port 22)
ufw enable
ufw status verbose
```

Vérifier l'étanchéité :

```bash
curl -m 5 https://ollama.com      # doit ÉCHOUER (timeout)
ping -c2 10.0.1.1                 # doit répondre
```

Désactiver aussi les mises à jour automatiques (sinon elles échoueront en boucle) :

```bash
systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer
```

## Étape 8 — Utilisation

Depuis ta machine :

```bash
ssh -L 8800:127.0.0.1:8800 root@<IP_GEX44>
# puis ouvrir http://localhost:8800 dans le navigateur
```

Tu peux poser des questions du type :
- « Combien d'abonnés actifs ont le ref DEL ? »
- « Taux d'ouverture des 10 dernières campagnes, hors IP bot »
- « Évolution des désabonnements par semaine sur 3 mois »

L'agent affiche le SQL généré, le résultat en tableau et un graphique.
**Toujours relire le SQL sur les chiffres importants** : même les meilleurs
modèles font ~10-20% d'erreurs sur les requêtes complexes ; le rôle read-only
protège la base, pas l'interprétation.

## Maintenance

- **Ajouter/mettre à jour un modèle** : 2 options —
  a) réouvrir temporairement le firewall sortant (`ufw default allow outgoing`,
  `ollama pull ...`, refermer) ; b) transfert 100% hors-ligne : sur une machine
  connectée, `ollama pull <modèle>` puis copier `~/.ollama/models/{blobs,manifests}`
  vers le GEX44 (scp via SSH ou clé USB) et `systemctl restart ollama`.
- **Sauvegarde** : rien de critique sur le GEX44 (la base reste sur le serveur
  Critsend) ; sauvegarder `/home/vanna/` (app + exemples d'entraînement).
- **Surveillance** : `nvidia-smi`, `journalctl -u ollama -u vanna -f`.

## Dépannage

| Symptôme | Cause probable | Fix |
|---|---|---|
| `nvidia-smi` vide | driver pas chargé | `reboot`, vérifier `lsmod \| grep nvidia` |
| Génération très lente | modèle 32B déborde en RAM | passer sur `qwen3:14b` ou quantisation Q3 |
| `connection refused` vers 10.0.1.1:5432 | listen_addresses / pg_hba / firewall | reprendre l'étape 4 |
| `cannot execute ... in a read-only transaction` | le LLM a tenté une écriture | comportement NORMAL — c'est le garde-fou |
| L'UI ne répond plus après la coupure | Vanna tente un appel externe | vérifier qu'aucune clé API cloud n'est configurée ; tout doit pointer sur 127.0.0.1:11434 |
