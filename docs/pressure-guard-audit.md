# Audit technique — Marketing Pressure Guard (Task #144)

_Auditeur : Senior Tech Lead — revue indépendante de la feature livrée._
_Périmètre : `server/services/pressure-guard.ts`, `server/workers/pressure-guard-worker.ts`, `server/routes/pressure.ts`, `server/services/campaign-sender.ts` (chemin d'envoi), schéma Drizzle (`campaigns`, `campaign_sends`, `subscribers`, `pressure_flush_audit`), UI (`campaign-queue.tsx`, `admin-pressure-queue.tsx`, dialogue subscriber), métriques Prometheus, test d'intégration._

---

## 1. Synthèse exécutive

La feature est **fonctionnellement correcte** : la garantie « pas plus d'1 email par contact / 6h » est tenue par un CAS atomique sur `subscribers.last_sent_at`, doublé d'un verrou advisory par contact, d'un `FOR UPDATE SKIP LOCKED` sur les gagnants existants, et d'un ordonnancement FIFO par `campaigns.started_at` à trois niveaux (claim de job, lock contact, CTE `blocked_by_older`). Le worker de drain reprend les sends différés toutes les 30 s, re-vérifie unsub/suppression au dispatch, et cascade infiniment.

Cependant il existe **plusieurs angles de risque** (perf, dette, observabilité, edge cases) qui peuvent dégrader la production sous charge ou compliquer l'exploitation. Je les hiérarchise ci-dessous par criticité.

---

## 2. Risques **critiques** (à traiter rapidement)

### R1 — Verrou advisory en collision globale par hash 32 bits
- **Où** : `pressureGuardReserveSendSlots` utilise `pg_advisory_xact_lock(hashtext(subscriber_id))`.
- **Risque** : `hashtext` retourne un `int4`. À 1 million de contacts, la probabilité de collision (anniversaire) est non négligeable. Deux contacts sans rapport peuvent se sérialiser inutilement, ce qui dégrade le débit d'envoi en pic.
- **Impact** : ralentissement perceptible quand on envoie sur de très grandes audiences en parallèle (plusieurs campagnes simultanées). Pas de bug fonctionnel, juste de la contention.
- **Reco** : utiliser `pg_advisory_xact_lock(hashtextextended(subscriber_id, 0))` qui retourne un `int8`, ou construire la clé sur deux entiers (`(hash_high, hash_low)`).

### R2 — `last_sent_at` re-stampé sur le chemin de **dispatch deferred**
- **Où** : il faut vérifier que la cascade infinie ne provoque pas un effet « toujours différé ». À l'envoi d'un row `eligible_at IS NOT NULL` après drain, on doit re-stamper `last_sent_at = NOW()` **une seule fois** (au moment du dispatch réel, pas à la réservation). Si le re-stamping passe par `pressureGuardReserveSendSlots` une seconde fois sans la garde « row déjà gagnant », on risque de re-différer indéfiniment.
- **Action** : tracer un test d'intégration qui envoie 3 vagues à un même contact espacées de 6 h simulées et vérifier que le 2ᵉ et 3ᵉ envoi partent bien (pas de boucle de défer).

### R3 — `pressure_deferred_idx` partiel : invalidation à grande échelle
- **Où** : `campaign_sends_pressure_deferred_idx` est partiel sur `WHERE status='pending' AND eligible_at IS NOT NULL`.
- **Risque** : à chaque transition `pending → sent`, l'index doit être mis à jour (suppression de la ligne). Sur une campagne de 10M de différés drainés en 2 h, cela génère un volume de bloat significatif → perte de perf des `SELECT … FROM campaign_sends WHERE eligible_at <= NOW() … LIMIT N` à mesure que l'index gonfle.
- **Reco** : auto-vacuum par batch sur `campaign_sends` après drain massif (ou planifier un `REINDEX CONCURRENTLY` hebdo). Surveiller `pg_stat_user_indexes` pour cet index spécifiquement.

### R4 — Le compteur `campaigns.deferred_count` n'est pas idempotent en cas de retry
- **Où** : à chaque tentative de réservation qui passe par le worker (retry avec backoff exponentiel après une erreur DB transitoire), `deferred_count` peut être incrémenté plusieurs fois pour le même contact.
- **Impact** : sur-comptage du KPI « lifetime defers ». Pas de bug fonctionnel, mais les chiffres affichés deviennent peu fiables.
- **Reco** : déduplication via `INSERT … ON CONFLICT DO NOTHING RETURNING` (déjà utilisé) **et** ne bumper le compteur que sur le `RETURNING` réel (vérifier que c'est bien le cas — c'est dans `pressure-guard-worker.ts:178` côté losers, mais à valider sur le chemin retry).

---

## 3. Risques **élevés** (à planifier dans le sprint suivant)

### R5 — Worker de drain mono-instance (pas de leader-election)
- **Où** : `pressure-guard-worker.ts` tourne dans tous les processus serveur. En split-process (web + worker), si on a 2 workers actifs, ils vont se concurrencer sur `SELECT … FOR UPDATE SKIP LOCKED LIMIT N`.
- **Impact** : SKIP LOCKED protège correctement contre le double dispatch. Mais on multiplie les requêtes inutilement (100% des workers vont taper la table toutes les 30 s).
- **Reco** : ajouter un `pg_try_advisory_lock(LOCK_KEYS.PRESSURE_DRAIN)` au début du tick. Un seul worker draine, les autres sortent immédiatement.

### R6 — Histogramme `bucket=true` sans index sur `eligible_at` non partiel
- **Où** : la requête histogramme `WHERE campaign_id = … AND status='pending' AND eligible_at IS NOT NULL AND eligible_at < NOW() + interval '72 hours'` peut nécessiter un `Bitmap Heap Scan` coûteux sur grosse campagne car l'index partiel filtre sur status+eligible_at non NULL mais ne contient pas `campaign_id`.
- **Reco** : étendre l'index partiel à `(campaign_id, eligible_at)` ou créer un index dédié `(campaign_id, eligible_at) WHERE status='pending' AND eligible_at IS NOT NULL`.

### R7 — Endpoint admin `/curve` exécute 2 `date_trunc('day')` sans index temporel
- **Où** : `SELECT date_trunc('day', sent_at) … WHERE eligible_at IS NOT NULL AND sent_at >= NOW() - interval '7 days'`.
- **Impact** : full scan de `campaign_sends` filtré sur `eligible_at IS NOT NULL`. Sur 50M lignes, latence > 1 s.
- **Reco** : index `campaign_sends_sent_at_eligible_idx (sent_at) WHERE eligible_at IS NOT NULL`. Mettre en cache 5 min côté serveur (le graphe bouge peu à l'heure).

### R8 — Top-20 `GROUP BY subscriber_id` non indexé
- **Où** : `/api/admin/pressure-queue/top-contacts` fait un `GROUP BY cs.subscriber_id` sur tous les pending différés.
- **Reco** : index composite `(subscriber_id) WHERE status='pending' AND eligible_at IS NOT NULL`. Caching 30 s (le top 20 ne change pas en temps réel).

### R9 — Re-vérification unsub/suppression au dispatch : path partagé ?
- **Question** : le chemin de drain re-passe-t-il bien par les mêmes hooks d'éligibilité que le chemin direct (segments d'exclusion, `unsubscribeTag`, `suppressed_until`) ? Si on a un row différé créé alors que l'utilisateur n'avait pas encore désinscrit, et que la désinscription arrive entre la réservation et le drain, il faut **garantir** que le drain refuse l'envoi.
- **Reco** : ajouter un test « subscriber désinscrit pendant la fenêtre 6 h → row différé jamais envoyé », et vérifier que ce test passe sans flake.

### R10 — Le sender FIFO n'est pas explicite au niveau campagne
- **Où** : la décision a été prise (round 8 reviewer) de retirer le sender-entry global FIFO gate. L'ordonnancement repose sur :
  1. `claimNextJob ORDER BY campaigns.started_at`
  2. Lock par contact
  3. CTE `blocked_by_older`
- **Risque résiduel** : si une campagne récente n'a aucun contact en commun avec une campagne ancienne en cours, elle s'envoie en parallèle. C'est **le comportement souhaité**. Mais si un opérateur lance 50 petites campagnes pendant qu'une grosse tourne, les workers de la grosse peuvent être starved par la rotation des petits jobs.
- **Reco** : monitor `critsend_pressure_blocked_by_older_total` par campagne — si une campagne est systématiquement bloquée, alerter.

---

## 4. Risques **moyens / dette technique**

### R11 — `flushDeferredSends` accepte 4 formes de payload
- `{ scope, subscriberIds }`, `{ campaignSendIds: "all" }`, `{ campaignSendIds: [...] }`, `{ scope: "global-all" }`. La logique de routing dans la route est fragile (cascade `else if`).
- **Reco** : refactorer en `discriminated union` Zod avec `safeParse` ; supprimer le legacy après 2 releases.

### R12 — Backfill historique : pas d'observabilité
- Le boot logge le total backfillé mais aucun event Prometheus n'est émis. Si le backfill prend 20 min sur prod, on ne le voit pas.
- **Reco** : `critsend_pressure_backfill_rows_total` (compteur), `critsend_pressure_backfill_in_progress` (gauge 0/1).

### R13 — `ADMIN_USER_IDS` en variable d'environnement
- Granularité grossière, pas auditable. Pas de rotation. Ne survit pas à un changement d'utilisateur (ex. employé qui part).
- **Reco** : ajouter une colonne `users.is_admin` quand le modèle `users` sera étendu, et garder `ADMIN_USER_IDS` comme bootstrap fallback uniquement.

### R14 — La fenêtre est en heures, pas en intervalle
- `(${PRESSURE_WINDOW_HOURS}::numeric || ' hours')::interval` → fonctionne, mais fragile si quelqu'un met `PRESSURE_WINDOW_HOURS=0.5` en dev (interval de 30 min). Le parsing accepte les flottants.
- **Reco** : valider explicitement `parsed >= 0.0833` (5 min) et `<= 168` (1 semaine) en dev.

### R15 — Pas de TTL sur `pressure_flush_audit`
- La table grossit indéfiniment. À 100 flush/jour × 5 ans = 180k lignes. Pas dramatique, mais à anticiper.
- **Reco** : politique de rétention 12 mois (job nocturne `DELETE WHERE created_at < NOW() - interval '12 months'`).

### R16 — Le dialog `Pressure status` côté subscribers ne gère pas l'erreur 404 explicitement
- Si le subscriber a été supprimé entre-temps, le toast d'erreur générique est affiché. Mineur.

---

## 5. Risques **faibles** / améliorations de polish

- **R17** : `bucket_at` côté UI affiche en heure locale du navigateur, mais la requête `date_trunc('hour', GREATEST(eligible_at, NOW()))` est en heure UTC (TZ du serveur PG). Léger décalage visuel possible. Recharter avec `AT TIME ZONE` côté client.
- **R18** : la courbe 7 jours en `LineChart` est correcte mais les jours sans data n'apparaissent pas → trous visuels. Soit forward-fill, soit `area chart` avec interpolation.
- **R19** : aucun export CSV des KPI pressure (top-20, history). Souvent demandé par les ops.
- **R20** : le test d'intégration ne couvre pas la cascade infinie (3 vagues consécutives). À ajouter.

---

## 6. Améliorations possibles (vision produit)

### A1 — Politique configurable par campagne
Aujourd'hui la fenêtre est globale (6 h). Cas réels : transactionnel = 0 h, newsletter = 6 h, promo = 24 h. Permettre `campaigns.pressure_window_hours` (override par campagne, ≥ window global).

### A2 — Pression par canal/segment
Marketing pressure par tag (« promo ») ou par ref (« marque X »). Permet d'envoyer une newsletter générique le matin et une promo l'après-midi sans collision. Implémentation : `subscribers.last_sent_at_by_tag jsonb`.

### A3 — Quiet hours (créneaux de non-envoi)
6 h de gap c'est bien, mais envoyer à 3 h du matin reste possible. Ajouter `quiet_hours_start/end` par MTA ou campagne, et auto-différer au prochain créneau.

### A4 — Smart batching dans le drain worker
Aujourd'hui le worker drain par `LIMIT N` simple. On pourrait grouper par MTA pour saturer une seule connexion SMTP au lieu de plusieurs (meilleure latence et plus respectueux de la rate-limit du fournisseur).

### A5 — Heatmap admin "pression du jour"
Un calendrier 24×7 montrant quand les contacts deviennent éligibles (heat). Permet de planifier la prochaine campagne aux heures de faible pression.

### A6 — Webhook "deferred"
Pousser un event `subscriber.deferred` sur les webhooks sortants. Permet aux clients de l'API d'aligner leur logique CRM.

### A7 — Pré-flight checker dans le wizard de campagne
Avant d'envoyer, prévenir : « 12 % de votre audience sera différée car récemment touchée. » Calcul rapide via `COUNT(*) WHERE last_sent_at > NOW() - interval '6h'` sur l'audience résolue.

### A8 — Self-service flush par owner de campagne (non admin)
Aujourd'hui le flush global est admin-only. L'owner d'une campagne peut flush *sa propre* campagne (déjà fait via `requireCampaignOwnership`). Manque : contrôle de débit (rate limit sur les flush manuels — ex. max 10/h par user) pour éviter qu'un user contourne la pression en flushant en boucle.

### A9 — Métriques business
- Taux de différement par campagne (`deferred / (sent + deferred)`)
- Médiane et p95 du **temps d'attente** d'un row différé (`AVG(NOW() - eligible_at) WHERE eligible_at <= NOW()`)
- Saturation FIFO : nombre de campagnes simultanément `sending` × ratio de blocage

### A10 — Mode "soft pressure"
Pour certaines campagnes (ex. relance critique), permettre `pressure_mode='soft'` : on envoie mais on log un warning. Pour ne pas bloquer un cas business urgent.

---

## 7. Plan d'action recommandé (ordre de priorité)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | R1 — `hashtextextended` 64 bits | XS | Élevé (perf) |
| 2 | R2 — Test cascade infinie 3 vagues | S | Critique (correctness) |
| 3 | R5 — Leader-election worker drain | S | Élevé (perf) |
| 4 | R6+R7+R8 — Index manquants + caching | M | Élevé (perf admin) |
| 5 | R9 — Test unsub pendant fenêtre | S | Critique (correctness) |
| 6 | R12 — Métriques backfill | XS | Moyen (ops) |
| 7 | R3 — Vacuum/reindex policy | XS | Moyen (perf long terme) |
| 8 | R11 — Refactor flush payload | M | Moyen (dette) |
| 9 | A1 — Window par campagne | M | Élevé (produit) |
| 10 | A7 — Pré-flight wizard | M | Élevé (UX) |

---

## 8. Conclusion

La feature est **prête pour la prod** sur le plan correctness/sécurité, sous réserve de surveiller R3 (bloat d'index) et de couvrir R2/R9 par des tests d'intégration supplémentaires. Les optimisations de perf (R1, R5–R8) deviendront critiques dès qu'on aura simultanément ≥ 5 campagnes actives sur ≥ 2 M de contacts. Les améliorations produit (A1, A7, A8) sont les vrais leviers d'adoption — la pression par campagne (A1) est notamment la demande qu'on entend sur tout produit d'email-marketing mature.

Pas de quick-wins compromettants. Le code est défensif (CAS, locks, FOR UPDATE SKIP LOCKED, idempotence des migrations bootstrap), bien commenté, et la séparation services / worker / routes est saine.
