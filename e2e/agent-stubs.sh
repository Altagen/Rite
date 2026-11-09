#!/usr/bin/env sh
# Give the harness container something for the agent probe to discover.
#
# It creates a user's files and a fake binary on PATH, so it needs root: run it through
# `sh e2e/harness-up.sh`, which does it inside the container. Not on your machine.
#
# WHY A STUB BINARY. Discovery is gated on `command -v claude` (agentProbe.ts), so a
# machine with transcripts and no CLI reports the tool as absent and reads nothing. The
# LISTING itself is plain shell — `ls -1t ~/.claude/projects/*/*.jsonl` — so the stub only
# has to exist and answer `--version`. The same trick `dashboard-stubs.sh` plays for
# `docker` and `systemctl`, for the same reason: the suite tests Rite's reading of a
# machine, not the vendor's binary.
#
# WHY THE FILES ARE SHAPED LIKE THIS. Three conversations, each for one answer the detail
# panel has to be able to give:
#
#   1. a directory that exists, is a git repository, and is clean — the whole live read
#   2. a directory that is GONE — the panel must say so rather than show a stale branch
#   3. a first prompt long enough to be folded, which is what the panel's order is for
#
# Synthetic, not copied: the shapes were measured on a real machine (ADR 0022), and the
# contents are invented because a harness that carries somebody's transcripts is one
# nobody can run.
set -e
export PATH="/usr/sbin:/sbin:$PATH"

H=/home/riteuser

# The stub. `--version` only, since that is all the probe asks of it.
cat > /usr/local/bin/claude <<'STUB'
#!/bin/sh
case "$1" in
  --version) echo "1.0.0-harness (Claude Code)" ;;
  *) echo "the harness stub does not run agents" >&2; exit 1 ;;
esac
STUB
chmod 755 /usr/local/bin/claude

# A repository for the live read to answer about, in this user's own home.
rm -rf "$H/work"
mkdir -p "$H/work"
git -C "$H/work" init -q -b main
git -C "$H/work" -c user.email=harness@example.invalid -c user.name=harness \
  commit -q --allow-empty -m 'the harness'

turn() { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}\n' "$1"; }

slug="-home-riteuser-work"
mkdir -p "$H/.claude/projects/$slug" "$H/.claude/projects/-home-riteuser-gone"

# 1. The directory exists, on `main`, clean.
f="$H/.claude/projects/$slug/0191e5a1-0001-7000-8000-000000000001.jsonl"
printf '{"type":"mode","mode":"normal","cwd":"%s"}\n' "$H/work" > "$f"
turn "Read the worker queue and say what it does" >> "$f"

# 2. A directory that is gone. The panel must name that, not fall back to a branch.
f="$H/.claude/projects/-home-riteuser-gone/0191e5a1-0002-7000-8000-000000000002.jsonl"
printf '{"type":"mode","mode":"normal","cwd":"%s"}\n' "$H/nowhere-at-all" > "$f"
turn "This one ran somewhere that no longer exists" >> "$f"

# 3. A first prompt that has to be folded. Long on purpose: the panel's order — facts and
# actions above, prompt below behind "see more" — exists because a pasted diff pushed
# every action off the bottom of the panel.
f="$H/.claude/projects/$slug/0191e5a1-0003-7000-8000-000000000003.jsonl"
printf '{"type":"mode","mode":"normal","cwd":"%s"}\n' "$H/work" > "$f"
long="Here is the whole diff to read line by line:"
i=0
while [ $i -lt 40 ]; do
  long="$long check the path at step $i and say whether the queue drains;"
  i=$((i + 1))
done
turn "$long" >> "$f"

# ── WHAT IS IN EFFECT (ADR 0022 §6): two layers, so the panel has something to resolve.
#
# The account layer and the project layer each declare a skill called `commit-conventions`
# — that collision is the point: the project's wins and the account's has to be shown
# LOSING rather than hidden, which is the one thing a reader whose own skill did nothing
# needs to see. The hooks are the reason the panel exists at all, so there is one per
# layer, and the account's is the shape the ADR argues about: a command nobody using this
# directory installed.
mkdir -p "$H/.claude/skills/commit-conventions" "$H/.claude/skills/rust-review" \
         "$H/.claude/commands" \
         "$H/work/.claude/skills/commit-conventions" "$H/work/.claude/skills/deploy-runbook" \
         "$H/work/.claude/commands"
echo '# the account copy' > "$H/.claude/skills/commit-conventions/SKILL.md"
echo '# unopposed'        > "$H/.claude/skills/rust-review/SKILL.md"
echo '# the project copy' > "$H/work/.claude/skills/commit-conventions/SKILL.md"
echo '# project only'     > "$H/work/.claude/skills/deploy-runbook/SKILL.md"
echo '/adr'               > "$H/.claude/commands/adr.md"
echo '/gate'              > "$H/work/.claude/commands/gate.md"

cat > "$H/work/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "ruff format \"$CLAUDE_FILE_PATHS\"" }] }
    ]
  }
}
JSON
cat > "$H/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/usr/local/bin/audit-everything" }] }
    ]
  }
}
JSON
# A file that is NOT json, so the panel's "could not be read" branch has a subject. It is
# the local override, which Claude Code reads after settings.json.
printf '{ this is not json\n' > "$H/work/.claude/settings.local.json"

# COMMITTED, so the repository is CLEAN. The project layer above lives inside the repo,
# so seeding it left the tree dirty — and the panel dutifully reported `uncommitted
# changes` where a test expected `clean`. A harness that makes its own assertion false is
# worse than no harness; the dirty case is seeded by the test that wants it, not here.
git -C "$H/work" add -A
git -C "$H/work" -c user.email=harness@example.invalid -c user.name=harness \
  commit -q -m 'the project layer'

chown -R riteuser:riteuser "$H/.claude" "$H/work"
echo "[agent-stubs] claude stub on PATH, 3 conversations, two context layers under $H"
