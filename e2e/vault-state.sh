#!/usr/bin/env sh
# What a vault holds, read-only: whether a master password is set and when, how much
# is in it, and every unlock attempt with its outcome.
#
#   sh e2e/vault-state.sh [path/to/vault.db]
#
# Defaults to $XDG_DATA_HOME/rite/vault.db, else ~/.local/share/rite/vault.db.
#
# The attempt log is the part worth having. "The password is refused" and "the vault
# was re-created underneath you" look identical from the UI; the timestamps tell them
# apart, because a master password whose created_at is newer than the data means the
# vault was reset, not mistyped. It reads through SQLite so the WAL is included — a
# live vault keeps recent rows there, and reading only the .db file reports a vault
# with no password at all.
set -eu

VAULT="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/rite/vault.db}"
[ -f "$VAULT" ] || { echo "  no vault at $VAULT"; exit 0; }

python3 - "$VAULT" <<'PY'
import sqlite3, sys, datetime as dt

con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
cur = con.cursor()

def fetch(query):
    try:
        return cur.execute(query).fetchone()
    except sqlite3.Error:
        return None

def when(ms):
    return dt.datetime.fromtimestamp(ms / 1000).isoformat(sep=" ", timespec="seconds")

print(f"  vault            : {sys.argv[1]}")

version = fetch("SELECT MAX(version) FROM schema_version")
print(f"  schema           : v{version[0] if version else '?'}")

pw = fetch("SELECT created_at, updated_at FROM master_password WHERE id = 1")
if pw:
    line = f"set {when(pw[0])}"
    if pw[1] and pw[1] != pw[0]:
        line += f", last changed {when(pw[1])}"
    print(f"  master password  : {line}")
else:
    print("  master password  : NONE — this vault would show the first-run screen")

for table, label in (("collections", "collections"), ("collection_items", "machines")):
    row = fetch(f"SELECT COUNT(*) FROM {table}")
    print(f"  {label:17}: {row[0] if row else '-'}")

print("  unlock attempts  :")
try:
    rows = list(cur.execute("SELECT timestamp, success FROM unlock_attempts ORDER BY id"))
except sqlite3.Error:
    rows = []
if not rows:
    print("     none recorded")
for ts, ok in rows:
    print(f"     {when(ts)}  {'accepted' if ok else 'REFUSED'}")
PY
