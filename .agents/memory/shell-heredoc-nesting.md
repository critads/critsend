---
name: Nested heredocs in ShellExec
description: Why a python3 - <<'EOF' script must never contain another <<'EOF' — it once ran deploy/deploy.sh in the workspace.
---

Never embed a heredoc using the same delimiter (`<<'EOF'`) inside a `python3 - <<'EOF'` (or any) heredoc.

**Why:** bash terminates the outer heredoc at the first line equal to the delimiter, then executes the rest of the block as plain shell. On 2026-09-28 this ran `deploy/deploy.sh` in the dev workspace (git pull, npm ci, npm run build, `drizzle-kit push --force` against NEON_DATABASE_URL, which aborted at an interactive rename prompt — no damage observed, but it could have mutated the DB schema).

**How to apply:** write multi-line file content with the WriteFile/Edit tools; when a shell heredoc is unavoidable, use a distinct delimiter (e.g. `PYEOF`) and keep no other heredoc inside. Also: the dev app connects to NEON_DATABASE_URL (not DATABASE_URL); bootstrap DDL such as `ensureOrangeTestSchema()` lands there.
