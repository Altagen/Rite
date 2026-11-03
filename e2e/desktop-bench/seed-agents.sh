#!/usr/bin/env sh
# Fill a throwaway HOME with agent sessions shaped like real ones, so the manager can be
# looked at under the load it actually meets.
#
# SYNTHETIC, NOT COPIED. The shapes were measured on a real machine — Claude Code's
# `projects/<slug>/<uuid>.jsonl`, Codex's `sessions/YYYY/MM/DD/rollout-<started>-<uuid>`,
# Grok's URL-encoded project directories — and the contents are invented, because a
# bench that carries somebody's transcripts into a screenshot is a bench nobody can run.
#
# The proportions are the measured ones and they are the point: of 61 Codex rollouts on
# that machine, 60 held no human turn at all. A manager that looks fine on four cards is
# not the thing being tested.
#
#   sh e2e/desktop-bench/seed-agents.sh <home>
set -e
H=${1:?usage: seed-agents.sh <home> [path-inside-the-client]}
# Where this home is MOUNTED where the client reads it, which is not where this script
# writes it: the bench seeds on the host and the binary runs in a container with
# `HOME=/bench`. A transcript records an absolute working directory, so the one written
# into it has to be the path the client will resolve, not this script's.
AS=${2:-/bench}

# A real repository for the live read to answer about — a BRANCH is the thing that can
# change between two looks at the same conversation, so the bench needs one it is allowed
# to switch. This one is in the throwaway home and belongs to nobody.
if command -v git >/dev/null 2>&1; then
  rm -rf "$H/repo"
  mkdir -p "$H/repo"
  git -C "$H/repo" init -q -b main
  git -C "$H/repo" -c user.email=bench@example.invalid -c user.name=bench \
    commit -q --allow-empty -m 'the bench'
fi

uuid() { printf '%08x-%04x-7%03x-%04x-%012x' "$1" "$((1000 + $1))" "$1" "$((2000 + $1))" "$1"; }
ask() { printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}\n' "$1"; }

# ── Claude Code: one directory per slugged working directory ────────────────────
i=0
for slug in -srv-acme-api -srv-acme-web -home-dev-notes; do
  mkdir -p "$H/.claude/projects/$slug"
  for n in 1 2; do
    i=$((i + 1))
    f="$H/.claude/projects/$slug/$(uuid $i).jsonl"
    # The working directory, where the real transcripts carry it — on an early line, which
    # is what lets the live read find it with a bounded `head`. The first conversation
    # points at the repository above; the second at a directory that does not exist, which
    # is the other answer the panel has to be able to give.
    case $i in
      1) cwd=$AS/repo ;;
      2) cwd=$AS/nowhere-at-all ;;
      *) cwd=$AS/elsewhere ;;
    esac
    printf '{"type":"mode","mode":"normal","cwd":"%s"}\n' "$cwd" > "$f"
    if [ $i -eq 6 ]; then
      # ONE OF THEM IS A PASTED FILE, because that is the case the detail panel is built
      # around: a first message of a few thousand characters, which used to push every
      # action off the bottom of the panel.
      long='Voici le diff complet à relire ligne par ligne :'
      k=0
      while [ $k -lt 40 ]; do
        long="$long reprendre le worker de file et vérifier le chemin $k ;"
        k=$((k + 1))
      done
      ask "$long" >> "$f"
    else
      ask "$(printf 'Question %d sur %s, assez longue pour que la carte ait à la couper quelque part' $i "$slug")" >> "$f"
    fi
    touch -d "@$(( $(date +%s) - i * 7200 ))" "$f"
  done
done

# ── Codex: one rollout per launch, under the date it started ────────────────────
# Sixty with no human turn — the runs it delegates to itself — and one real conversation,
# started long ago and written to a moment ago, which is the card that must sort first.
i=0
while [ $i -lt 60 ]; do
  i=$((i + 1))
  d=$(( (i % 28) + 1 ))
  dir="$H/.codex/sessions/2026/10/$(printf '%02d' $d)"
  mkdir -p "$dir"
  f="$dir/rollout-2026-10-$(printf '%02d' $d)T0$((i % 9))-1$((i % 6))-0$((i % 9))-$(uuid $((100 + i))).jsonl"
  printf '{"payload":{"type":"session_meta","cwd":"/srv/acme/api"}}\n' > "$f"
  printf '{"payload":{"role":"user","content":[{"text":"<environment_context>\\n  <cwd>/srv/acme/api</cwd>"}]}}\n' >> "$f"
  touch -d "@$(( $(date +%s) - i * 3600 ))" "$f"
done
mkdir -p "$H/.codex/sessions/2026/09/08"
f="$H/.codex/sessions/2026/09/08/rollout-2026-09-08T12-52-12-$(uuid 999).jsonl"
printf '{"payload":{"type":"session_meta","cwd":"/srv/acme/api"}}\n' > "$f"
printf '{"payload":{"role":"user","content":[{"text":"<environment_context>\\n  <cwd>/srv/acme/api</cwd>"}]}}\n' >> "$f"
printf '{"payload":{"role":"user","content":[{"text":"Reprendre le portage du worker de file vers le nouveau client"}]}}\n' >> "$f"
touch -d "@$(( $(date +%s) - 120 ))" "$f"

# ── Grok: one directory per URL-encoded working directory ───────────────────────
i=0
for enc in %2Fsrv%2Facme%2Fapi %2Fsrv%2Facme%2Fweb; do
  for n in 1 2; do
    i=$((i + 1))
    d="$H/.grok/sessions/$enc/$(uuid $((200 + i)))"
    mkdir -p "$d"
    printf '{"role":"user","content":"grok %d"}\n' $i > "$d/chat_history.jsonl"
    touch -d "@$(( $(date +%s) - i * 50000 ))" "$d/chat_history.jsonl"
  done
done

# ── Antigravity: one database per conversation, plus the file that is not one ───
mkdir -p "$H/.gemini/antigravity-cli/conversations"
printf 'SQLite format 3\n' > "$H/.gemini/antigravity-cli/conversations/conversation_summaries.db"
for n in 1 2; do
  printf 'SQLite format 3\n' > "$H/.gemini/antigravity-cli/conversations/$(uuid $((300 + n))).db"
done

# ── and the binaries the probe looks for, so each tool reports installed ────────
mkdir -p "$H/bin"
# With an argument it answers `--version`, which is all the probe asks of it. With NONE
# it is a new conversation: it prints the directory it was started in and stays up, so
# the bench can read back the one thing a new conversation is given.
for b in claude codex grok agy; do
  printf '#!/bin/sh\nif [ $# -eq 0 ]; then echo "%s (bench) cwd=$PWD"; exec sleep 300; fi\necho "%s 1.0.0 (bench)"\n' "$b" "$b" > "$H/bin/$b"
  chmod +x "$H/bin/$b"
done

echo "seeded $H: $(find "$H/.claude" "$H/.codex" "$H/.grok" "$H/.gemini" -type f | wc -l) files"
