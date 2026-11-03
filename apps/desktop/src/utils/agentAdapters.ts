/**
 * The shipped agent adapters, and the parser that turns each one's listing into
 * conversations.
 *
 * AN ADAPTER IS TWO COMMANDS (ADR 0022 §4): how to list a tool's conversations and how
 * to resume one. Its 0.2.9 addendum settled where an adapter lives — local to the
 * client, never exported, never a collection item — because an adapter is code, and a
 * screen that lists shell is a screen people click. These six are the defaults; the set
 * is the user's and the Tools dialog edits it.
 *
 * MEASURED ON THIS MACHINE, 2026-11-03, against the installed binaries. Four of the six
 * were there, and three of the four commands the mock carried could not work:
 *
 *   - `ls ~/.codex/sessions/**\/*.jsonl` — `sh` has no recursive glob, and `**` is one
 *     `*`. Codex files under `sessions/YYYY/MM/DD/`, so the glob is three levels deep.
 *   - `gemini --list-sessions` answers FOR THE CURRENT DIRECTORY and prints prose. Kept
 *     all the same: see the adapter below, it is the only thing that produces the index
 *     `--resume` takes.
 *   - `ls ~/.grok/sessions` lists PROJECTS, not conversations — one directory per
 *     URL-encoded working directory, each holding one directory per conversation.
 *
 * And the fourth, which looked right and is not: a session's recency is NOT the date in
 * its file name. The oldest-named Codex rollout on this machine, `2026-09-08`, had been
 * written to that morning — a September conversation resumed in November. So ordering
 * comes from `ls -t`, the modification time, and never from a parsed name.
 *
 * RECENCY IS THE ONLY TIME SIGNAL, and here it is an ORDER rather than a clock. A
 * portable timestamp costs more than one line of shell: `find -printf '%T@'` is GNU and
 * answers an error on macOS, `stat` takes `-c` there and `-f` here, and batching either
 * one over paths that may contain a space needs `tr`, `xargs -0` and a fallback chain.
 * So the listing is ordered and the parser numbers it, which is a fact on every host.
 * An absolute "last written" is a LAZY ENRICHMENT, fetched when a card is opened, the
 * way `statsCmd` already does it for a container (`machineProbe.ts`).
 *
 * WHAT A LISTING CANNOT SAY is whether anything is running, and nothing here pretends
 * otherwise. A transcript written twenty seconds ago by a session that has since exited
 * is byte-for-byte one written by a session mid-answer, and Grok's `.lock` files sit
 * there with no Grok running. No conversation carries a state.
 *
 * It also cannot say what a conversation is ABOUT. The opening message is inside the
 * transcript, which is a second read per conversation and not part of a listing.
 */

import type { AgentAdapter } from './agentProbe.ts';
import { shellArg } from './machineProbe.ts';

/**
 * How many conversations a listing may return.
 *
 * Measured: 3821 files under `~/.grok/sessions` on this machine, 125 under
 * `~/.claude/projects`. Shipping all of them back over SSH to render a list nobody
 * scrolls is the wrong trade, and the cap is also what makes the commands exit 0 — see
 * `RECENT`.
 */
export const LIST_CAP = 200;

/**
 * The tail of every file-listing adapter: newest first, capped, and quiet about a glob
 * that matched nothing.
 *
 * The pipe is what sets the exit status. `ls` answers non-zero when a glob matches
 * nothing — the shell hands it the pattern itself — and a tool with no conversations is
 * not a tool that failed. Ending on `head` makes the status `head`'s, which is 0, so an
 * empty answer reads as "none" and a real failure shows up as an empty list rather than
 * as a red card. Named rather than solved: telling those two apart would cost a second
 * command, and the first is what happens every day.
 */
const RECENT = `2>/dev/null | head -n ${LIST_CAP}`;

/**
 * One conversation, as a listing can honestly describe it.
 *
 * Not `AgentConversation`, which is what a RESUMED pane carries (`types/pane.ts`) and
 * holds things a listing never gives — the machine it is on, the directory it works in.
 * Two different shapes under one name is the kind of collision that gets noticed by a
 * compiler once and by a reader never.
 */
export interface DiscoveredConversation {
  /** What `resume` substitutes for `{id}`. */
  id: string;
  /**
   * The project the tool filed it under, verbatim or decoded — never un-mangled.
   * Claude slugs a path by replacing every `/` with `-`, which `linux-s7` makes
   * ambiguous, so that slug is shown as it is rather than turned back into a wrong
   * path. Grok URL-encodes, which IS reversible, so that one is decoded.
   */
  project?: string;
  /** What the tool's own listing printed for it, when that is a title or a date. */
  label?: string;
  /** 0 is the most recent in the tool's own ordering. The only time signal. */
  rank: number;
}

/** An adapter Rite ships, which is the probe's adapter plus what the view needs. */
export interface ShippedAdapter extends AgentAdapter {
  name: string;
  /** `{id}` is substituted, quoted. */
  resume: string;
  /**
   * What `{id}` is. `index` means the number moves as conversations accumulate, and the
   * view warns about it; step 6 checks a sealed mark's id against this before it ever
   * reaches a shell.
   */
  idKind: 'uuid' | 'index' | 'title';
  /** Where the two commands come from, and how far that goes. */
  from: { kind: 'measured' | 'vendor' | 'community'; seen: string };
  /** Pure: the listing's lines in, conversations out. Never throws. */
  parse: (lines: string[]) => DiscoveredConversation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split a path the way the listings print it: forward slashes, no trailing one. */
const parts = (line: string): string[] => line.trim().split('/').filter(Boolean);

export const SHIPPED_ADAPTERS: ShippedAdapter[] = [
  {
    // `~/.claude/projects/<slug>/<uuid>.jsonl`. The slug is the working directory with
    // every `/` replaced by `-`; a project directory also holds a `memory` folder, which
    // the `*.jsonl` half of the glob leaves out.
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    list: `ls -1t ~/.claude/projects/*/*.jsonl ${RECENT}`,
    resume: 'claude --resume {id}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const p = parts(line);
        const file = p[p.length - 1] ?? '';
        if (!file.endsWith('.jsonl')) continue;
        const id = file.slice(0, -'.jsonl'.length);
        if (!UUID.test(id)) continue;
        const slug = p[p.length - 2];
        out.push({ id, project: slug, label: slug, rank: out.length });
      }
      return out;
    },
  },
  {
    // `~/.codex/sessions/YYYY/MM/DD/rollout-<started>-<uuid>.jsonl`. The path carries a
    // date and no project, so a Codex conversation has no project to show.
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    list: `ls -1t ~/.codex/sessions/*/*/*/*.jsonl ${RECENT}`,
    resume: 'codex resume {id}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const p = parts(line);
        const file = p[p.length - 1] ?? '';
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const stem = file.slice('rollout-'.length, -'.jsonl'.length);
        // The uuid is the tail; what precedes it is when the conversation STARTED, which
        // is not when it was last written — the ordering above is the recency.
        const id = stem.slice(-36);
        if (!UUID.test(id)) continue;
        out.push({ id, label: stem.slice(0, -37), rank: out.length });
      }
      return out;
    },
  },
  {
    // `gemini --resume` takes `latest` or an INDEX (read off `--help` on the installed
    // build), so the listing has to be the one that prints those indices — a folder
    // cannot produce them. It answers for the CURRENT DIRECTORY, which is why a Gemini
    // row is scoped to where the pane opens and not to the machine.
    //
    // What was not measured: the shape of a populated row. There were no saved sessions
    // on this machine, and the empty answer is prose — "No previous sessions found for
    // this project." So the parser takes a leading integer and ignores every line that
    // has none, which is the documented form and drops prose by construction.
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    list: 'gemini --list-sessions 2>&1',
    resume: 'gemini --resume {id}',
    idKind: 'index',
    from: { kind: 'measured', seen: 'flags 2026-11-03; row shape unseen, none saved' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const m = /^\s*(\d+)\s*[.):]?\s+(.*)$/.exec(line);
        if (!m) continue;
        out.push({ id: m[1], label: m[2].trim() || undefined, rank: out.length });
      }
      return out;
    },
  },
  {
    // `~/.grok/sessions/<url-encoded cwd>/<uuid>/chat_history.jsonl`. Naming the history
    // file does three things at once: it skips `prompt_history.jsonl` and
    // `session_search.sqlite`, which sit beside real conversations, and it orders by when
    // the conversation was last written rather than when its folder was made.
    id: 'grok',
    name: 'Grok',
    bin: 'grok',
    list: `ls -1t ~/.grok/sessions/*/*/chat_history.jsonl ${RECENT}`,
    resume: 'grok --resume {id}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const p = parts(line);
        if (p[p.length - 1] !== 'chat_history.jsonl') continue;
        const id = p[p.length - 2] ?? '';
        if (!UUID.test(id)) continue;
        // URL-encoding is lossless, so decoding gives the real path back. A malformed
        // escape is the encoder's business, not a reason to drop the conversation.
        const raw = p[p.length - 3] ?? '';
        let project = raw;
        try {
          project = decodeURIComponent(raw);
        } catch {
          /* keep it as printed */
        }
        out.push({ id, project, label: project, rank: out.length });
      }
      return out;
    },
  },
  {
    // Sessions in SQLite rather than files — which is why an adapter is two COMMANDS and
    // not two paths. A contract that assumed `ls` would already have broken here.
    // `sqlite3` prints `|`-separated columns by default.
    id: 'hermes',
    name: 'Hermes',
    bin: 'hermes',
    list: `sqlite3 ~/.hermes/state.db 'select id,title from sessions order by rowid desc' ${RECENT}`,
    resume: 'hermes --resume {id}',
    idKind: 'title',
    from: { kind: 'vendor', seen: 'documentation; not installed here' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const cut = line.indexOf('|');
        const id = (cut < 0 ? line : line.slice(0, cut)).trim();
        if (!id) continue;
        out.push({
          id,
          label: cut < 0 ? undefined : line.slice(cut + 1).trim() || undefined,
          rank: out.length,
        });
      }
      return out;
    },
  },
  {
    id: 'opencode',
    name: 'opencode',
    bin: 'opencode',
    list: 'opencode session list --format json 2>/dev/null',
    resume: 'opencode -s {id}',
    idKind: 'uuid',
    from: { kind: 'community', seen: 'third-party write-up; expect drift' },
    parse: (lines) => {
      // One JSON document across several lines, so the lines are rejoined. A document
      // that does not parse yields nothing: the adapter is wrong for the installed
      // build, and an empty list is what the view already knows how to say.
      let doc: unknown;
      try {
        doc = JSON.parse(lines.join('\n'));
      } catch {
        return [];
      }
      const rows = Array.isArray(doc) ? doc : [];
      const out: DiscoveredConversation[] = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const id = typeof r.id === 'string' ? r.id : '';
        if (!id) continue;
        const title = typeof r.title === 'string' ? r.title.trim() : '';
        out.push({ id, label: title || undefined, rank: out.length });
      }
      return out;
    },
  },
];

/**
 * The command that resumes one conversation.
 *
 * `{id}` is QUOTED, not interpolated. Every id here was read off a remote host, and the
 * command built from it is typed into a live shell on that host — the same argument
 * `machineProbe`'s `shellArg` makes about a container name, except that these ids come
 * out of file names rather than out of a runtime that restricts them. An adapter with no
 * `{id}` gets the id appended rather than silently dropped.
 */
export function agentResumeCmd(adapter: ShippedAdapter, id: string): string {
  const quoted = shellArg(id);
  return adapter.resume.includes('{id}')
    ? adapter.resume.replace('{id}', quoted)
    : `${adapter.resume} ${quoted}`;
}

/**
 * The same resume line as argv, for a conversation on THIS machine.
 *
 * Not the quoted string above, and not a parse of it. A local PTY runs one program
 * through `execvp` with its arguments passed as written (ADR 0022 §7.1), so quoting
 * would arrive as part of the id — `'3f1c9e7a'` with the quotes in it, which resumes
 * nothing. The template is the adapter's own, written by whoever added it, so splitting
 * it on spaces is reading what they wrote; only `{id}` carries a value from a file name,
 * and it is one argument whatever is in it.
 */
export function agentResumeArgv(adapter: ShippedAdapter, id: string): string[] {
  const parts = adapter.resume.split(/\s+/).filter(Boolean);
  const out = parts.map((p) => (p === '{id}' ? id : p));
  // A placeholder glued to something else (`-s{id}`) is substituted in place; one that
  // is not there at all gets the id appended, rather than resuming whatever the tool
  // picks by itself.
  return out.some((p) => p === id || p.includes('{id}'))
    ? out.map((p) => p.replace('{id}', id))
    : [...out, id];
}

/** The adapter with this id, among the ones Rite ships. */
export const shippedAdapter = (id: string): ShippedAdapter | undefined =>
  SHIPPED_ADAPTERS.find((a) => a.id === id);
