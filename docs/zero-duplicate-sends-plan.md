# Plan « 0 doublon » — exactly-once par (campagne, destinataire)

> **Règle absolue visée** : un même destinataire ne reçoit **jamais** deux fois la
> même campagne. Aucune tolérance, y compris en cas de crash, redémarrage,
> retry, auto-requeue ou requeue manuel.
>
> **Statut** : **implémenté derrière le flag `ZERO_DUP_SEND_GUARD` (OFF par
> défaut → déploiement inerte, réversible).**

---

## 0. Écart d'implémentation vs ce plan (À LIRE EN PREMIER)

Le plan d'origine (§3.1/§3.2) proposait **deux nouvelles valeurs de statut**
(`uncertain`, `failed_retryable`). **Cette approche a été abandonnée** après
audit des lecteurs (`campaign_sends.status` est lu par ~10 endroits :
stats, compteurs, UI, SSE, exports) : introduire de nouvelles valeurs aurait
silencieusement cassé ces lecteurs. Conception **réellement livrée** :

- **Statut inchangé** : `status ∈ {pending, attempting, sent, failed}`.
- **Une seule colonne discriminante nullable** : `smtp_outcome_class`
  (`'delivered'` | `'pre_data_retryable'` | `'ambiguous'`).
- **Équivalences** :
  - `uncertain` (plan) **≡** `status='failed'` **+** `smtp_outcome_class='ambiguous'` (terminal, jamais renvoyé).
  - `failed_retryable` (plan) **≡** `status='failed'` **AND** `smtp_outcome_class IS DISTINCT FROM 'ambiguous'` (inclut le `NULL` legacy → rétro-compatible).
- Les colonnes `wire_attempted_at` / `smtp_error_code` / `finalized_at` du plan
  n'ont **pas** été ajoutées (non nécessaires : le discriminant seul suffit à la
  règle « 0 doublon »). Le ledger §7 (`campaign_send_attempts`) reste optionnel.

### Couverture des DEUX chemins d'envoi
La règle est appliquée sur **tout** chemin qui finalise une ligne `campaign_sends` :
1. **Sender principal** — `campaign-sender.ts` (boucle + phase de retry).
2. **Drain pressure-guard** — `pressure-guard-worker.ts` (envoi des `deferred`).
   Ce 2ᵉ chemin **n'était pas dans le plan initial** : il envoie via
   `sendEmailWithNullsink`, finalise `attempting→sent/failed` et possède son
   propre auto-requeue. Sans correctif il renvoyait les résultats ambigus →
   doublons. Désormais : timeout/exception/`success=false` sans classe
   pré-DATA ⇒ `failed` + `ambiguous` ; son auto-requeue passe par
   `autoRequeueCampaignFailed` (déjà filtré sur le discriminant).

> **Invariant** : tout nouveau chemin d'envoi DOIT router les issues ambiguës
> vers `failed` + `smtp_outcome_class='ambiguous'`, sinon il réintroduit des
> doublons. Garde unitaire : `tests/send-guard.test.ts`.

---

## 1. Cause racine (une seule, systémique)

Tout le système part d'une hypothèse fausse :

> « Tout résultat SMTP qui n'est pas un `250 OK` signifie que le message n'a pas
> été délivré → on peut le renvoyer sans risque. »

Or **le SMTP est *at-least-once*** : un timeout ou une coupure **après** l'envoi
du corps du message (commande `DATA`), ou un crash après le `250 OK` mais avant
l'écriture en base, **ne veut pas dire « non délivré »**. Renvoyer ces cas
produit des doublons : même campagne, même destinataire, **message-id
différent** — exactement ce que remonte le filtre anti-spam (~1,7
signalement / destinataire).

---

## 2. Audit exhaustif — les 7 vecteurs de doublon confirmés

Tous les chemins qui peuvent provoquer un **second envoi SMTP réel** d'une ligne
`campaign_sends` déjà (peut-être) délivrée :

| # | Vecteur | Emplacement | Pourquoi ça duplique | Visible dans `retry_count` ? |
|---|---------|-------------|----------------------|------------------------------|
| 1 | **Retry inline** dans `sendEmail` (`MAX_RETRIES=3`) | `email-service.ts` ~771-796 (+ `sendMailBounded` ~196-217) | Réessaie sur `ETIMEDOUT` (dont le timeout 60s), `ECONNRESET`, `ESOCKET` — précisément les cas « post-DATA ambigus ». Renvoie ensuite `success:true` → ligne `sent`, `retry_count=0`. | **Non — invisible** |
| 2 | **Phase de retry** du sender | `campaign-sender.ts` ~976-1075 | Renvoie en SMTP **toute** ligne `status='failed'`, en boucle jusqu'à 12h. Une ligne « failed » pour cause ambiguë (en fait délivrée) est renvoyée. | Oui |
| 3 | **`autoRequeueCampaignFailed`** | `campaign-repository.ts` ~869-924 | Repasse `failed→pending` + ré-enfile un job → la phase de retry renvoie. Tracé par `campaigns.auto_retry_count`. | Oui |
| 4 | **Fenêtre de crash** | `sendMail` 250 OK puis crash avant `bulkFinalizeSends` (`campaign-repository.ts` ~1015) | Ligne bloquée `attempting` → `orphaned-sends-reconciler.ts` ~61 la passe `attempting→failed` après 1h → vecteurs 2/3 la renvoient. Le commentaire du réconciliateur affirme « aucun risque de doublon » : **c'est faux**. | Oui |
| 5 | **Exception post-envoi** | `campaign-sender.ts` ~832-836 | Un rejet `Promise.allSettled` **après** un `sendMail` réussi pousse l'id dans `pendingFailedIds` → `failed` → renvoyé. | Oui |
| 6 | **`resetOrphanedFailedSends` (DELETE)** | `campaign-repository.ts` ~929 (sur `/resume`) | Supprime les lignes `failed` (`retry_count=0`, sans open/click) → la passe principale ré-réserve (l'`ON CONFLICT DO NOTHING` ne bloque plus) → renvoie avec `retry_count=0`. | **Non — invisible** |
| 7 | **`/requeue`** | route campagne | Réinitialise la campagne ; le sender ré-réserve tout destinataire sans ligne `campaign_sends`. | Selon usage |

### Mesures prod (2026-06-30, lecture seule)
- Taux de renvoi **visible** : 0,2 % à 1,7 % des destinataires ont `retry_count ≥ 1` (jusqu'à 3 envois).
- Les vecteurs **1** et **6** sont **invisibles** à cette mesure → la duplication réelle est **supérieure** à ce chiffre.
- Les destinataires en doublon sont largement surreprésentés parmi les plaintes → cohérent avec le 1,7.

### Déjà sûr — **ne pas toucher**
- A/B : même `campaign_id`, bloqué par `campaign_sends_unique_idx`.
- Follow-ups : `campaign_id` distinct (comportement voulu).
- Drain pressure-guard vs sender principal : claim exclusif (flip de statut + `SKIP LOCKED`).
- Reprise normale : `ON CONFLICT DO NOTHING` protège les lignes déjà `sent`/`failed`.

---

## 3. Architecture cible — « at-most-once après tentative sur le fil »

Principe : **dès qu'un message peut avoir touché le fil (`sendMail` appelé),
la ligne ne doit JAMAIS être renvoyée.** On n'autorise un renvoi **que** s'il
existe une **preuve certaine** que `DATA` n'a jamais été accepté.

### 3.1 Machine d'état

```
pending ──claim──▶ attempting ──┬─ 250 OK ─────────────▶ sent          (terminal)
                                ├─ ambigu (timeout/reset/
                                │   exception/crash) ────▶ uncertain     (terminal, JAMAIS renvoyé)
                                └─ échec PROUVÉ pré-DATA ▶ failed_retryable (seul état renvoyable)
```

- **Terminaux non renvoyables** : `sent`, `uncertain`, `failed` (hard).
- **Seul état renvoyable** : `failed_retryable` (échec franc avant `DATA`).
- Une ligne `attempting` orpheline (crash) est réconciliée vers **`uncertain`**, **pas** `failed`.

### 3.2 Schéma (impact sur une table de 147M lignes)

`campaign_sends.status` est une **colonne `text`** → pas d'`ALTER TYPE` enum, pas
de réécriture massive. On ajoute uniquement de nouvelles **valeurs de statut**
(`uncertain`, `failed_retryable`) + des colonnes **nullable légères** (online,
sans backfill) :

- `wire_attempted_at timestamptz` — posé **avant** chaque `sendMail`.
- `smtp_outcome_class text` — `delivered` | `ambiguous` | `pre_data_retryable`.
- `smtp_error_code text` (diagnostic).
- `finalized_at timestamptz`.

> Aucun backfill : les lignes historiques restent `sent`/`failed` et sont
> ignorées par les nouveaux sélecteurs de retry (qui exigent
> `status='failed_retryable'`).

### 3.3 Classifier SMTP (`email-service.ts`)

- **Supprimer** la boucle `MAX_RETRIES` inline autour de `sendMailBounded`
  (vecteur 1) — derrière un flag, **off par défaut**.
- Nodemailer **ne garantit pas** de savoir si `DATA` a été envoyé avant l'erreur
  → **défaut sûr = `ambiguous`** pour `ETIMEDOUT` (dont le timeout 60s),
  `ECONNRESET`, `ESOCKET`.
- `pre_data_retryable` **uniquement** sur preuve : `ECONNREFUSED`, échec d'auth,
  4xx/5xx explicite sur `MAIL FROM`/`RCPT TO`, ou erreur **avant** l'appel
  `sendMail`.
- 5xx après `DATA` = `failed` hard (refus définitif, pas de renvoi).

---

## 4. Correctifs par vecteur

1. **Retry inline** : retirer / flag off. Aucun retry sur erreur réseau ou timeout.
2. **Phase de retry** : ne sélectionner que `status='failed_retryable'`. Exclure le `failed` legacy en mode strict.
3. **`autoRequeueCampaignFailed`** : ne plus faire `failed→pending` global ; seulement `failed_retryable`.
4. **Crash `attempting`** : le réconciliateur passe les `attempting` anciens en **`uncertain`** (jamais `failed`) → jamais renvoyés. Corriger le commentaire trompeur.
5. **Exception post-envoi** : si `sendMail` a résolu, finaliser **`sent`** ; une erreur de bookkeeping va en log/compensation, **jamais** `failed`.
6. **`resetOrphanedFailedSends`** : supprimer cette DELETE (ou la restreindre à `failed_retryable` sans `wire_attempted_at`). **Ne jamais supprimer une ligne qui assurait l'unicité.**
7. **`/requeue`** : ne jamais DELETE/reset les lignes `campaign_sends` ; ne repartir que sur les destinataires **sans ligne**, ou explicitement `failed_retryable`.

### Interaction avec la complétion de campagne
La porte de complétion (une campagne ne se termine pas tant qu'il reste des
`failed` renvoyables) doit désormais se baser sur **`failed_retryable`**
uniquement. `uncertain` et `failed` hard sont terminaux → ils n'empêchent pas la
complétion et ne provoquent aucun renvoi.

---

## 5. Arbitrage produit à valider (décision opérateur)

Choisir « ne jamais renvoyer un résultat ambigu » implique qu'un email
**réellement non délivré** mais au résultat ambigu **ne sera pas réessayé**
(légère sous-livraison ponctuelle), en échange de **zéro doublon**.

➡️ **C'est le défaut obligatoire pour tenir la règle « 0 doublon ».** Le seul
renvoi conservé est celui des échecs francs **pré-DATA** (`failed_retryable`),
qui sont par définition non délivrés. **À confirmer.**

---

## 6. Déploiement séquencé (feature-flag + kill-switch)

Drapeau global `ZERO_DUP_SEND_GUARD` (+ sous-flags), déployé **inerte** d'abord.

1. **Migration online** : nouvelles colonnes nullable + nouvelles valeurs de statut. Aucun backfill. (via skill `database` pour le plan online + skill `deployment` pour le rollout prod).
2. **Classifier + suppression du retry inline** (vecteur 1).
3. **Réconciliateur `attempting→uncertain`** (vecteur 4) + finalisation post-exception (vecteur 5).
4. **Restriction des sélecteurs de retry / auto-requeue** à `failed_retryable` (vecteurs 2, 3).
5. **Neutralisation de `resetOrphanedFailedSends` et `/requeue`** (vecteurs 6, 7).
6. **Ledger d'audit** (ci-dessous).

Kill-switch : `ZERO_DUP_SEND_GUARD=false` rétablit l'ancien comportement.

---

## 7. Vérification (l'app ne tourne pas en local)

### Tests unitaires
- Table de vérité du classifier (chaque code/erreur → classe attendue).
- Transitions d'état pour les 7 vecteurs (un `attempting` orphelin → `uncertain`, jamais re-sélectionné).
- Simulation de crash : preuve qu'aucune ligne `uncertain`/`sent` ne revient en `pending`/`failed_retryable`.

### Ledger d'audit (recommandé — il n'existe aujourd'hui aucun registre par message)
Table append-only `campaign_send_attempts(campaign_id, subscriber_id, send_row_id, attempt_started_at, outcome_class, message_id)`. Permet de **prouver** le 0 doublon :

```sql
-- Après cutover : aucune (campagne, destinataire) avec >1 tentative sur le fil
SELECT campaign_id, subscriber_id, COUNT(*) c
FROM campaign_send_attempts
WHERE attempt_started_at > :cutover
GROUP BY 1,2 HAVING COUNT(*) > 1;   -- doit être vide
```

### Sondes prod (lecture seule) post-déploiement
- Aucune ligne ne transitionne `uncertain`/`sent` → `pending`/`failed_retryable`.
- Les sélecteurs de retry ne renvoient aucune ligne avec `wire_attempted_at IS NOT NULL`.
- Compteurs Prometheus par classe SMTP (`delivered`/`ambiguous`/`pre_data_retryable`).

---

## 8. Résumé décisionnel

| Question | Réponse proposée |
|----------|------------------|
| Renvoyer un résultat **ambigu** ? | **Non** — terminal `uncertain`. |
| Renvoyer un **échec franc pré-DATA** ? | **Oui** — `failed_retryable` (non délivré par définition). |
| Renvoyer une ligne **`attempting` après crash** ? | **Non** — réconciliée en `uncertain`. |
| Supprimer des lignes `failed` puis ré-réserver ? | **Non** — on retire ce comportement. |
| Backfill des 147M lignes ? | **Non** — colonnes nullable, nouvelles valeurs de statut. |
| Réversible ? | **Oui** — `ZERO_DUP_SEND_GUARD=false`. |
