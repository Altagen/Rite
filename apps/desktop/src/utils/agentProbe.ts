/**
 * Agent discovery — the one command Rite runs on a machine to find out which agent
 * CLIs are installed there and what conversations each one reports, plus the parser
 * for its output.
 *
 * ONE COMMAND PER MACHINE, asked for explicitly (ADR 0022 §4). Discovery costs an SSH
 * round trip, so it is never fanned out across the library and never periodic: the
 * user picks a machine and asks. The answer carries the time it was read, which the
 * caller stamps — the host is not asked what time it is.
 *
 * An adapter is two commands, `list` and `resume`, and nothing else about a vendor is
 * depended on. This file only ever runs `list`; `resume` is the pane's business. What
 * `list` prints is NOT parsed here either: its lines come back as lines, and turning
 * them into conversations is each adapter's own parser, because the six tools disagree
 * about everything — a path, a JSON document, a row out of SQLite.
 *
 * WHAT THE FRAMING IS FOR. The script interleaves Rite's markers with output read off
 * a host, and a transcript's FILE NAME can contain anything a filename can, newlines
 * included. So a marker is never matched against data: each section announces how many
 * lines follow, and exactly that many are taken. A tool is named by its INDEX in the
 * adapter list rather than by its id, so there is no id to quote and none to forge.
 *
 * The ONE thing outside that framing is the version, which is a vendor's own text on
 * one unframed line. `head -n 1` keeps it to one line and the parser reads only the
 * first, so the limit is narrow: a `--version` whose first line began with `__body__ `
 * would be misread. Named rather than guarded — framing one word costs more than the
 * corner is worth, and the surrounding lines of a chatty `--version` are already
 * ignored because nothing in a section is searched for.
 *
 * THE CAP IS REAL. `run_remote_command` kills the exec at 15 seconds, and this script
 * is `command -v`, `--version` and a listing for every enabled adapter. A tool whose
 * section never arrives is reported as not answered rather than as absent — the two
 * are different facts and the manager says which it has.
 */

import { posixScript, shellArg } from './machineProbe.ts';

/** The whole adapter boundary: how to list a tool's conversations, and how to resume one. */
export interface AgentAdapter {
  id: string;
  /** The binary to look for. Absent on a host ⇒ the tool is simply not there. */
  bin: string;
  /** Shell, run as written. The user may edit it, which is the point of an adapter. */
  list: string;
}

/** What the probe found out about one tool on one machine. */
export interface ProbedTool {
  id: string;
  /** `command -v <bin>` found it. */
  installed: boolean;
  /** First line of `<bin> --version`, when it printed one. */
  version?: string;
  /** The listing's lines, when it exited 0. Absent when it did not. */
  lines?: string[];
  /**
   * The listing exited non-zero. Facts only — the status and what it printed on either
   * stream — because the sentence a user reads is the view's to write and to translate.
   */
  failure?: { status: number; output: string };
}

const TOOL = '__tool__';
const MISSING = '__missing__';
const VERSION = '__version__';
const BODY = '__body__';

/**
 * One section per adapter, in order.
 *
 * `out=$(…)` runs the adapter's `list` in a subshell, so a tool that exits takes its
 * own section down and not the probe. What it cannot survive is a `list` that is not a
 * valid script — unbalanced quotes break the whole command for every tool. That is the
 * adapter's author's error to see and to fix in the Tools dialog, and it is named here
 * rather than guarded, because the only guard would be to stop running what the user
 * wrote.
 */
function section(adapter: AgentAdapter, index: number): string {
  const bin = shellArg(adapter.bin);
  return [
    `echo '${TOOL} ${index}'`,
    `if command -v ${bin} >/dev/null 2>&1; then`,
    `echo "${VERSION} $(${bin} --version 2>/dev/null | head -n 1)"`,
    `out=$({ ${adapter.list} ; } 2>&1); rc=$?`,
    `if [ -z "$out" ]; then n=0; else n=$(printf '%s\\n' "$out" | wc -l); fi`,
    `echo "${BODY} $rc $n"`,
    `if [ "$n" -gt 0 ]; then printf '%s\\n' "$out"; fi`,
    `else echo '${MISSING}'; fi`,
  ].join('\n');
}

/** The command to run on the machine. `sh -c`, because the login shell is the user's. */
export function agentProbeCmd(adapters: AgentAdapter[]): string {
  return posixScript(adapters.map(section).join('\n'));
}

/**
 * Parse the probe's output. Adapters must be the same list, in the same order, that
 * built the command — a tool is named by position.
 *
 * Adapters whose section never arrived are left OUT of the result, which is how a
 * caller tells "not answered" from "not installed". Lines before the first marker are
 * dropped: a login shell that prints a banner is common and says nothing about a tool.
 */
export function parseAgentProbe(stdout: string, adapters: AgentAdapter[]): ProbedTool[] {
  const lines = stdout.split('\n');
  const tools: ProbedTool[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    if (!line.startsWith(`${TOOL} `)) continue;
    const adapter = adapters[Number(line.slice(TOOL.length + 1).trim())];
    if (!adapter) continue;
    const tool: ProbedTool = { id: adapter.id, installed: false };
    tools.push(tool);
    // The section's own lines, read positionally — never searched for.
    while (i < lines.length && !lines[i].startsWith(`${TOOL} `)) {
      const l = lines[i++];
      if (l === MISSING) break;
      if (l.startsWith(`${VERSION} `)) {
        tool.installed = true;
        const v = l.slice(VERSION.length + 1).trim();
        if (v) tool.version = v;
        continue;
      }
      if (l.startsWith(`${BODY} `)) {
        tool.installed = true;
        const [status, count] = l.slice(BODY.length + 1).trim().split(/\s+/).map(Number);
        const body = lines.slice(i, i + (Number.isFinite(count) ? count : 0));
        i += body.length;
        if (status === 0) tool.lines = body;
        else tool.failure = { status, output: body.join('\n') };
        continue;
      }
    }
  }
  return tools;
}
