# Critsend — Documentation Base de Données

**Version :** Février 2026  
**Hébergement :** Neon (PostgreSQL managé)  
**ORM :** Drizzle ORM  
**Schéma source :** `shared/schema.ts`  
**Connexion :** Variable `NEON_DATABASE_URL` (fallback: `DATABASE_URL`), SSL activé, connection pooling via Neon pooler

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Tables — Contacts & Segmentation](#2-contacts--segmentation)
3. [Tables — Serveurs d'envoi (MTA)](#3-serveurs-denvoi-mta)
4. [Tables — Campagnes & Envoi](#4-campagnes--envoi)
5. [Tables — Import/Export CSV](#5-importexport-csv)
6. [Tables — Test Nullsink](#6-test-nullsink)
7. [Tables — Suivi & Tags](#7-suivi--tags)
8. [Tables — Suppression en masse (Flush)](#8-suppression-en-masse-flush)
9. [Tables — A/B Testing](#9-ab-testing)
10. [Tables — IP Warmup](#10-ip-warmup)
11. [Tables — Automatisation](#11-automatisation)
12. [Tables — Analytics](#12-analytics)
13. [Tables — Maintenance](#13-maintenance)
14. [Tables — Système (Auth, Sessions, Erreurs)](#14-système-auth-sessions-erreurs)
15. [Diagramme des relations](#15-diagramme-des-relations)
16. [Files d'attente (Job Queues)](#16-files-dattente-job-queues)
17. [Indexation & Performance](#17-indexation--performance)
18. [Mécanismes de sécurité des données](#18-mécanismes-de-sécurité-des-données)
19. [Tag BCK — Blacklist Master](#19-tag-bck--blacklist-master)
20. [Cycle de vie d'une campagne](#20-cycle-de-vie-dune-campagne)
21. [Cycle de vie d'un import CSV](#21-cycle-de-vie-dun-import-csv)

---

## 1. Vue d'ensemble

La base de données Critsend contient **25 tables** réparties en 13 domaines fonctionnels :

| Domaine | Tables | Nombre | Rôle |
|---------|--------|--------|------|
| Contacts & Segmentation | `subscribers`, `segments` | 2 | Stockage et filtrage des contacts |
| Serveurs d'envoi | `mtas`, `email_headers` | 2 | Configuration SMTP |
| Campagnes & Envoi | `campaigns`, `campaign_sends`, `campaign_stats`, `campaign_jobs` | 4 | Campagnes, suivi d'envoi, file d'attente |
| Import/Export | `import_jobs`, `import_job_queue`, `import_staging` | 3 | Traitement CSV haute performance |
| Test Nullsink | `nullsink_captures` | 1 | Capture d'emails en mode test |
| Tags & Suivi | `pending_tag_operations` | 1 | File d'attente fiable pour les tags |
| Suppression | `flush_jobs` | 1 | Suppression en masse des contacts |
| A/B Testing | `ab_test_variants` | 1 | Variantes de campagne |
| IP Warmup | `warmup_schedules` | 1 | Échauffement progressif IP |
| Automatisation | `automation_workflows`, `automation_enrollments` | 2 | Séquences email automatiques |
| Analytics | `analytics_daily`, `dashboard_cache` | 2 | Métriques agrégées et cache |
| Maintenance | `db_maintenance_rules`, `db_maintenance_logs` | 2 | Nettoyage automatique |
| Système | `users`, `session`, `error_logs` | 3 | Auth, sessions, logs d'erreurs |
| **Total** | | **25** | |

**Convention de nommage :** Tous les IDs sont des UUID v4 auto-générés (`gen_random_uuid()`). Les noms de colonnes utilisent le format `snake_case` en base, mappés en `camelCase` dans l'ORM Drizzle.

---

## 2. Contacts & Segmentation

### `subscribers`

Table centrale — chaque ligne représente un contact email.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `email` | `text` | NOT NULL, UNIQUE | Adresse email (normalisée en minuscules) |
| `tags` | `text[]` | NOT NULL, default `{}` | Tableau de tags (ex: `["newsletter", "vip", "BCK"]`) |
| `ip_address` | `text` | nullable | Adresse IP du contact |
| `import_date` | `timestamp` | NOT NULL, default NOW | Date d'ajout |

**Index :**
- `email_idx` — B-tree sur `email` (recherche rapide par email)
- `tags_gin_idx` — **GIN** sur `tags` (recherche ultra-rapide dans les tableaux de tags, ex: `'BCK' = ANY(tags)`)

**Relations :**
- → `campaign_stats` (1:N) — statistiques de tracking
- → `campaign_sends` (1:N) — historique d'envoi
- → `pending_tag_operations` (1:N, CASCADE DELETE) — opérations de tag en attente
- → `automation_enrollments` (1:N, CASCADE DELETE) — inscriptions workflows
- → `error_logs` (1:N) — logs d'erreurs

**Volume estimé :** Plusieurs millions de lignes. Optimisé avec GIN index et pg_trgm pour les recherches.

---

### `segments`

Segments = filtres réutilisables pour cibler des groupes de contacts.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `name` | `text` | NOT NULL | Nom du segment (ex: "Clients VIP") |
| `description` | `text` | nullable | Description optionnelle |
| `rules` | `jsonb` | NOT NULL, default `[]` | Règles de filtrage DSL v2 |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |

**Important :** Un segment ne stocke **aucun contact**. Il stocke des **règles** en JSON. À chaque utilisation (envoi de campagne, preview, comptage), les règles sont compilées en SQL paramétré par le `segment-compiler.ts` et exécutées en temps réel sur `subscribers`.

**Format des règles DSL v2 :**
```json
{
  "version": 2,
  "root": {
    "type": "group",
    "combinator": "AND",
    "children": [
      {
        "type": "condition",
        "field": "tags",
        "operator": "has_tag",
        "value": "newsletter",
        "value2": null
      },
      {
        "type": "group",
        "combinator": "OR",
        "children": [
          {
            "type": "condition",
            "field": "email",
            "operator": "ends_with",
            "value": "@gmail.com",
            "value2": null
          }
        ]
      }
    ]
  }
}
```

**Champs disponibles :** `email`, `tags`, `date_added`, `ip_address`  
**Opérateurs (18) :** `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty`, `has_tag`, `not_has_tag`, `has_any_tag`, `has_no_tags`, `before`, `after`, `between`, `in_last_days`, `not_in_last_days`  
**Profondeur max :** 3 niveaux de groupes imbriqués

---

## 3. Serveurs d'envoi (MTA)

### `mtas`

Configuration des serveurs SMTP (Mail Transfer Agents).

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `name` | `text` | NOT NULL | Nom affiché (ex: "Serveur Production") |
| `hostname` | `text` | nullable | Hôte SMTP (ex: "smtp.example.com") |
| `port` | `integer` | NOT NULL, default 587 | Port SMTP |
| `username` | `text` | nullable | Identifiant SMTP |
| `password` | `text` | nullable | Mot de passe SMTP (**chiffré AES-256-GCM** au repos) |
| `tracking_domain` | `text` | nullable | Domaine pour le tracking des clics |
| `open_tracking_domain` | `text` | nullable | Domaine pour le tracking des ouvertures |
| `image_hosting_domain` | `text` | nullable | Domaine pour héberger les images des emails |
| `from_name` | `text` | NOT NULL, default "" | Nom d'expéditeur par défaut |
| `from_email` | `text` | NOT NULL, default "" | Email d'expéditeur par défaut |
| `is_active` | `boolean` | NOT NULL, default true | MTA activé/désactivé |
| `mode` | `text` | NOT NULL, default "real" | `"real"` = envoi réel SMTP, `"nullsink"` = capture sans envoi |
| `simulated_latency_ms` | `integer` | default 0 | Latence simulée en mode nullsink (ms) |
| `failure_rate` | `integer` | default 0 | Taux d'échec simulé en mode nullsink (0-100%) |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |

**Sécurité :** Les mots de passe SMTP sont chiffrés avec AES-256-GCM avant stockage. L'affichage dans l'UI est masqué.

---

### `email_headers`

En-têtes SMTP personnalisés ajoutés à tous les emails sortants.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `name` | `text` | NOT NULL | Nom de l'en-tête (ex: "X-Mailer") |
| `value` | `text` | NOT NULL | Valeur de l'en-tête |
| `is_default` | `boolean` | NOT NULL, default false | En-tête par défaut ou spécifique |

---

## 4. Campagnes & Envoi

### `campaigns`

Table principale des campagnes email.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `name` | `text` | NOT NULL | Nom de la campagne |
| `mta_id` | `varchar` | FK → `mtas.id` | Serveur d'envoi utilisé |
| `segment_id` | `varchar` | FK → `segments.id` | Segment ciblé |
| `from_name` | `text` | NOT NULL | Nom d'expéditeur |
| `from_email` | `text` | NOT NULL | Email d'expéditeur |
| `reply_email` | `text` | nullable | Email de réponse |
| `subject` | `text` | NOT NULL | Objet de l'email |
| `preheader` | `text` | nullable | Texte de preview |
| `html_content` | `text` | NOT NULL | Contenu HTML de l'email (max 5 Mo) |
| `track_clicks` | `boolean` | NOT NULL, default true | Suivi des clics activé |
| `track_opens` | `boolean` | NOT NULL, default true | Suivi des ouvertures activé |
| `unsubscribe_text` | `text` | default "Unsubscribe" | Texte du lien de désinscription |
| `company_address` | `text` | nullable | Adresse physique (CAN-SPAM) |
| `sending_speed` | `text` | NOT NULL, default "medium" | Vitesse : `slow`/`medium`/`fast`/`godzilla` |
| `scheduled_at` | `timestamp` | nullable | Date d'envoi planifié |
| `status` | `text` | NOT NULL, default "draft" | Statut (voir cycle de vie) |
| `pause_reason` | `text` | nullable | Raison de la pause (ex: "mta_down") |
| `retry_until` | `timestamp` | nullable | Limite de retry automatique (12h) |
| `open_tag` | `text` | nullable | Tag ajouté à l'ouverture |
| `click_tag` | `text` | nullable | Tag ajouté au clic |
| `unsubscribe_tag` | `text` | nullable | Tag ajouté à la désinscription |
| `sent_count` | `integer` | NOT NULL, default 0 | Emails envoyés avec succès |
| `pending_count` | `integer` | NOT NULL, default 0 | Emails en attente |
| `failed_count` | `integer` | NOT NULL, default 0 | Emails échoués |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `started_at` | `timestamp` | nullable | Début de l'envoi |
| `completed_at` | `timestamp` | nullable | Fin de l'envoi |

**Vitesses d'envoi (définies dans `campaign-sender.ts` SPEED_CONFIG) :**

| Mode | Emails/min | Workers concurrents |
|------|-----------|-------------------|
| `slow` | 500 | 5 |
| `medium` | 2 000 | 30 |
| `fast` | 5 000 | 80 |
| `godzilla` | 60 000 | 250 |

> Note : Le fichier `shared/schema.ts` contient un `sendingSpeedConfig` avec des valeurs différentes (500/1000/2000/3000) utilisé pour l'affichage UI. Les valeurs réelles d'envoi sont celles de `SPEED_CONFIG` dans `server/services/campaign-sender.ts`.

---

### `campaign_sends`

Journal d'envoi — **une ligne par email envoyé** pour chaque campagne.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `campaign_id` | `varchar` | NOT NULL, FK → `campaigns.id` | Campagne |
| `subscriber_id` | `varchar` | NOT NULL, FK → `subscribers.id` | Contact destinataire |
| `sent_at` | `timestamp` | NOT NULL, default NOW | Date d'envoi |
| `status` | `text` | NOT NULL, default "sent" | `pending` / `sent` / `failed` / `bounced` |
| `retry_count` | `integer` | NOT NULL, default 0 | Nombre de tentatives |
| `last_retry_at` | `timestamp` | nullable | Dernière tentative |
| `first_open_at` | `timestamp` | nullable | Première ouverture |
| `first_click_at` | `timestamp` | nullable | Premier clic |

**Index :**
- `campaign_sends_unique_idx` — **UNIQUE** sur `(campaign_id, subscriber_id)` → empêche les doublons d'envoi
- `campaign_sends_campaign_idx` — B-tree sur `campaign_id`
- `campaign_sends_status_idx` — B-tree sur `status`

**Volume estimé :** Potentiellement des dizaines de millions de lignes. Nettoyage automatique configurable via les règles de maintenance (rétention par défaut : 180 jours).

---

### `campaign_stats`

Événements de tracking — chaque ouverture et clic enregistré.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `campaign_id` | `varchar` | NOT NULL, FK → `campaigns.id` | Campagne |
| `subscriber_id` | `varchar` | NOT NULL, FK → `subscribers.id` | Contact |
| `type` | `text` | NOT NULL | `"open"` ou `"click"` |
| `link` | `text` | nullable | URL cliquée (pour les clics uniquement) |
| `timestamp` | `timestamp` | NOT NULL, default NOW | Date de l'événement |

**Index :**
- `campaign_stats_campaign_idx` — B-tree sur `campaign_id`
- `campaign_stats_subscriber_idx` — B-tree sur `subscriber_id`

---

### `campaign_jobs`

File d'attente PostgreSQL pour le traitement des campagnes.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `campaign_id` | `varchar` | NOT NULL, FK → `campaigns.id` | Campagne à traiter |
| `status` | `text` | NOT NULL, default "pending" | `pending` / `processing` / `completed` / `failed` |
| `retry_count` | `integer` | NOT NULL, default 0 | Tentatives de retry |
| `next_retry_at` | `timestamp` | nullable | Prochain retry planifié |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `started_at` | `timestamp` | nullable | Début du traitement |
| `completed_at` | `timestamp` | nullable | Fin du traitement |
| `worker_id` | `text` | nullable | ID du worker qui traite le job |
| `error_message` | `text` | nullable | Message d'erreur en cas d'échec |

**Index :**
- `campaign_jobs_campaign_idx` — B-tree sur `campaign_id`
- `campaign_jobs_status_idx` — B-tree sur `status`
- `campaign_jobs_created_at_idx` — B-tree sur `created_at`
- `campaign_jobs_status_created_idx` — Composite sur `(status, created_at)`

**Mécanisme :** Le worker utilise `SELECT ... FOR UPDATE SKIP LOCKED` pour réclamer un job sans collision. Notification instantanée via `NOTIFY campaign_jobs`. Idempotent : vérification d'existence avant création.

---

## 5. Import/Export CSV

### `import_jobs`

Historique et suivi des imports CSV.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `filename` | `text` | NOT NULL | Nom du fichier CSV |
| `total_rows` | `integer` | NOT NULL, default 0 | Total de lignes |
| `processed_rows` | `integer` | NOT NULL, default 0 | Lignes traitées |
| `new_subscribers` | `integer` | NOT NULL, default 0 | Nouveaux contacts créés |
| `updated_subscribers` | `integer` | NOT NULL, default 0 | Contacts mis à jour |
| `failed_rows` | `integer` | NOT NULL, default 0 | Lignes en erreur |
| `status` | `text` | NOT NULL, default "pending" | `pending` / `processing` / `completed` / `failed` |
| `tag_mode` | `text` | NOT NULL, default "merge" | `"merge"` (fusionne tags) / `"override"` (remplace) |
| `error_message` | `text` | nullable | Message d'erreur |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `started_at` | `timestamp` | nullable | Début du traitement |
| `completed_at` | `timestamp` | nullable | Fin du traitement |

**Index :**
- `import_jobs_status_created_idx` — Composite sur `(status, created_at)`

---

### `import_job_queue`

File d'attente technique pour le traitement des imports (avec support de reprise).

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `import_job_id` | `varchar` | NOT NULL, FK → `import_jobs.id` | Job d'import parent |
| `csv_file_path` | `text` | NOT NULL | Chemin du fichier CSV sur disque/object storage |
| `total_lines` | `integer` | NOT NULL, default 0 | Total de lignes à traiter |
| `processed_lines` | `integer` | NOT NULL, default 0 | Lignes traitées |
| `file_size_bytes` | `integer` | NOT NULL, default 0 | Taille du fichier (octets) |
| `processed_bytes` | `integer` | NOT NULL, default 0 | Octets traités |
| `last_checkpoint_line` | `integer` | NOT NULL, default 0 | Dernier point de reprise |
| `status` | `text` | NOT NULL, default "pending" | `pending` / `processing` / `completed` / `failed` |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `started_at` | `timestamp` | nullable | Début du traitement |
| `completed_at` | `timestamp` | nullable | Fin du traitement |
| `heartbeat` | `timestamp` | nullable | Dernière preuve de vie du worker |
| `worker_id` | `text` | nullable | ID du worker |
| `retry_count` | `integer` | NOT NULL, default 0 | Tentatives de retry |
| `error_message` | `text` | nullable | Message d'erreur |

**Index :**
- `import_job_queue_import_job_idx` — B-tree sur `import_job_id`
- `import_job_queue_status_idx` — B-tree sur `status`
- `import_job_queue_created_at_idx` — B-tree sur `created_at`

---

### `import_staging`

Table temporaire de transit pour les imports haute performance via PostgreSQL `COPY`.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `job_id` | `varchar` | NOT NULL | ID du job d'import |
| `email` | `text` | NOT NULL | Email du contact |
| `tags` | `text[]` | NOT NULL, default `{}` | Tags du contact |
| `ip_address` | `text` | nullable | Adresse IP |
| `line_number` | `integer` | NOT NULL, default 0 | Numéro de ligne dans le CSV |

**Index :**
- `import_staging_job_id_idx` — B-tree sur `job_id`
- `import_staging_email_idx` — B-tree sur `email`

**Cycle de vie :** Les données CSV sont d'abord copiées ici via `COPY` PostgreSQL (pipeline de 4 opérations parallèles, batches de 25k lignes), puis fusionnées dans `subscribers` via `INSERT...ON CONFLICT` avec support merge/override des tags. La table est nettoyée après chaque import.

---

## 6. Test Nullsink

### `nullsink_captures`

Capture complète des emails en mode test (nullsink) — aucun email n'est réellement envoyé.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `campaign_id` | `varchar` | NOT NULL, FK → `campaigns.id` | Campagne |
| `subscriber_id` | `varchar` | FK → `subscribers.id` | Contact destinataire |
| `mta_id` | `varchar` | FK → `mtas.id` | MTA utilisé |
| `from_email` | `text` | NOT NULL | Expéditeur |
| `to_email` | `text` | NOT NULL | Destinataire |
| `subject` | `text` | NOT NULL | Objet |
| `message_size` | `integer` | default 0 | Taille du message (octets) |
| `html_body` | `text` | nullable | Contenu HTML complet |
| `status` | `text` | NOT NULL, default "captured" | `"captured"` / `"simulated_failure"` |
| `handshake_time_ms` | `integer` | default 0 | Temps de handshake simulé |
| `total_time_ms` | `integer` | default 0 | Temps total simulé |
| `timestamp` | `timestamp` | NOT NULL, default NOW | Date de capture |

**Index :**
- `nullsink_captures_campaign_idx` — B-tree sur `campaign_id`
- `nullsink_captures_timestamp_idx` — B-tree sur `timestamp`

**Rétention :** 7 jours par défaut (nettoyage automatique).

---

## 7. Suivi & Tags

### `pending_tag_operations`

File d'attente fiable pour les opérations de tag asynchrones avec retry.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `subscriber_id` | `varchar` | NOT NULL, FK → `subscribers.id` (CASCADE) | Contact concerné |
| `campaign_id` | `varchar` | FK → `campaigns.id` | Campagne source |
| `tag_type` | `text` | NOT NULL | `"positive"` (ajout) / `"negative"` (retrait) |
| `tag_value` | `text` | NOT NULL | Valeur du tag à ajouter/retirer |
| `event_type` | `text` | NOT NULL | `"open"` / `"click"` / `"unsubscribe"` |
| `status` | `text` | NOT NULL, default "pending" | `pending` / `processing` / `completed` / `failed` |
| `retry_count` | `integer` | NOT NULL, default 0 | Tentatives effectuées |
| `max_retries` | `integer` | NOT NULL, default 5 | Maximum de tentatives |
| `last_error` | `text` | nullable | Dernière erreur |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `processed_at` | `timestamp` | nullable | Date de traitement |
| `next_retry_at` | `timestamp` | nullable | Prochain retry planifié |

**Index :**
- `pending_tag_ops_subscriber_idx` — B-tree sur `subscriber_id`
- `pending_tag_ops_status_idx` — B-tree sur `status`
- `pending_tag_ops_created_at_idx` — B-tree sur `created_at`
- `pending_tag_ops_next_retry_idx` — B-tree sur `next_retry_at`
- `pending_tag_ops_status_retry_idx` — Composite sur `(status, next_retry_at)`

**Rétention :** 7 jours par défaut.

---

## 8. Suppression en masse (Flush)

### `flush_jobs`

Suivi des suppressions massives de contacts.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `total_rows` | `integer` | NOT NULL, default 0 | Contacts à supprimer |
| `processed_rows` | `integer` | NOT NULL, default 0 | Contacts supprimés |
| `status` | `text` | NOT NULL, default "pending" | `pending` / `processing` / `completed` / `failed` / `cancelled` |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `started_at` | `timestamp` | nullable | Début du traitement |
| `completed_at` | `timestamp` | nullable | Fin du traitement |
| `heartbeat` | `timestamp` | nullable | Preuve de vie du worker |
| `worker_id` | `text` | nullable | ID du worker |
| `error_message` | `text` | nullable | Message d'erreur |

**Index :**
- `flush_jobs_status_idx` — B-tree sur `status`
- `flush_jobs_created_at_idx` — B-tree sur `created_at`

**Processus :**
1. Suppression des tables dépendantes par batches de 10 000 lignes (`campaign_sends`, `campaign_stats`, `nullsink_captures`, `pending_tag_operations`, `automation_enrollments`, `error_logs`)
2. Suppression des contacts par batches de 1 000 lignes
3. Retry automatique en cas de deadlock PostgreSQL (5 tentatives, backoff exponentiel)

---

## 9. A/B Testing

### `ab_test_variants`

Variantes de campagne pour les tests A/B.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `campaign_id` | `varchar` | NOT NULL, FK → `campaigns.id` (CASCADE) | Campagne parente |
| `name` | `text` | NOT NULL | Nom de la variante (ex: "Sujet A") |
| `subject` | `text` | nullable | Objet alternatif |
| `html_content` | `text` | nullable | Contenu HTML alternatif |
| `from_name` | `text` | nullable | Nom d'expéditeur alternatif |
| `preheader` | `text` | nullable | Preheader alternatif |
| `allocation_percent` | `integer` | NOT NULL, default 50 | % de contacts recevant cette variante |
| `sent_count` | `integer` | NOT NULL, default 0 | Emails envoyés |
| `open_count` | `integer` | NOT NULL, default 0 | Ouvertures |
| `click_count` | `integer` | NOT NULL, default 0 | Clics |
| `unsubscribe_count` | `integer` | NOT NULL, default 0 | Désinscriptions |
| `bounce_count` | `integer` | NOT NULL, default 0 | Bounces |
| `is_winner` | `boolean` | NOT NULL, default false | Variante gagnante déclarée |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |

**Index :**
- `ab_test_variants_campaign_idx` — B-tree sur `campaign_id`

**Statistiques :** Test de proportions (z-test) avec niveaux de confiance 90/95/99%.

---

## 10. IP Warmup

### `warmup_schedules`

Plans d'échauffement progressif pour les nouvelles IP/MTA.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `mta_id` | `varchar` | NOT NULL, FK → `mtas.id` (CASCADE) | Serveur concerné |
| `name` | `text` | NOT NULL | Nom du plan |
| `status` | `text` | NOT NULL, default "active" | `active` / `paused` / `completed` |
| `start_date` | `timestamp` | NOT NULL, default NOW | Date de début |
| `current_day` | `integer` | NOT NULL, default 1 | Jour actuel (1-N) |
| `total_days` | `integer` | NOT NULL, default 30 | Durée totale (jours) |
| `daily_volume_cap` | `integer` | NOT NULL, default 50 | Volume max jour 1 |
| `max_daily_volume` | `integer` | NOT NULL, default 100 000 | Plafond absolu |
| `ramp_multiplier` | `text` | NOT NULL, default "1.5" | Multiplicateur exponentiel |
| `sent_today` | `integer` | NOT NULL, default 0 | Emails envoyés aujourd'hui |
| `last_reset_date` | `timestamp` | default NOW | Dernier reset du compteur journalier |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |

**Index :**
- `warmup_schedules_mta_idx` — B-tree sur `mta_id`
- `warmup_schedules_status_idx` — B-tree sur `status`

**Formule :** `volume_jour_N = min(daily_volume_cap × ramp_multiplier^(N-1), max_daily_volume)`

---

## 11. Automatisation

### `automation_workflows`

Séquences email automatiques déclenchées par des événements.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `name` | `text` | NOT NULL | Nom du workflow |
| `description` | `text` | nullable | Description |
| `status` | `text` | NOT NULL, default "draft" | `draft` / `active` / `paused` / `archived` |
| `trigger_type` | `text` | NOT NULL | Type de déclencheur |
| `trigger_config` | `jsonb` | NOT NULL, default `{}` | Configuration du déclencheur |
| `steps` | `jsonb` | NOT NULL, default `[]` | Étapes du workflow |
| `total_enrolled` | `integer` | NOT NULL, default 0 | Total inscrits |
| `total_completed` | `integer` | NOT NULL, default 0 | Total terminés |
| `total_failed` | `integer` | NOT NULL, default 0 | Total échoués |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |
| `updated_at` | `timestamp` | NOT NULL, default NOW | Dernière modification |

**Déclencheurs :** `subscriber_added`, `tag_added`, `tag_removed`, `subscriber_opened`, `subscriber_clicked`  
**Types d'étapes :** `send_email`, `wait`, `add_tag`, `remove_tag`

**Index :**
- `automation_workflows_status_idx` — B-tree sur `status`
- `automation_workflows_trigger_type_idx` — B-tree sur `trigger_type`

---

### `automation_enrollments`

Contacts inscrits dans un workflow d'automatisation.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `workflow_id` | `varchar` | NOT NULL, FK → `automation_workflows.id` (CASCADE) | Workflow |
| `subscriber_id` | `varchar` | NOT NULL, FK → `subscribers.id` (CASCADE) | Contact |
| `current_step_index` | `integer` | NOT NULL, default 0 | Étape actuelle (0-based) |
| `status` | `text` | NOT NULL, default "active" | `active` / `completed` / `failed` / `cancelled` |
| `enrolled_at` | `timestamp` | NOT NULL, default NOW | Date d'inscription |
| `next_action_at` | `timestamp` | nullable | Prochaine action planifiée |
| `completed_at` | `timestamp` | nullable | Date de fin |
| `last_error` | `text` | nullable | Dernière erreur |

**Index :**
- `automation_enrollments_workflow_idx` — B-tree sur `workflow_id`
- `automation_enrollments_subscriber_idx` — B-tree sur `subscriber_id`
- `automation_enrollments_status_idx` — B-tree sur `status`
- `automation_enrollments_next_action_idx` — B-tree sur `next_action_at`
- `automation_enrollments_unique_idx` — **UNIQUE** sur `(workflow_id, subscriber_id)` → un contact ne peut être inscrit qu'une fois par workflow

---

## 12. Analytics

### `analytics_daily`

Métriques agrégées par jour et par campagne.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `date` | `timestamp` | NOT NULL | Jour |
| `campaign_id` | `varchar` | FK → `campaigns.id` | Campagne (nullable pour métriques globales) |
| `total_sent` | `integer` | NOT NULL, default 0 | Emails envoyés |
| `total_delivered` | `integer` | NOT NULL, default 0 | Emails délivrés |
| `total_opens` | `integer` | NOT NULL, default 0 | Ouvertures totales |
| `unique_opens` | `integer` | NOT NULL, default 0 | Ouvertures uniques |
| `total_clicks` | `integer` | NOT NULL, default 0 | Clics totaux |
| `unique_clicks` | `integer` | NOT NULL, default 0 | Clics uniques |
| `total_bounces` | `integer` | NOT NULL, default 0 | Bounces |
| `total_unsubscribes` | `integer` | NOT NULL, default 0 | Désinscriptions |
| `total_complaints` | `integer` | NOT NULL, default 0 | Plaintes |
| `subscriber_growth` | `integer` | NOT NULL, default 0 | Croissance contacts |
| `subscriber_churn` | `integer` | NOT NULL, default 0 | Perte contacts |
| `updated_at` | `timestamp` | NOT NULL, default NOW | Dernière mise à jour |

**Index :**
- `analytics_daily_date_idx` — B-tree sur `date`
- `analytics_daily_campaign_idx` — B-tree sur `campaign_id`
- `analytics_daily_date_campaign_idx` — **UNIQUE** sur `(date, campaign_id)`

---

### `dashboard_cache`

Cache clé/valeur pour les données du tableau de bord.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `key` | `text` | NOT NULL, UNIQUE | Clé du cache |
| `value` | `jsonb` | NOT NULL | Valeur JSON |
| `updated_at` | `timestamp` | NOT NULL, default NOW | Dernière mise à jour |

---

## 13. Maintenance

### `db_maintenance_rules`

Règles de nettoyage automatique configurables par table.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `table_name` | `text` | NOT NULL, UNIQUE | Nom de la table à nettoyer |
| `display_name` | `text` | NOT NULL | Nom affiché |
| `description` | `text` | nullable | Description |
| `retention_days` | `integer` | NOT NULL, default 90 | Jours de rétention |
| `enabled` | `boolean` | NOT NULL, default true | Règle activée |
| `last_run_at` | `timestamp` | nullable | Dernier nettoyage |
| `last_rows_deleted` | `integer` | default 0 | Lignes supprimées au dernier run |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |

**Règles par défaut :**

| Table | Rétention |
|-------|-----------|
| `nullsink_captures` | 7 jours |
| `campaign_sends` | 180 jours |
| `pending_tag_operations` | 7 jours |
| `campaign_jobs` | 30 jours |
| `import_job_queue` | 30 jours |
| `error_logs` | 30 jours |
| `session` | 7 jours |

**Fréquence :** Toutes les 6 heures. Batches de 1 000 lignes, maximum 50 000 par run. Mutex pour empêcher les exécutions concurrentes.

---

### `db_maintenance_logs`

Historique des exécutions de maintenance.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `rule_id` | `varchar` | NOT NULL, FK → `db_maintenance_rules.id` | Règle exécutée |
| `table_name` | `text` | NOT NULL | Table nettoyée |
| `rows_deleted` | `integer` | NOT NULL, default 0 | Lignes supprimées |
| `duration_ms` | `integer` | NOT NULL, default 0 | Durée (ms) |
| `status` | `text` | NOT NULL, default "success" | `success` / `error` |
| `error_message` | `text` | nullable | Message d'erreur |
| `triggered_by` | `text` | NOT NULL, default "auto" | `"auto"` ou `"manual"` |
| `executed_at` | `timestamp` | NOT NULL, default NOW | Date d'exécution |

**Index :**
- `db_maint_log_rule_idx` — B-tree sur `rule_id`
- `db_maint_log_executed_idx` — B-tree sur `executed_at`

---

## 14. Système (Auth, Sessions, Erreurs)

### `users`

Comptes utilisateurs avec authentification par session.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `username` | `text` | NOT NULL, UNIQUE | Nom d'utilisateur |
| `password` | `text` | NOT NULL | Mot de passe hashé (bcrypt, cost factor 12) |
| `created_at` | `timestamp` | NOT NULL, default NOW | Date de création |

---

### `session`

Sessions utilisateur gérées par `connect-pg-simple`.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `sid` | `varchar` | PK | Identifiant de session |
| `sess` | `jsonb` | NOT NULL | Données de session |
| `expire` | `timestamp` | NOT NULL | Date d'expiration (24h) |

**Sécurité :** Cookies `httpOnly`, `sameSite=lax`, durée de vie 24h.

---

### `error_logs`

Journal centralisé de toutes les erreurs système.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | `varchar` | PK, UUID auto | Identifiant unique |
| `type` | `text` | NOT NULL | `send_failed` / `import_failed` / `import_row_failed` / `campaign_failed` / `system_error` / `campaign_paused` |
| `severity` | `text` | NOT NULL, default "error" | `error` / `warning` / `info` |
| `message` | `text` | NOT NULL | Message d'erreur |
| `details` | `text` | nullable | Détails (stack trace, etc.) |
| `campaign_id` | `varchar` | FK → `campaigns.id` | Campagne concernée |
| `subscriber_id` | `varchar` | FK → `subscribers.id` | Contact concerné |
| `import_job_id` | `varchar` | FK → `import_jobs.id` | Import concerné |
| `email` | `text` | nullable | Email de référence (conservé même si le contact est supprimé) |
| `timestamp` | `timestamp` | NOT NULL, default NOW | Date de l'erreur |

**Index :**
- `error_logs_type_idx` — B-tree sur `type`
- `error_logs_timestamp_idx` — B-tree sur `timestamp`
- `error_logs_campaign_idx` — B-tree sur `campaign_id`
- `error_logs_severity_idx` — B-tree sur `severity`

---

## 15. Diagramme des relations

```
┌──────────────────────────────────────────────────────────────────┐
│                        CORE DOMAIN                               │
│                                                                  │
│  ┌────────────┐     ┌────────────┐     ┌──────────┐             │
│  │ subscribers │────▶│ campaign_  │◀────│campaigns │             │
│  │            │     │ sends      │     │          │             │
│  │  email     │     │ (1 par     │     │  name    │             │
│  │  tags[]    │     │  envoi)    │     │  subject │             │
│  │  ip_addr   │     └────────────┘     │  html    │             │
│  └─────┬──────┘                        │  status  │             │
│        │            ┌────────────┐     └────┬─────┘             │
│        ├───────────▶│ campaign_  │──────────┘                   │
│        │            │ stats      │     ┌──────────┐             │
│        │            │ (opens/    │     │  mtas    │             │
│        │            │  clicks)   │     │  (SMTP   │             │
│        │            └────────────┘     │  config) │             │
│        │                               └────┬─────┘             │
│        │                                    │                   │
│        │            ┌────────────┐     ┌────┴─────┐             │
│        ├───────────▶│ pending_   │     │ warmup_  │             │
│        │            │ tag_ops    │     │ schedules│             │
│        │            └────────────┘     └──────────┘             │
│        │                                                        │
│        │            ┌────────────┐     ┌──────────┐             │
│        ├───────────▶│ automation_│◀────│automation│             │
│        │            │ enrollments│     │_workflows│             │
│        │            └────────────┘     └──────────┘             │
│        │                                                        │
│        │            ┌────────────┐                              │
│        └───────────▶│ error_logs │                              │
│                     └────────────┘                              │
│                                                                  │
│  campaigns ───▶ campaign_jobs (file d'attente envoi)            │
│  campaigns ───▶ ab_test_variants                                │
│  campaigns ───▶ nullsink_captures (mode test)                   │
│  campaigns ───▶ analytics_daily                                 │
│  segments  ◀─── campaigns.segment_id                            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                       IMPORT PIPELINE                            │
│                                                                  │
│  import_jobs ───▶ import_job_queue ───▶ import_staging           │
│  (historique)     (file d'attente)      (table temporaire)       │
│                                         → merge vers subscribers │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                     MAINTENANCE & SYSTÈME                        │
│                                                                  │
│  db_maintenance_rules ───▶ db_maintenance_logs                   │
│  users ─── session (connect-pg-simple)                           │
│  flush_jobs (suppression en masse)                               │
│  dashboard_cache (cache tableau de bord)                         │
│  email_headers (en-têtes SMTP globaux)                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 16. Files d'attente (Job Queues)

Le système utilise **4 files d'attente PostgreSQL** avec notification instantanée :

| File | Table | Canal NOTIFY | Workers max | Mécanisme |
|------|-------|-------------|-------------|-----------|
| Envoi campagnes | `campaign_jobs` | `campaign_jobs` | 5 concurrents | `FOR UPDATE SKIP LOCKED` |
| Import CSV | `import_job_queue` | `import_jobs` | 1 | `FOR UPDATE SKIP LOCKED` + heartbeat |
| Opérations tags | `pending_tag_operations` | `tag_operations` | 1 (batch 50) | Claim par batch |
| Flush contacts | `flush_jobs` | `flush_jobs` | 1 | `FOR UPDATE SKIP LOCKED` + heartbeat |

**Architecture :**
1. Le producteur insère un job et exécute `NOTIFY <canal>`
2. Le consumer écoute via `LISTEN <canal>` (connexion PostgreSQL dédiée)
3. À la réception du signal, le consumer tente de réclamer le job avec `FOR UPDATE SKIP LOCKED`
4. Si la notification est ratée (déconnexion), fallback automatique vers polling périodique
5. Advisory locks empêchent les collisions multi-worker

---

## 17. Indexation & Performance

### Résumé des index

| Table | Index | Type | Colonnes | Objectif |
|-------|-------|------|----------|----------|
| `subscribers` | `email_idx` | B-tree | `email` | Recherche par email |
| `subscribers` | `tags_gin_idx` | **GIN** | `tags` | Recherche dans les tableaux de tags |
| `campaign_sends` | `campaign_sends_unique_idx` | **UNIQUE** | `(campaign_id, subscriber_id)` | Anti-doublon d'envoi |
| `campaign_sends` | `campaign_sends_campaign_idx` | B-tree | `campaign_id` | Filtrage par campagne |
| `campaign_sends` | `campaign_sends_status_idx` | B-tree | `status` | Filtrage par statut |
| `campaign_stats` | `campaign_stats_campaign_idx` | B-tree | `campaign_id` | Stats par campagne |
| `campaign_stats` | `campaign_stats_subscriber_idx` | B-tree | `subscriber_id` | Stats par contact |
| `campaign_jobs` | `campaign_jobs_status_created_idx` | Composite | `(status, created_at)` | Job polling efficace |
| `automation_enrollments` | `automation_enrollments_unique_idx` | **UNIQUE** | `(workflow_id, subscriber_id)` | Anti-doublon inscription |
| `analytics_daily` | `analytics_daily_date_campaign_idx` | **UNIQUE** | `(date, campaign_id)` | Unicité par jour/campagne |

### Index supplémentaires créés dynamiquement (au démarrage de l'application)

- **`email_trgm_idx`** — Index GIN avec `gin_trgm_ops` sur `subscribers.email` via l'extension `pg_trgm` (recherche floue/partielle rapide, créé avec `CREATE INDEX CONCURRENTLY` dans `storage.ts`)

### Optimisations de requêtes

- **Segment count caching** — les comptages de segments sont mis en cache avec TTL de 10s
- **Bulk operations** — `bulkReserveSendSlots` utilise `UNNEST` pour les insertions massives
- **CTE combinées** — `bulkFinalizeSends` combine success/failed/counter updates en un seul round-trip DB
- **Write-behind buffer** — accumule les résultats d'envoi et flush vers la DB sur seuils (2500/5000 count ou 3/5 secondes)

---

## 18. Mécanismes de sécurité des données

| Mécanisme | Implémentation | Tables concernées |
|-----------|---------------|-------------------|
| Anti-doublon envoi | Index UNIQUE `(campaign_id, subscriber_id)` | `campaign_sends` |
| Anti-doublon inscription | Index UNIQUE `(workflow_id, subscriber_id)` | `automation_enrollments` |
| Anti-deadlock flush | Retry avec backoff exponentiel (5 tentatives) | `subscribers`, tables dépendantes |
| Transactions atomiques | DB transactions pour create/update/resume+job, import job+queue | `campaigns`, `campaign_jobs`, `import_jobs` |
| Idempotent job enqueue | Vérification d'existence avant création | `campaign_jobs` |
| Heartbeat workers | Mise à jour périodique pendant traitement long | `import_job_queue`, `flush_jobs`, `campaign_jobs` |
| Crash recovery | Auto-resume des campagnes au redémarrage serveur | `campaigns`, `campaign_jobs` |
| Optimistic locking | Compteurs atomiques via `SET sent_count = sent_count + N` | `campaigns` |
| Chiffrement mots de passe MTA | AES-256-GCM au repos, compatible legacy plaintext | `mtas.password` |
| Hash mots de passe utilisateurs | bcrypt cost factor 12 | `users.password` |
| HMAC tracking URLs | SHA-256 avec vérification timing-safe | URLs de tracking |
| Cascade deletes | `ON DELETE CASCADE` sur les FK enfants | `pending_tag_operations`, `automation_enrollments`, `ab_test_variants`, `warmup_schedules` |

---

## 19. Tag BCK — Blacklist Master

Le tag `BCK` est le **tag de blacklist système**. Tout contact possédant ce tag est automatiquement exclu de **tous** les envois.

### Où le filtre BCK est appliqué :

| Composant | Fichier | Mécanisme |
|-----------|---------|-----------|
| Récupération subscribers pour envoi | `storage.ts` | `NOT ('BCK' = ANY(tags))` dans la clause WHERE |
| Comptage subscribers segment | `storage.ts` | `NOT ('BCK' = ANY(tags))` |
| Preview segment | `storage.ts` | `NOT ('BCK' = ANY(tags))` |
| Segment compiler (count) | `segment-compiler.ts` | `AND NOT ('BCK' = ANY(tags))` |
| Segment compiler (select) | `segment-compiler.ts` | `AND NOT ('BCK' = ANY(tags))` |
| Segment compiler (cursor) | `segment-compiler.ts` | `AND NOT ('BCK' = ANY(tags))` |

### Comment un contact reçoit le tag BCK :

| Événement | Fichier | Mécanisme |
|-----------|---------|-----------|
| Désinscription (unsubscribe) | `tracking.ts` | `enqueueTagOperation(subscriberId, "BCK", "unsubscribe")` |
| Bounce (hard/soft) | `webhooks.ts` | Ajout direct `tags: [...currentTags, "BCK", "bounce:type"]` |
| Plainte spam | `webhooks.ts` | Ajout direct `tags: [...currentTags, "BCK"]` |
| Manuel | UI | Ajout du tag "BCK" via l'éditeur de tags |

### Indicateur visuel

Dans l'interface, les contacts blacklistés affichent un badge rouge **"Blacklisted"** avec une icône bouclier dans :
- La liste des subscribers
- Le dialogue d'édition des tags

---

## 20. Cycle de vie d'une campagne

```
                    ┌─────────┐
                    │  draft  │  ← Création initiale
                    └────┬────┘
                         │ Planification ou envoi immédiat
                    ┌────▼─────┐
              ┌─────│scheduled │  ← Optionnel (scheduledAt défini)
              │     └────┬─────┘
              │          │ Heure atteinte
              │     ┌────▼────┐
              │     │ sending │  ← campaign_job créé, worker actif
              │     └────┬────┘
              │          │
              │    ┌─────┼──────────┐
              │    │     │          │
         ┌────▼────▼┐ ┌──▼───┐ ┌───▼────┐
         │ paused   │ │failed│ │completed│
         │(mta_down)│ └──────┘ └────────┘
         └────┬─────┘
              │ Resume manuel ou auto
              │ (retry 12h window)
              └────────▶ sending
```

**Tables impliquées :**
1. `campaigns` — statut et compteurs
2. `campaign_jobs` — job dans la file d'attente
3. `campaign_sends` — une ligne par email envoyé
4. `campaign_stats` — opens/clicks enregistrés
5. `pending_tag_operations` — tags ajoutés suite aux interactions

---

## 21. Cycle de vie d'un import CSV

```
  Upload CSV              Création job          Worker pickup
  (chunked) ──▶ import_jobs ──▶ import_job_queue ──▶ Processing
                (status:pending)  (status:pending)

  Processing:
  1. Lecture CSV par stream
  2. COPY vers import_staging (batches 25k, 4 COPY parallèles)
  3. INSERT...ON CONFLICT merge/override vers subscribers
  4. Nettoyage import_staging
  5. Mise à jour compteurs import_jobs
  6. Status → completed
```

**Capacité :** Fichiers jusqu'à 1 Go, 7M+ lignes.  
**Performance :** Pipeline COPY avec sémaphore de backpressure (4 opérations concurrentes max).  
**Reprise :** Checkpoint par `last_checkpoint_line` en cas d'interruption.

---

## Annexe : Variables d'environnement liées à la DB

| Variable | Description |
|----------|-------------|
| `NEON_DATABASE_URL` | URL de connexion PostgreSQL Neon (prioritaire) |
| `DATABASE_URL` | URL de connexion PostgreSQL (fallback) |
| `SESSION_SECRET` | Secret pour signer les cookies de session |

**Configuration SSL :** Activée automatiquement quand l'URL contient un hôte Neon (détection par pattern).  
**Connection pooling :** Géré par le pooler Neon côté serveur.  
**LISTEN/NOTIFY :** Connexion PostgreSQL dédiée séparée du pool principal.

---

*Document généré le 23 février 2026 — Critsend v1.0*
