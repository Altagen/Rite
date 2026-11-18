/**
 * The shipped agent adapters, and the parser that turns each one's listing into
 * conversations.
 *
 * AN ADAPTER IS TWO COMMANDS (ADR 0022 §4): how to list a tool's conversations and how
 * to resume one. Its 0.2.9 addendum settled where an adapter lives — local to the
 * client, never exported, never a collection item — because an adapter is code, and a
 * screen that lists shell is a screen people click. These seven are the defaults; the
 * set is the user's and the Tools dialog edits it.
 *
 * MEASURED ON THIS MACHINE, 2026-11-03, against the installed binaries. Five of the seven
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
 * EVERY FILE LISTING CARRIES ITS LAST-WRITTEN TIME, and it has to: the order is by that
 * time, so a card showing anything else contradicts the list it sits in. Sixty-one Codex
 * cards labelled with the date in their FILE NAME read as a shuffled list, because a
 * conversation started in September and resumed today sorts first and reads last.
 *
 * It is not one line of shell, which is why it was deferred once. `find -printf '%T@'`
 * is GNU and answers an error on macOS; `stat` takes `-c` on one and `-f` on the other;
 * and batching either over paths that may hold a space needs `tr` and `xargs -0`. So the
 * chain is written once, in `RECENT`, and tried in order — GNU, then BSD, then the bare
 * paths, which still give the order. A host with neither `stat` loses the clock and
 * keeps the list.
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
import { posixScript, shellArg } from './machineProbe.ts';

/**
 * How many conversations a listing may return.
 *
 * Measured: 3821 files under `~/.grok/sessions` on this machine, 125 under
 * `~/.claude/projects`. Shipping all of them back over SSH to render a list nobody
 * scrolls is the wrong trade, and the cap is also what makes the commands exit 0 — see
 * `RECENT`.
 */
export const LIST_CAP = 200;

/** How much of a first message is worth carrying back. See `ASK`. */
export const ASK_CAP = 4000;

/**
 * Every file-listing adapter's whole command: newest first, capped, each line its
 * last-written time and its path.
 *
 * `ls -1t` is the order, and `$L` holds it so the two `stat` syntaxes can both be tried
 * — a pipeline would hand the first one the input and leave the second nothing. GNU
 * first because that is what a Linux host answers; BSD second for macOS; the bare paths
 * last, so a host with neither still gets its conversations, without a clock.
 *
 * THE EXIT STATUS IS THE EMPTY CASE. `ls` answers non-zero when a glob matches nothing —
 * the shell hands it the pattern itself — and a tool with no conversations is not a tool
 * that failed, so the empty list leaves through `exit 0`. The cost is named rather than
 * solved: a genuinely broken command also reads as none, and telling the two apart would
 * cost a second command for a case that does not happen daily.
 */
/** The field separator a listing line uses. A real tab; see `listing`. */
const TAB = '\t';

/**
 * The first line of a transcript that a PERSON wrote, as awk finds it.
 *
 * `"role":"user"` is how both Claude Code and Codex mark a human turn, and the first one
 * is not always the person: Codex opens every session with an `<environment_context>`
 * block under that same role, so the first match is a preamble and the second is the
 * question. Dropping the preamble by name and taking the first that remains covers both
 * vendors with one expression — and a session that never got a question keeps nothing,
 * which is itself a fact worth having.
 *
 * `substr` rather than a second process, and the cap is there because a first message
 * can be a pasted file — four thousand characters is a long paragraph and a short file,
 * which is where the line between "the question" and "an attachment" falls. The reader
 * shows the whole of what arrives; what the cap decides is what is shipped back, two
 * hundred times.
 */
const ASK = `awk '/"role":"user"/ && !/environment_context/ { print substr($0,1,${ASK_CAP}); exit }' "$f" 2>/dev/null`;

/**
 * Every file-listing adapter's whole command: newest first, capped, and one line per
 * conversation carrying its last-written time, its path, and — when the adapter asks for
 * it — the raw transcript line the person's first message is in.
 *
 * A LOOP RATHER THAN A BATCHED `stat`, which is a deliberate step back. Batching through
 * `xargs -0` was fewer processes, but the moment a second field had to come out of each
 * FILE the batch could no longer carry it, and two passes joined by path is more
 * machinery than this is worth. Measured on 61 Codex rollouts, one of them 40 000 lines:
 * 0.26s for the whole loop, against a 15-second cap.
 *
 * `stat` is tried GNU-first and then BSD, because there is no portable spelling. A host
 * with neither leaves the time empty and the parser reads the line without one: the
 * order still holds, and a card shows no time rather than one nobody measured.
 *
 * THE EXIT STATUS IS THE EMPTY CASE. `ls` answers non-zero when a glob matches nothing —
 * the shell hands it the pattern itself — and a tool with no conversations is not a tool
 * that failed, so the pipeline ends on the loop and the status is the loop's.
 */
const listing = (glob: string, opts: { ask?: boolean } = {}): string =>
  [
    `ls -1t ${glob} 2>/dev/null | head -n ${LIST_CAP} | while IFS= read -r f; do`,
    `t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)`,
    opts.ask ? `a=$(${ASK})` : `a=`,
    // A real tab, interpolated, because `printf` would read `\t` itself — and the two
    // fields either side of it are a path and a JSON line, neither of which can hold a
    // raw tab without having said so.
    String.raw`printf '%s${TAB}%s${TAB}%s\n' "$t" "$f" "$a"`,
    `done`,
  ].join('\n');

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
   * The file or directory this conversation IS, when the listing named one.
   *
   * What `remove` acts on, and nothing else reads it. Absent on a tool whose listing is
   * not files — a `sqlite3` query, a vendor subcommand — which is why removing one is
   * optional per adapter rather than a right the manager assumes it has.
   */
  path?: string;
  /**
   * The project the tool filed it under, verbatim or decoded — never un-mangled.
   * Claude slugs a path by replacing every `/` with `-`, which `linux-s7` makes
   * ambiguous, so that slug is shown as it is rather than turned back into a wrong
   * path. Grok URL-encodes, which IS reversible, so that one is decoded.
   */
  project?: string;
  /** What the tool's own listing printed for it, when that is a title or a date. */
  label?: string;
  /**
   * The person's first message, when the transcript held one.
   *
   * What a conversation IS to someone looking for it, and the only field on this shape
   * that required reading inside a file. Absent on a session nobody typed into — a
   * delegated run, or one abandoned at the prompt — which the view says rather than
   * filling in.
   */
  ask?: string;
  /** 0 is the most recent in the tool's own ordering. */
  rank: number;
  /**
   * When the conversation was last written, as a Unix second, when the host could say.
   *
   * The sort key, which is why it is on the card: showing any other date beside a list
   * ordered by this one is showing a shuffled list. Absent on a host whose `stat`
   * answered neither syntax, and on a tool whose listing is not files — the order still
   * holds there, and a card then shows no time rather than a made-up one.
   */
  writtenAt?: number;
}

/** An adapter Rite ships, which is the probe's adapter plus what the view needs. */
export interface ShippedAdapter extends AgentAdapter {
  name: string;
  /** `{id}` is substituted, quoted. */
  resume: string;
  /**
   * How one conversation is removed, when this tool's layout allows it. `{path}` is
   * substituted, quoted.
   *
   * ABSENT IS THE DEFAULT and it is not a gap: three of the seven listings do not name a
   * file (an index, a `sqlite3` row, a vendor subcommand), and a removal invented for
   * them would be a guess carried out with `rm`. A tool with no `remove` shows no delete.
   */
  remove?: string;
  /**
   * What `{id}` is. `index` means the number moves as conversations accumulate, and the
   * view warns about it; step 6 checks a sealed mark's id against this before it ever
   * reaches a shell.
   */
  idKind: 'uuid' | 'index' | 'title';
  /** Where the two commands come from, and how far that goes. */
  from: { kind: 'measured' | 'vendor' | 'community'; seen: string };
  /**
   * Whether this adapter's listing READS the person's first message.
   *
   * It has to be said rather than inferred from an empty `ask`, because the two mean
   * opposite things: a conversation with no question is a session nobody typed into,
   * and a conversation whose adapter never looked is one nobody has read. A view that
   * confuses them tells someone their Grok sessions are empty when all that happened is
   * that nothing opened them.
   */
  readsAsk?: boolean;
  /**
   * Where a live read can find this conversation's working directory, when it can.
   *
   * `transcript` means the file carries a `"cwd"` near its start — measured on Claude
   * Code and Codex, both in the first 64 KB, in 9ms on a 1.1 GB transcript. `path` means
   * the listing already decoded it, which is Grok's URL-encoded project directory.
   * Absent means no live read is offered: a SQLite database and three listings that are
   * not files have no directory to ask about, and inventing one would be the opposite of
   * the reason this read exists.
   */
  livesIn?: 'transcript' | 'path';
  /** Pure: the listing's lines in, conversations out. Never throws. */
  parse: (lines: string[]) => DiscoveredConversation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One line of a file listing: a path, and its last-written second when `stat` answered.
 *
 * The tab is the separator because a path can hold a space and cannot hold a tab without
 * saying so — and the epoch is read only when it is all digits, so a path that happens to
 * start with a number and a tab is a path.
 */
function fileLine(line: string): { path: string; writtenAt?: number; ask?: string } {
  const first = line.indexOf('\t');
  if (first < 0) return { path: line.trim() };
  const last = line.lastIndexOf('\t');
  // Split at the FIRST tab and the LAST one, which is what recovers a path that has a
  // tab in it: the time is before the first and the transcript line after the last, so
  // whatever lies between them is the path, tabs and all.
  const head = line.slice(0, first);
  const path = (last > first ? line.slice(first + 1, last) : line.slice(first + 1)).trim();
  const raw = last > first ? line.slice(last + 1).trim() : '';
  return {
    path,
    // Empty when the host's `stat` answered neither syntax. A field that is not all
    // digits is not a time, so a path beginning with a tab cannot become one.
    writtenAt: /^\d+$/.test(head) ? Number(head) : undefined,
    ask: askOf(raw),
  };
}

/**
 * The person's first message, out of the raw transcript line the listing carried.
 *
 * NOT `JSON.parse`, and that is forced rather than chosen: the line arrives cut at 600
 * characters, because a first message can be a pasted file and nobody wants that shipped
 * back over SSH two hundred times. A truncated JSON document does not parse, so the
 * first version of this read nothing at all on real data — six Claude transcripts, six
 * blanks — while the same `awk` on the host was finding five of them.
 *
 * So it scans instead, and the cap is why that is honest: the value wanted is the FIRST
 * text after the turn says it is the user's, and the first text is the part that
 * survived the cut. A line that holds no such text yields nothing.
 *
 * ONE READER FOR TWO SHAPES. Claude Code writes `{message: {role, content: [{text}]}}`
 * and Codex `{payload: {role, content: [{text}]}}`; either way the pair that matters is
 * `"role":"user"` followed by the first `"text"` or `"content"` string, so neither
 * vendor needs a reader of its own.
 */
function askOf(raw: string): string | undefined {
  if (!raw) return undefined;
  const turn = raw.indexOf('"role":"user"');
  if (turn < 0) return undefined;
  const m = /"(?:text|content)"\s*:\s*"/.exec(raw.slice(turn));
  if (!m) return undefined;
  let i = turn + m.index + m[0].length;
  let out = '';
  // Read to the closing quote, honouring the escape that would otherwise end the string
  // early — and stopping at the end of what survived the cut rather than demanding one.
  for (; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-f]{4}$/i.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
      }
      out += next === 'n' || next === 't' || next === 'r' ? ' ' : (next ?? '');
      i++;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  // One line, squeezed, and short enough to be a title rather than a paragraph. A turn
  // that opens with a tag is a preamble the host's `awk` did not catch, not a question.
  // Squeezed to one line, and kept WHOLE: a card truncates with CSS, which keeps the
  // ellipsis at the width the card actually has, and the detail panel shows all of it.
  // Cutting here would have thrown away what the panel exists to show.
  const text = out.replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<')) return undefined;
  return text;
}

/** Split a path the way the listings print it: forward slashes, no trailing one. */
const parts = (p: string): string[] => p.trim().split('/').filter(Boolean);

export const SHIPPED_ADAPTERS: ShippedAdapter[] = [
  {
    // `~/.claude/projects/<slug>/<uuid>.jsonl`. The slug is the working directory with
    // every `/` replaced by `-`; a project directory also holds a `memory` folder, which
    // the `*.jsonl` half of the glob leaves out.
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    list: listing('~/.claude/projects/*/*.jsonl', { ask: true }),
    readsAsk: true,
    resume: 'claude --resume {id}',
    livesIn: 'transcript',
    // One file is one conversation, so removing it is removing the conversation. `-f` so
    // a file already gone is not an error, `--` so a path is never read as a flag.
    remove: 'rm -f -- {path}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const { path, writtenAt, ask } = fileLine(line);
        const p = parts(path);
        const file = p[p.length - 1] ?? '';
        if (!file.endsWith('.jsonl')) continue;
        const id = file.slice(0, -'.jsonl'.length);
        if (!UUID.test(id)) continue;
        const slug = p[p.length - 2];
        out.push({ id, path, project: slug, label: slug, ask, rank: out.length, writtenAt });
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
    list: listing('~/.codex/sessions/*/*/*/*.jsonl', { ask: true }),
    readsAsk: true,
    resume: 'codex resume {id}',
    livesIn: 'transcript',
    remove: 'rm -f -- {path}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        const { path, writtenAt, ask } = fileLine(line);
        const p = parts(path);
        const file = p[p.length - 1] ?? '';
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const stem = file.slice('rollout-'.length, -'.jsonl'.length);
        const id = stem.slice(-36);
        if (!UUID.test(id)) continue;
        // The name says when the conversation STARTED, which is not when it was last
        // written: measured on this machine, a rollout named 2026-09-08 had been written
        // to that morning, because `codex resume` appends to the file it reopens. The
        // card shows `writtenAt`, which is what the list is sorted by; the started-at is
        // kept as the label, where it cannot be read as the sort key.
        out.push({ id, path, label: stem.slice(0, -37), ask, rank: out.length, writtenAt });
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
    list: listing('~/.grok/sessions/*/*/chat_history.jsonl'),
    resume: 'grok --resume {id}',
    livesIn: 'path',
    // THE DIRECTORY, not the history file — which is why `path` is what an adapter says
    // it is rather than what its glob matched. A Grok conversation is a folder holding a
    // history, a lock and a search index; deleting the history alone would leave the tool
    // listing a conversation with nothing in it.
    remove: 'rm -rf -- {path}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const raw of lines) {
        const { path, writtenAt, ask } = fileLine(raw);
        const p = parts(path);
        if (p[p.length - 1] !== 'chat_history.jsonl') continue;
        const id = p[p.length - 2] ?? '';
        if (!UUID.test(id)) continue;
        // URL-encoding is lossless, so decoding gives the real path back. A malformed
        // escape is the encoder's business, not a reason to drop the conversation.
        const encoded = p[p.length - 3] ?? '';
        let project = encoded;
        try {
          project = decodeURIComponent(encoded);
        } catch {
          /* keep it as printed */
        }
        out.push({
          id,
          // The conversation's own folder: everything in `path` up to the file name.
          path: path.slice(0, path.length - '/chat_history.jsonl'.length),
          project,
          label: project,
          ask,
          rank: out.length,
          writtenAt,
        });
      }
      return out;
    },
  },
  {
    // Google's other one, and it is a FOLDER OF DATABASES: one `<uuid>.db` per
    // conversation under `~/.gemini/antigravity-cli/conversations`, which is why the
    // listing is `ls` and the file is not read. `--conversation <id>` resumes one, read
    // off `agy --help` on the installed build — a durable id, unlike `gemini --resume`,
    // which is the same vendor and takes a position.
    id: 'antigravity',
    name: 'Antigravity',
    bin: 'agy',
    list: listing('~/.gemini/antigravity-cli/conversations/*.db'),
    resume: 'agy --conversation {id}',
    // `conversation_summaries.db` beside them keeps a row per conversation, which this
    // does not touch: it is the vendor's index, rebuilt by the vendor, and editing
    // someone else's SQLite from a delete button is a larger claim than the button makes.
    remove: 'rm -f -- {path}',
    idKind: 'uuid',
    from: { kind: 'measured', seen: 'binary and files, 2026-11-03' },
    parse: (lines) => {
      const out: DiscoveredConversation[] = [];
      for (const line of lines) {
        // No `ask`: a conversation is a SQLite database here, and the listing does not
        // open one. Reading it would need `sqlite3` on the host and a schema this has
        // not been measured against.
        const { path, writtenAt } = fileLine(line);
        const p = parts(path);
        const file = p[p.length - 1] ?? '';
        if (!file.endsWith('.db')) continue;
        const id = file.slice(0, -'.db'.length);
        // `conversation_summaries.db` sits beside them and is not one, which the uuid
        // test is enough to say.
        if (!UUID.test(id)) continue;
        out.push({ id, path, rank: out.length, writtenAt });
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
    list: `sqlite3 ~/.hermes/state.db 'select id,title from sessions order by rowid desc' 2>/dev/null | head -n ${LIST_CAP}`,
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

/**
 * How deep a path has to be before Rite will remove it.
 *
 * Every removable layout here is at least `~/.<tool>/<something>/<file>`, which is four
 * segments once the shell has expanded the tilde. The number is a floor on a mistake:
 * a parser that one day yields a truncated path cannot turn into a command that removes
 * a home directory.
 */
const REMOVE_MIN_DEPTH = 4;

/**
 * The command that removes one conversation, or null when it cannot be built.
 *
 * NULL IS A REAL ANSWER and the view reads it as one: a tool whose listing names no file
 * offers no delete, rather than offering a button that runs a guess.
 *
 * THE PATH MUST BE NAMED BY THE CONVERSATION'S OWN ID. That is the check that matters,
 * because what this returns is typed into a live shell with `rm` at the front of it: the
 * last segment of the path has to carry the id the card shows — `<uuid>.jsonl`,
 * `rollout-<date>-<uuid>.jsonl`, `<uuid>.db`, `<uuid>/`. A parser that drifted and
 * reported the wrong path can then no longer produce a command at all, instead of
 * producing one that removes somebody's project.
 *
 * `{path}` is quoted, like `{id}` in a resume line and for the same reason: the value
 * was read off a remote host's file system, where a space is ordinary.
 */
export function agentRemoveCmd(
  adapter: ShippedAdapter,
  conv: DiscoveredConversation,
): string | null {
  const template = adapter.remove;
  const path = vettedPath(conv);
  if (!template || !path) return null;
  const quoted = shellArg(path);
  // `split`/`join` rather than `replaceAll`, which this target's lib does not carry, and
  // rather than `replace`, which would substitute the first of two.
  return template.includes('{path}') ? template.split('{path}').join(quoted) : null;
}

/**
 * The path a listing reported, or null when it does not survive the four checks.
 *
 * ONE GUARD FOR BOTH CALLERS. A removal puts this behind `rm` and a live read puts it
 * behind `head`, and the argument is the same either way: the value came out of a file
 * name on a remote host, so it is checked once, here, rather than twice with a drift
 * between them.
 */
function vettedPath(conv: DiscoveredConversation): string | null {
  const path = conv.path?.trim();
  if (!path || !path.startsWith('/')) return null;
  const segments = parts(path);
  if (segments.length < REMOVE_MIN_DEPTH) return null;
  // A traversal cannot arrive from a listing, and a listing is the only caller. It is
  // refused here because the cost of the check is one comparison and the cost of being
  // wrong is a command with `rm -rf` in it.
  if (segments.includes('..')) return null;
  const last = segments[segments.length - 1];
  if (!conv.id || !last.includes(conv.id)) return null;
  return path;
}

/**
 * A tool's listing lines with one conversation taken out.
 *
 * What a successful removal leaves behind: the probe's answer is held per machine so
 * switching back does not cost a round trip, and after an `rm` that answer still carries
 * the line the file was on. Re-probing to learn what Rite just did would be an SSH round
 * trip nobody asked for; showing the card until then would be showing a conversation
 * that is gone.
 *
 * The adapter's own parser decides which line that is, so this holds no second idea of
 * what a line means — the one place that reads a listing stays the one place. Every
 * adapter that can remove is one line per conversation; a parser that needs the whole
 * document (opencode's JSON) has no `remove`, so it never arrives here.
 */
export function withoutConversation(
  adapter: ShippedAdapter,
  lines: string[],
  id: string,
): string[] {
  return lines.filter((line) => !adapter.parse([line]).some((c) => c.id === id));
}

/**
 * The command that STARTS a conversation on a machine reached over SSH.
 *
 * `cd` and then `exec`, which is two decisions. `cd` because the one thing a new agent
 * needs that cannot be guessed is where it works, and SSH runs this through the account's
 * own shell, so the directory is the shell's business and not a channel option. `exec` so
 * the shell is REPLACED rather than left waiting on a child: the channel then holds one
 * process, and closing the pane ends the agent instead of orphaning it under a shell.
 *
 * A blank directory names nothing and the account lands where it always does — its home,
 * which only that machine can resolve.
 *
 * No arguments beyond that: every tool here opens a new conversation when run with none.
 * `{id}` has no counterpart, which is why this is not a third adapter command.
 */
export function agentStartCmd(adapter: ShippedAdapter, cwd: string): string {
  const dir = cwd.trim();
  return dir ? `cd ${shellArg(dir)} && exec ${adapter.bin}` : adapter.bin;
}

/** The same start as argv, for a conversation on THIS machine. See `agentResumeArgv`. */
export const agentStartArgv = (adapter: ShippedAdapter): string[] => [adapter.bin];

/**
 * How much of a transcript is read to find the directory it ran in.
 *
 * Measured: `"cwd"` sits in the first 64 KB of both a Claude Code transcript and a Codex
 * rollout — 9ms on a 1.1 GB file, because `head` stops there. It is the directory the
 * conversation was STARTED in, which is the one the tool reopens.
 *
 * The bound is the whole point. The same value could be found by scanning the file, and
 * on one real transcript that is 1.1 GB over an SSH channel, two hundred times.
 */
const CWD_WINDOW = 65536;

/**
 * Everything about one conversation that CAN HAVE CHANGED since it was listed, as a
 * single command.
 *
 * READ WHEN THE PANEL OPENS, NEVER CARRIED ON A CARD AND NEVER KEPT. A branch is the
 * example and the rule is general: a listing says what a file says, and anything that is
 * a property of the MACHINE RIGHT NOW is a different question with a different answer
 * every time it is asked. Shown on a card it would be read as current, go stale the
 * moment someone switches branches, and send a person to resume the wrong conversation —
 * which is the same failure as claiming a session is running (see the view's own note).
 *
 * So it is one round trip, on one machine, for one conversation, on an explicit gesture:
 * exactly what ADR 0022 §4 allows and nothing more. Opening the panel again asks again.
 *
 * `null` when there is nothing to ask: a tool whose listing names no directory, or a path
 * that fails the same guard a removal has to pass. Every state the script can report is
 * named rather than collapsed — `HEAD` is a detached head and not a branch called HEAD,
 * a missing `git` is not "not a repository", and a repository git REFUSED to read (the
 * dubious-ownership error, which is what a bind mount under another uid produces) is
 * neither.
 */
export function agentFactsCmd(
  adapter: ShippedAdapter,
  conv: DiscoveredConversation,
): string | null {
  // Grok's project is the URL-decoded working directory, so no file has to be opened.
  const hint = adapter.livesIn === 'path' ? conv.project?.trim() : '';
  if (adapter.livesIn === 'path' && !hint?.startsWith('/')) return null;
  let read = '';
  if (adapter.livesIn === 'transcript') {
    const path = vettedPath(conv);
    if (!path) return null;
    read = `if [ -z "$d" ]; then d=$(head -c ${CWD_WINDOW} ${shellArg(path)} 2>/dev/null | grep -m1 -o '"cwd":"[^"]*"' | cut -d'"' -f4); fi`;
  } else if (adapter.livesIn !== 'path') {
    return null;
  }
  return posixScript(
    [
      `d=${shellArg(hint ?? '')}`,
      read,
      'if [ -z "$d" ]; then echo __nocwd__; exit 0; fi',
      `printf '__cwd__ %s\\n' "$d"`,
      'if [ ! -d "$d" ]; then echo __gone__; exit 0; fi',
      'if ! command -v git >/dev/null 2>&1; then echo __nogit__; exit 0; fi',
      'b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null) || b=',
      `if [ -n "$b" ]; then printf '__branch__ %s\\n' "$b";`,
      'elif [ -e "$d/.git" ]; then echo __gitrefused__;',
      'else echo __norepo__; fi',
      `if [ -n "$(git -C "$d" status --porcelain 2>/dev/null | head -n 1)" ]; then echo __dirty__; fi`,
      'exit 0',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** What a live read came back with. Every field is absent until the script said it. */
export interface AgentFacts {
  /** The directory the conversation runs in, as the machine reported it. */
  cwd?: string;
  /** The branch it stands on now. Absent on a detached head — see `detached`. */
  branch?: string;
  /**
   * `git` answered `HEAD`, which is not a branch called HEAD.
   *
   * Printing it as one is the exact shape of mistake this whole read exists to avoid: it
   * would name a branch nobody is on.
   */
  detached?: boolean;
  /** The working tree has at least one change. Absent means it had none. */
  dirty?: boolean;
  /** Why there is nothing more to say, when there is not. */
  missing?: 'cwd' | 'directory' | 'git' | 'repository' | 'permission';
}

/**
 * The live read's answer. Pure, never throws, and ignores anything it did not write.
 *
 * A line this does not recognise is dropped rather than shown: the script runs through
 * the account's own shell, which prints its own warnings on login — a `.bashrc` that
 * echoes is not a fact about a repository.
 */
export function parseAgentFacts(stdout: string): AgentFacts {
  const facts: AgentFacts = {};
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('__cwd__ ')) facts.cwd = line.slice('__cwd__ '.length).trim() || undefined;
    else if (line.startsWith('__branch__ ')) {
      const b = line.slice('__branch__ '.length).trim();
      if (b === 'HEAD') facts.detached = true;
      else if (b) facts.branch = b;
    } else if (line === '__dirty__') facts.dirty = true;
    else if (line === '__nocwd__') facts.missing = 'cwd';
    else if (line === '__gone__') facts.missing = 'directory';
    else if (line === '__nogit__') facts.missing = 'git';
    else if (line === '__norepo__') facts.missing = 'repository';
    else if (line === '__gitrefused__') facts.missing = 'permission';
  }
  return facts;
}

/**
 * How much of a settings file is read.
 *
 * A `settings.json` is configuration a person typed, so it is small — the largest here is
 * under 4 KB. The bound exists for the same reason the transcript window does: the file
 * is named by whoever owns the account, not by Rite, and a read with no ceiling is a read
 * somebody else decides the cost of.
 */
const SETTINGS_WINDOW = 65536;

/**
 * WHAT IS IN EFFECT for one working directory: skills, commands and hooks, as one command.
 *
 * ADR 0022 §6, and read-only there by decision rather than by omission. A hook is not
 * configuration, it is a command that runs later, unattended — installing one from a
 * convenience panel is the wrong blast radius for a convenience, and on a shared account
 * a hook one person adds runs for everyone who signs in. A tool that makes that EASY is a
 * lateral-movement vector; a tool that makes it VISIBLE is the opposite, and this is the
 * second one.
 *
 * TWO LAYERS, AND WHICH ONE WON IS THE WHOLE POINT. The project's `.claude` under the
 * account's `~/.claude`, resolved on that host under that account, every row carrying the
 * path it came from — because the answer to "why did that happen?" is a file path. A copy
 * that lost to the project layer is shown LOSING rather than hidden, which is the
 * difference between a list of what is loaded and a list that explains itself.
 *
 * NOTHING READ IS STORED. It is displayed and dropped, which keeps the feature out of the
 * zero-knowledge path entirely instead of asking it for an exception.
 */
export function agentContextCmd(cwd: string): string | null {
  const dir = cwd.trim();
  if (!dir.startsWith('/')) return null;
  if (parts(dir).includes('..')) return null;
  return posixScript(
    [
      `printf '__account__ %s@%s\\n' "$(id -un 2>/dev/null)" "$(hostname 2>/dev/null || echo '?')"`,
      // The project layer first, so a reader of the raw output sees what wins first too.
      `for base in ${shellArg(`${dir}/.claude`)} "$HOME/.claude"; do`,
      `  if [ "$base" = ${shellArg(`${dir}/.claude`)} ]; then layer=project; else layer=user; fi`,
      '  [ -d "$base" ] || continue',
      // A glob that matches nothing expands to itself, which is why every loop below
      // tests the thing it was handed rather than trusting the expansion.
      '  for s in "$base"/skills/*/SKILL.md; do',
      `    [ -f "$s" ] && printf '__skill__ %s %s\\n' "$layer" "$s"`,
      '  done',
      '  for c in "$base"/commands/*.md; do',
      `    [ -f "$c" ] && printf '__cmd__ %s %s\\n' "$layer" "$c"`,
      '  done',
      // The hooks live INSIDE a JSON file, so the file comes back whole and is parsed on
      // this side. Parsing JSON in shell is how a quoted command with a brace in it turns
      // into a hook nobody declared.
      '  for f in "$base"/settings.json "$base"/settings.local.json; do',
      '    if [ -f "$f" ]; then',
      `      printf '__settings__ %s %s\\n' "$layer" "$f"`,
      `      head -c ${SETTINGS_WINDOW} "$f" 2>/dev/null`,
      `      printf '\\n__endsettings__\\n'`,
      '    fi',
      '  done',
      'done',
      'exit 0',
    ].join('\n'),
  );
}

/** Which layer a row came from. `project` beats `user`, and that is the only ordering. */
export type ContextLayer = 'project' | 'user';

/** One skill or one slash command, as a file on that machine. */
export interface ContextItem {
  name: string;
  path: string;
  from: ContextLayer;
  /** A `user` copy the project layer overrides. Shown losing rather than hidden. */
  shadowed?: boolean;
}

/** One hook: an event, what it matches, and the command it will run unattended. */
export interface ContextHook {
  event: string;
  matcher?: string;
  command: string;
  path: string;
  from: ContextLayer;
}

/** What one machine says is in effect for one directory. */
export interface AgentContext {
  /** `user@host`, as the machine reported it — the account this was resolved under. */
  account?: string;
  skills: ContextItem[];
  commands: ContextItem[];
  hooks: ContextHook[];
  /** A settings file that was read and could not be parsed, by path. */
  unreadable: string[];
}

/** The name a skill goes by: the directory that holds its `SKILL.md`. */
const skillName = (path: string): string => {
  const p = parts(path);
  return p[p.length - 2] ?? path;
};

/** The name a command goes by, as it is typed. */
const commandName = (path: string): string => {
  const file = parts(path).pop() ?? path;
  return `/${file.replace(/\.md$/, '')}`;
};

/**
 * Every hook a settings file declares.
 *
 * Claude Code's shape: `hooks` maps an event to a list of matchers, each holding its own
 * list of commands. Anything that is not that shape is skipped rather than guessed at — a
 * hook invented by a lenient parser is a command this panel claims will run and will not.
 */
function hooksFrom(json: unknown, path: string, from: ContextLayer): ContextHook[] {
  const out: ContextHook[] = [];
  const root = (json as { hooks?: unknown } | null)?.hooks;
  if (!root || typeof root !== 'object') return out;
  for (const [event, groups] of Object.entries(root as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = typeof group?.matcher === 'string' ? group.matcher : undefined;
      const list = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of list) {
        const command = typeof hook?.command === 'string' ? hook.command.trim() : '';
        if (!command) continue;
        out.push({ event, command, path, from, ...(matcher ? { matcher } : {}) });
      }
    }
  }
  return out;
}

/**
 * The read's answer. Pure, never throws, and ignores anything it did not write.
 *
 * Same rule as `parseAgentFacts`: the script runs through the account's own shell, which
 * prints its own warnings on login, so an unrecognised line is dropped. A `.bashrc` that
 * echoes is not a skill.
 */
export function parseAgentContext(stdout: string): AgentContext {
  const ctx: AgentContext = { skills: [], commands: [], hooks: [], unreadable: [] };
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('__account__ ')) {
      ctx.account = line.slice('__account__ '.length).trim() || undefined;
      continue;
    }
    const two = (marker: string): [ContextLayer, string] | null => {
      if (!line.startsWith(`${marker} `)) return null;
      const rest = line.slice(marker.length + 1);
      const gap = rest.indexOf(' ');
      if (gap < 1) return null;
      const layer = rest.slice(0, gap);
      const path = rest.slice(gap + 1).trim();
      if ((layer !== 'project' && layer !== 'user') || !path) return null;
      return [layer, path];
    };
    const skill = two('__skill__');
    if (skill) {
      ctx.skills.push({ name: skillName(skill[1]), path: skill[1], from: skill[0] });
      continue;
    }
    const cmd = two('__cmd__');
    if (cmd) {
      ctx.commands.push({ name: commandName(cmd[1]), path: cmd[1], from: cmd[0] });
      continue;
    }
    const settings = two('__settings__');
    if (!settings) continue;
    // The file's own text, up to the marker the script printed after it.
    const body: string[] = [];
    while (++i < lines.length && lines[i].trim() !== '__endsettings__') body.push(lines[i]);
    try {
      ctx.hooks.push(...hooksFrom(JSON.parse(body.join('\n')), settings[1], settings[0]));
    } catch {
      // SAID, NOT SWALLOWED. A settings file Rite could not parse is a file whose hooks
      // this panel cannot account for, and a panel that silently shows fewer hooks than
      // will fire is worse than one that says it could not read something.
      ctx.unreadable.push(settings[1]);
    }
  }

  // WHAT LOST, MARKED. A `user` copy of a name the project layer also defines does not
  // load, and hiding it would leave the reader wondering why their own skill did nothing.
  for (const list of [ctx.skills, ctx.commands]) {
    const won = new Set(list.filter((x) => x.from === 'project').map((x) => x.name.toLowerCase()));
    for (const item of list) {
      if (item.from === 'user' && won.has(item.name.toLowerCase())) item.shadowed = true;
    }
  }
  return ctx;
}

/**
 * OPEN ONE OF THOSE FILES, which is the whole editing story (ADR 0022 §6).
 *
 * Rite shows what is in effect and never writes it. The way a person changes any of it is
 * the way they already would: an editor on that machine, under the account they already
 * use there. So this is a terminal pane running `$EDITOR`, and nothing else — no new
 * right, no second source of truth, nothing for Rite to keep in sync. Rite navigates;
 * the editor edits.
 *
 * `$EDITOR` AND NOT A NAMED EDITOR, with `vi` behind it because POSIX requires it. Which
 * editor a person uses on their own machine is their decision and Rite has no business
 * holding an opinion; a machine with no `EDITOR` set still has `vi`.
 *
 * The path is vetted the way a removal's is: absolute, no climbing. It comes from a
 * listing Rite itself produced, so this is a belt on a brace — the brace being that the
 * script that found it only ever looked in two directories.
 */
export function agentOpenFileCmd(path: string): string | null {
  const file = path.trim();
  if (!file.startsWith('/') && !file.startsWith('~/')) return null;
  if (parts(file).includes('..')) return null;
  return `\${EDITOR:-vi} ${shellArg(file)}`;
}
