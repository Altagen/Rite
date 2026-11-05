/**
 * The agent manager: which conversations each CLI holds on one machine, and a way back
 * into one.
 *
 * A VIEW AND NOT A PANE (ADR 0022, ADR 0016). A pane is one thing being worked in; this
 * is a place to find the thing to work in, like the machine dashboard beside it. Panes
 * are what it opens.
 *
 * ONE MACHINE AT A TIME, ASKED FOR EXPLICITLY. Discovery costs an SSH round trip, so it
 * is never fanned out across the library and never periodic: a machine is picked and a
 * button is pressed. The answer carries the time it was read, stamped here — the host is
 * not asked what time it is.
 *
 * WHAT A CARD SAYS IS WHAT A LISTING GIVES, which is less than the mock draws. A folder
 * yields the conversation's id, the project when the path encodes one, and the order the
 * tool itself reports — nothing else. The opening message, the branch and the turn count
 * live INSIDE a transcript, which is a second read per conversation and not part of a
 * listing; until that read exists, those lines are absent rather than filled in. Nothing
 * here says a conversation is running either: a transcript written twenty seconds ago by
 * a session that has since exited is byte-for-byte one written by a session mid-answer.
 *
 * TWO LAYOUTS, both shipped, with a switch. The mock carries both on purpose — the
 * question is which one survives a fleet, and that is answered by looking at a real
 * machine in both rather than by arguing about it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { Dropdown } from './Dropdown';
import type { ConnectionInfo } from '../store/connectionsStore';
import type { RemoteCommandOutput, ServerMode } from '../utils/backend';
import { agentProbeCmd, parseAgentProbe } from '../utils/agentProbe';
import {
  SHIPPED_ADAPTERS,
  agentFactsCmd,
  agentRemoveCmd,
  agentResumeCmd,
  parseAgentFacts,
  shippedAdapter,
  withoutConversation,
  type AgentFacts,
  type DiscoveredConversation,
  type ShippedAdapter,
} from '../utils/agentAdapters';
import { agentBlockedReason, agentVerdict } from '../utils/agentPolicy';
import { useMarks, type Mark } from '../store/marks';
import { LabelChip, LabelField, type LabelOffer } from './Labels';
import type { VocabWord } from '../store/labelsFormat';
import { keepAnswer, readAnswers, type Answer } from '../store/agentAnswers';
import { MACHINE_SWATCHES } from '../theme/swatches';
import { askConfirm } from '../utils/confirmPrompt';
import {
  IconCopy,
  IconEdit,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconTerminal,
  IconTrash,
} from './icons';
import { Backend } from '../utils/backend';
import { isNativeShell } from '../utils/nativeShell';

/**
 * The machine that is always there on a desktop: this one.
 *
 * A desktop window has a local machine in EVERY context — a local vault, a window with
 * no vault open at all, a window signed into an instance — because the CLIs are
 * installed on the computer in front of the person and reaching them asks for no
 * credential and no connection. A browser has none: its "local" would be the container
 * the instance runs in, shared by every member, so a browser's agents only ever come
 * from machines reached over SSH. The server refuses that route too; this is the half
 * that does not offer it.
 *
 * Prefixed, because a connection id is a uuid and this is deliberately not one.
 */
const LOCAL = '@local';

/**
 * Every machine at once — and this is the entry no tool on the market has.
 *
 * Every one of them reads the home directory of the computer it runs on. Rite holds the
 * fleet, so the question a person actually has is "where did I leave that conversation",
 * not "which host shall I interrogate".
 *
 * IT AGGREGATES WHAT HAS ALREADY BEEN READ and never asks anything. Fanning a probe out
 * across the library would be one SSH round trip per machine behind a view that opened
 * by itself, which is the thing ADR 0022 §4 refuses — so this scope has no probe button
 * and says how many machines it is speaking for.
 */
const ALL = '@all';

/** A conversation plus the adapter that reported it — what a row needs. */
interface Row {
  adapter: ShippedAdapter;
  conv: DiscoveredConversation;
  /** Which machine it was read on. Carried on the row because `@all` mixes them. */
  on: string;
  /** The name this person gave it, when they gave it one (ADR 0022 §6). */
  mark?: Mark;
}

/**
 * The colours a mark can wear: the machine palette, not one of this screen's own.
 *
 * Eight components grew their own hex array for the same job once and nothing made them
 * agree (#396); `e2e/swatch-palette-check.mjs` is what stops the ninth. A mark sits
 * beside a machine's own swatch in the same window, so it is that palette — a list
 * rather than a picker, because a mark is a way of finding a conversation again at a
 * glance and nine colours told apart across a grid beat sixteen million that are not.
 */
const MARK_COLORS = MACHINE_SWATCHES;

interface Props {
  /** Every machine this context can reach. */
  connections: ConnectionInfo[];
  /** The machine chosen, lifted so the choice survives leaving the view. */
  machineId: string | null;
  onPickMachine: (id: string | null) => void;
  /** Runs the one discovery command on a machine. Routed per source by the store. */
  probeAgents?: (connection: ConnectionInfo, command: string) => Promise<RemoteCommandOutput>;
  /** Runs one management command — today, a removal. Same routing, same gate. */
  manageAgents?: (connection: ConnectionInfo, command: string) => Promise<RemoteCommandOutput>;
  /**
   * The words declared with a colour, so a label here wears the colour it wears elsewhere.
   *
   * A conversation's own labels are personal (ADR 0022 §6) and carry no colour of their
   * own — but `pci` was declared somewhere, and the point of declaring it is that it looks
   * the same everywhere the word appears.
   */
  declared?: readonly VocabWord[];
  /** Open a pane on this conversation. A null machine is this computer. */
  onResume: (
    machine: ConnectionInfo | null,
    adapter: ShippedAdapter,
    conv: DiscoveredConversation,
  ) => void;
  /**
   * Start a conversation: the tool, and where it works. A null machine is this computer,
   * and an empty `cwd` is that machine's home — which only that machine can resolve.
   */
  onNew: (machine: ConnectionInfo | null, adapter: ShippedAdapter, cwd: string) => void;
  /** This server's mode, for the gate. */
  mode: ServerMode | null;
}

/** How a provenance reads, as a key. */
const PROV_KEY = {
  measured: 'agent.provMeasured',
  vendor: 'agent.provVendor',
  community: 'agent.provCommunity',
} as const;

export function AgentManager({
  connections,
  machineId,
  onPickMachine,
  probeAgents,
  manageAgents,
  declared,
  onResume,
  onNew,
  mode,
}: Props) {
  const { t } = useTranslation();
  // Per machine, so switching back does not throw away an answer that cost a round trip
  // — and read from the device at mount, so neither does closing the window. Lazy, so
  // storage is touched once per manager rather than on every render.
  const [answers, setAnswers] = useState<Record<string, Answer>>(readAnswers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'stacked' | 'rail'>('stacked');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [railTool, setRailTool] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  /** How far back to look, in days. 0 is all of it. */
  const [since, setSince] = useState(0);
  /**
   * Which name narrows the list: `@any`, `@named` for any of them, or `n:<name>`.
   *
   * A FILTER AND NOT A SECOND GROUPING, for the reason the whole screen refuses one: the
   * band per CLI is the structure of the page, and grouping by name instead would hide
   * which tool a conversation belongs to — the Claude Code Desktop trap. The sentinels
   * are prefixed so that a conversation actually named `@named` cannot become one.
   */
  const [named, setNamed] = useState('@any');
  /** Which label narrows the list: `@any`, or the label itself, folded for comparison. */
  const [label, setLabel] = useState('@any');
  /** The conversation a removal is in flight on, so its buttons stop answering. */
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * What a removal came back with, when it failed.
   *
   * ITS OWN STATE AND NOT `error`. A failed probe leaves nothing to show, so that one
   * replaces the list; a failed removal leaves the list exactly as true as it was, and
   * blanking it would throw away seventy conversations to report one `rm`.
   */
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** The new-conversation dialog, with the tool already chosen when a band opened it. */
  const [starting, setStarting] = useState<{ tool: ShippedAdapter | null } | null>(null);

  const native = isNativeShell();
  const onLocal = machineId === LOCAL;
  const onAll = machineId === ALL;
  const machine = connections.find((c) => c.id === machineId) ?? null;
  /**
   * The colour a machine already wears in the Library, by the id a row carries.
   *
   * THE CARD'S EDGE IS THE MACHINE'S, not a palette invented here. That colour was
   * chosen once, in the Library, and "the green ones are the home lab" is a fact the
   * person established — a second language for the same thing would compete with it.
   * A mark's own colour rides on the mark instead.
   */
  const colorOf = useCallback(
    (id: string) => connections.find((c) => c.id === id)?.color ?? undefined,
    [connections],
  );

  /** What a machine is called on screen, by the id a row carries. */
  const nameOf = useCallback(
    (id: string) =>
      id === LOCAL ? t('agent.thisMachine') : (connections.find((c) => c.id === id)?.name ?? id),
    [connections, t],
  );
  /** What the screen calls the thing being looked at: a name, or this computer. */
  const where = onAll
    ? t('agent.allMachines')
    : onLocal
      ? t('agent.thisMachine')
      : (machine?.name ?? '');
  const picked = onAll || onLocal || !!machine;
  /** How many machines `@all` is speaking for, which is what makes its count readable. */
  const readCount = Object.keys(answers).length;
  // `@all` has no answer of its own: it is every answer already held, and it is empty
  // until something has been read.
  const answer = machineId && !onAll ? answers[machineId] : undefined;
  const verdict = agentVerdict({ mode, native });
  const blocked = agentBlockedReason(verdict);

  const probe = useCallback(async () => {
    if (!machineId || (!onLocal && (!machine || !probeAgents))) return;
    setBusy(true);
    setError(null);
    try {
      const cmd = agentProbeCmd(SHIPPED_ADAPTERS);
      // Two routes, one answer shape. The local one asks for no connection and no
      // credential, because the files are already here.
      const out = onLocal
        ? await Backend.Terminal.agentProbeLocal(cmd)
        : await probeAgents!(machine!, cmd);
      // Stamped here. The answer is only as fresh as the moment this client read it,
      // and a host's own clock is not a fact about that.
      setAnswers((prev) =>
        keepAnswer(
          machineId,
          { at: Date.now(), tools: parseAgentProbe(out.stdout, SHIPPED_ADAPTERS) },
          prev,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [machineId, onLocal, machine, probeAgents]);

  // A failure note is about one machine and one file; switching machines makes it a
  // sentence about something nobody is looking at any more.
  useEffect(() => setRemoveError(null), [machineId]);

  const marks = useMarks((st) => st.marks);
  const setMark = useMarks((st) => st.set);
  const loadMarks = useMarks((st) => st.load);
  const marksLoaded = useMarks((st) => st.loaded);
  // Read once, when the manager is first opened: nothing else in the app needs them, so
  // loading them at startup would be a request for a screen most sessions never visit.
  useEffect(() => {
    if (!marksLoaded) void loadMarks();
  }, [marksLoaded, loadMarks]);
  /**
   * Open a conversation, on THE MACHINE IT WAS READ ON and not on the one being looked
   * at. Under `@all` those are different, and resuming the wrong one would open a
   * conversation id on a host that has never heard of it.
   */
  const resume = useCallback(
    (r: Row) =>
      onResume(
        r.on === LOCAL ? null : (connections.find((c) => c.id === r.on) ?? null),
        r.adapter,
        r.conv,
      ),
    [connections, onResume],
  );

  /** The conversation whose detail is open, or null. */
  const [open1, setOpen1] = useState<Row | null>(null);

  /** The conversation a rename is open on, or null. */
  const [renaming, setRenaming] = useState<Row | null>(null);

  /**
   * Ask the machine what can have CHANGED about one conversation.
   *
   * ON THE PROBE ROUTE AND NOT THE MANAGE ONE, because this is a read. Same gate either
   * way; the name is what tells a log which of the two happened.
   *
   * Nothing is cached and nothing is stored: `agentFactsCmd`'s own note holds the rule,
   * and the panel calls this on every open — a branch read once and kept would be the
   * same lie as a card carrying it.
   */
  const readFacts = useCallback(
    async (r: Row): Promise<AgentFacts | null> => {
      const cmd = agentFactsCmd(r.adapter, r.conv);
      if (!cmd) return null;
      const host = r.on === LOCAL ? null : (connections.find((c) => c.id === r.on) ?? null);
      if (!host && r.on !== LOCAL) return null;
      if (host && !probeAgents) return null;
      const out = host
        ? await probeAgents!(host, cmd)
        : await Backend.Terminal.agentProbeLocal(cmd);
      return parseAgentFacts(out.stdout);
    },
    [connections, probeAgents],
  );

  /**
   * Whether this conversation can be removed AT ALL, which is two questions.
   *
   * The tool has to name a file — three of the seven do not — and there has to be a way
   * to reach the machine it is on. Asked here rather than inside the handler, because a
   * button that is drawn and then does nothing on a click is worse than one that is not
   * drawn: the first teaches that the screen is broken, the second says nothing.
   */
  const canRemove = useCallback(
    (r: Row) =>
      !!agentRemoveCmd(r.adapter, r.conv) &&
      (r.on === LOCAL ? true : !!manageAgents && connections.some((c) => c.id === r.on)),
    [connections, manageAgents],
  );

  /**
   * Remove one conversation, ON THE MACHINE IT WAS READ ON — `resume`'s rule, for a
   * command that cannot be taken back.
   *
   * THE ROW DISAPPEARS BECAUSE THE FILE DID, not because the screen assumed so. `rm`
   * answers nothing on success and everything on failure, so a non-zero status is the
   * whole of what there is to read, and a card left standing after one would be a
   * conversation shown that is gone. The held answer is edited rather than re-read: a
   * second probe to learn what Rite had just done would be an SSH round trip nobody
   * asked for.
   */
  const remove = useCallback(
    async (r: Row) => {
      const cmd = agentRemoveCmd(r.adapter, r.conv);
      if (!cmd) return;
      const host = r.on === LOCAL ? null : (connections.find((c) => c.id === r.on) ?? null);
      if (!host && r.on !== LOCAL) return;
      if (host && !manageAgents) return;
      // The path is in the question, because it is the fact that settles it: what this
      // button removes is one file on one machine, and naming it is cheaper than any
      // sentence about it.
      const go = await askConfirm({
        title: t('agent.deleteTitle'),
        body: t('agent.deleteBody', { path: r.conv.path ?? '', machine: nameOf(r.on) }),
        action: t('agent.delete'),
        danger: true,
      });
      if (!go) return;
      setRemoving(`${r.on}:${r.adapter.id}:${r.conv.id}`);
      setRemoveError(null);
      try {
        const out = host
          ? await manageAgents!(host, cmd)
          : await Backend.Terminal.agentManageLocal(cmd);
        if (out.exitStatus !== 0) {
          throw new Error(
            out.stderr.trim() || t('agent.failedStatus', { status: String(out.exitStatus) }),
          );
        }
        setAnswers((prev) => {
          const held = prev[r.on];
          if (!held) return prev;
          return keepAnswer(
            r.on,
            {
              // The read is still from when it was read: one row is gone because Rite
              // removed it, not because the machine was asked again.
              ...held,
              tools: held.tools.map((tl) =>
                tl.id === r.adapter.id && tl.lines
                  ? { ...tl, lines: withoutConversation(r.adapter, tl.lines, r.conv.id) }
                  : tl,
              ),
            },
            prev,
          );
        });
        // AND THE NAME GOES WITH IT. A mark is keyed to a conversation id, so once the
        // conversation is gone the name is a dead entry — which is the whole reason marks
        // live in a document Rite owns rather than in the workspace file. This is the one
        // moment Rite knows for certain that one has rotted, so it is taken then.
        if (r.mark) {
          void setMark({ machine: r.on, tool: r.adapter.id, id: r.conv.id, name: null });
        }
        setOpen1(null);
      } catch (e) {
        setRemoveError(e instanceof Error ? e.message : String(e));
      } finally {
        setRemoving(null);
      }
    },
    [connections, manageAgents, nameOf, setMark, t],
  );

  /** Every conversation the answer holds, in the order each tool reported. */
  const rows: Row[] = useMemo(() => {
    if (!machineId) return [];
    // One machine's answer, or every answer already held. Never a probe: see `ALL`.
    const sources: [string, Answer][] = onAll
      ? Object.entries(answers)
      : answer
        ? [[machineId, answer]]
        : [];
    const out: Row[] = [];
    for (const [on, held] of sources) {
      for (const tool of held.tools) {
        const adapter = shippedAdapter(tool.id);
        if (!adapter || !tool.lines) continue;
        for (const conv of adapter.parse(tool.lines)) {
          out.push({
            adapter,
            conv,
            on,
            // Keyed by all three, because none of them is unique alone: two machines can
            // hold the same tool, and two tools the same id shape.
            mark: marks.find((m) => m.machine === on && m.tool === adapter.id && m.id === conv.id),
          });
        }
      }
    }
    // Across machines the tools' own orderings are no longer one list, so the rows are
    // put back in order by the only key they share. A row whose host could not say is
    // left where it was rather than sorted to an end it did not earn.
    if (onAll) {
      out.sort((a, b) =>
        a.conv.writtenAt && b.conv.writtenAt ? b.conv.writtenAt - a.conv.writtenAt : 0,
      );
    }
    return out;
  }, [answer, answers, onAll, machineId, marks]);

  /**
   * THREE FILTERS AND NO SECOND GROUPING, which is a decision rather than a shortcut.
   *
   * The band per CLI is the structure of the page. Claude Code Desktop offers "group by
   * date" beside "group by project" and its open tickets are what that costs: grouped by
   * date a session no longer says which project it belongs to, and the activity filter
   * stops being offered the moment the grouping changes. Two axes that each undo the
   * other. So this screen has one grouping and filters that compose with it.
   *
   * A conversation whose time the host could not say is never filtered OUT by time: the
   * absence of a fact is not evidence about it.
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const floor = since ? Date.now() / 1000 - since * 86400 : 0;
    return rows.filter((r) => {
      if (floor && r.conv.writtenAt !== undefined && r.conv.writtenAt < floor) return false;
      if (named === '@named' && !r.mark?.name) return false;
      if (named.startsWith('n:') && r.mark?.name !== named.slice(2)) return false;
      // Case-folded, because `API` and `api` are one label — what is STORED is what was
      // typed, and what is COMPARED is folded.
      if (
        label !== '@any' &&
        !(r.mark?.labels ?? []).some((l) => l.toLowerCase() === label.toLowerCase())
      ) {
        return false;
      }
      if (!q) return true;
      // Labels are searched like everything else a person typed, because the point of a
      // short word is that it is the thing you reach for — a label you have to open a
      // dropdown to use is a label you stop using.
      return [
        r.mark?.name,
        ...(r.mark?.labels ?? []),
        r.conv.ask,
        r.conv.project,
        r.conv.label,
        r.conv.id,
        r.adapter.name,
      ]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q));
    });
  }, [rows, query, since, named, label]);

  /**
   * The names in use on this machine, which are the only ones worth offering.
   *
   * The control is not drawn until one exists: a filter for a thing nobody has done yet
   * is how a row of controls teaches people to stop reading it.
   */
  const names = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) if (r.mark?.name) seen.add(r.mark.name);
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  /**
   * EVERY LABEL THIS PERSON HAS USED, which is the vocabulary and is not stored anywhere.
   *
   * Derived from the marks document rather than kept beside it: a list of labels that
   * exist but are on nothing is a list of labels that do nothing, and a stored one is a
   * second collection to keep in step with the first. Used once, anywhere, and the word
   * is offered everywhere — which is the whole of what a picker is for.
   *
   * From `marks` and not from `rows`: the rows are one machine's, and a label typed on a
   * machine that has not been probed in this window is still a label this person uses.
   */
  const vocabulary = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of marks) {
      for (const l of m.labels ?? []) if (!seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [marks]);

  /**
   * What the rename dialog OFFERS: the declared words, then this person's own.
   *
   * THE DECLARED ONES BELONG HERE TOO, which is the whole reason a vocabulary is declared
   * — once, so it is not retyped. They were offered on a machine's form and not on a
   * conversation's dialog, so `pci` was a click on one screen and a retype on the other
   * while both already resolved its COLOUR from the same declaration. That is the
   * inconsistency, not a missing feature.
   *
   * Declared first, because `offersFrom` keeps the first spelling it sees: a word declared
   * for the instance is offered the way it was declared, not the way somebody typed it on
   * a conversation afterwards. A personal word is marked `personal`, so the chip says
   * which are this person's own once there is more than one scope to tell apart.
   */
  const offers = useMemo(
    () => [
      ...(declared ?? []).map((w) => ({ ...w, scope: 'instance' as const })),
      ...vocabulary
        .filter((l) => !(declared ?? []).some((w) => w.label.toLowerCase() === l.toLowerCase()))
        .map((label) => ({ label, scope: 'personal' as const })),
    ],
    [declared, vocabulary],
  );

  /** One band per tool that reported something, in the shipped order. */
  const bands = useMemo(() => {
    const byTool = new Map<string, Row[]>();
    for (const r of shown) {
      const list = byTool.get(r.adapter.id) ?? [];
      list.push(r);
      byTool.set(r.adapter.id, list);
    }
    return SHIPPED_ADAPTERS.filter((a) => byTool.has(a.id)).map((a) => ({
      adapter: a,
      rows: byTool.get(a.id)!,
    }));
  }, [shown]);

  // A tool that is installed and could not answer is the one state with something to do
  // about it, so it is never folded into the quiet line below.
  const broken = (answer?.tools ?? []).filter((tl) => tl.installed && tl.failure);
  // An adapter that has not been LOOKED for is about Rite, not about the host — only
  // Rite can resolve it, so it is said once rather than as a card each. A tool that is
  // simply not installed is not mentioned at all: that is the absence of a state, and
  // naming six absences is how a foot line stops being read.
  const notLookedFor = answer
    ? SHIPPED_ADAPTERS.filter((a) => !answer.tools.some((tl) => tl.id === a.id)).map((a) => a.name)
    : [];

  /**
   * The tools a conversation can be STARTED with here: the ones the last probe found
   * installed.
   *
   * Which is why there is no New button before a probe and none under `@all`. A tool
   * this machine does not have would open a pane that exits with `command not found`,
   * and `@all` is every machine already read — a new conversation has to begin on one.
   */
  const installed = (answer?.tools ?? [])
    .filter((tl) => tl.installed)
    .map((tl) => shippedAdapter(tl.id))
    .filter((a): a is ShippedAdapter => !!a);

  const machineOptions = [
    { value: '', label: t('agent.pickNone') },
    // First, and only on a desktop. It needs no vault and no connection, so it is there
    // before anything else is — including before a vault has been opened at all.
    // Every machine already read, first — the question people actually have.
    ...(readCount > 0 ? [{ value: ALL, label: t('agent.allMachines') }] : []),
    ...(native ? [{ value: LOCAL, label: t('agent.thisMachine') }] : []),
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-background"
      data-testid="agent-manager"
    >
      {starting && (
        <NewAgentDialog
          tools={installed}
          tool={starting.tool}
          where={where}
          onClose={() => setStarting(null)}
          onStart={(adapter, cwd) => {
            setStarting(null);
            // `@all` is every answer already held and not a place to start anything. The
            // button is not drawn there, and this is the second half of that sentence.
            if (!onLocal && !machine) return;
            onNew(onLocal ? null : machine, adapter, cwd);
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          row={renaming}
          vocabulary={offers}
          onClose={() => setRenaming(null)}
          onSave={(name, color, labels) => {
            // Neither a name nor a label takes the mark away rather than writing an entry
            // that says nothing — the same gesture as the Clear button, from the keyboard.
            // `renaming.on`, not the machine being looked at: under `@all` a row can come
            // from any of them, and a mark keyed to the wrong one would name a
            // conversation that machine does not hold.
            const key = { machine: renaming.on, tool: renaming.adapter.id, id: renaming.conv.id };
            void setMark(
              name || labels.length ? { ...key, name, color, labels } : { ...key, name: null },
            );
            setRenaming(null);
          }}
        />
      )}
      {/* TWO ROWS, AND WHICH CONTROL SITS IN WHICH IS THE WHOLE POINT. The subject of the
          screen — the machine, and the button that reads it — is the first thing on the
          first row, because everything below depends on it; under a real load the header
          wrapped and left the picker BELOW the filters that cannot work without it. The
          second row is what narrows what came back, and it is not drawn at all until
          something has. */}
      <header className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{t('agent.title')}</div>
            <div className="truncate text-xs text-muted-foreground" data-testid="agent-subtitle">
              {picked
                ? onAll
                  ? // Every answer already held, and how many machines said them —
                    // without that second number the count is a total of nothing nameable.
                    t('agent.countAll', {
                      count: String(rows.length),
                      machines: String(readCount),
                    })
                  : answer
                    ? t(rows.length === 1 ? 'agent.countOne' : 'agent.count', {
                        count: String(rows.length),
                        machine: where,
                      })
                    : t('agent.notProbed', { machine: where })
                : t('agent.pickFirst')}
            </div>
          </div>
          <span className="flex-1" />
          <Dropdown
            value={machineId ?? ''}
            options={machineOptions}
            onChange={(v) => onPickMachine(v === '' ? null : v)}
            label={t('agent.pickMachine')}
            testId="agent-machine"
          />
          {picked && !onAll && !blocked && (
            <button
              type="button"
              onClick={() => void probe()}
              disabled={busy}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              data-testid="agent-probe"
            >
              {busy
                ? t('agent.probing')
                : answer
                  ? t('agent.again')
                  : t('agent.probe', { machine: where })}
            </button>
          )}
          {installed.length > 0 && !blocked && (
            <button
              type="button"
              onClick={() => setStarting({ tool: null })}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
              data-testid="agent-new"
            >
              <IconPlus className="h-3.5 w-3.5" />
              {t('agent.new')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            data-testid="agent-tools-toggle"
          >
            {t('agent.tools')}
          </button>
        </div>
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="h-7 w-56 rounded-md border border-border bg-card px-2 text-sm"
              placeholder={t('agent.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="agent-search"
            />
            <Dropdown
              value={since}
              options={[
                { value: 0, label: t('agent.sinceAll') },
                { value: 1, label: t('agent.since1') },
                { value: 7, label: t('agent.since7') },
                { value: 30, label: t('agent.since30') },
              ]}
              onChange={setSince}
              label={t('agent.since')}
              testId="agent-since"
            />
            {names.length > 0 && (
              <Dropdown
                value={named}
                options={[
                  { value: '@any', label: t('agent.nameAny') },
                  { value: '@named', label: t('agent.nameGiven') },
                  ...names.map((n) => ({ value: `n:${n}`, label: n })),
                ]}
                onChange={setNamed}
                label={t('agent.byName')}
                testId="agent-named"
              />
            )}
            {vocabulary.length > 0 && (
              <Dropdown
                value={label}
                options={[
                  { value: '@any', label: t('agent.labelAny') },
                  ...vocabulary.map((l) => ({ value: l, label: l })),
                ]}
                onChange={setLabel}
                label={t('agent.byLabel')}
                testId="agent-label"
              />
            )}
            <span className="flex-1" />
            {/* The two arrangements of one grouping, at the far end: a view preference,
                not a filter, so it does not sit among the things that remove rows. */}
            <div className="flex overflow-hidden rounded-md border border-border" role="group">
              {(['stacked', 'rail'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setLayout(k)}
                  title={t(k === 'stacked' ? 'agent.layoutStackedHint' : 'agent.layoutRailHint')}
                  data-testid={`agent-layout-${k}`}
                  className={`px-2.5 py-1 text-xs ${
                    layout === k ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {t(k === 'stacked' ? 'agent.layoutStacked' : 'agent.layoutRail')}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {toolsOpen && <ToolsPanel />}

      {/* The list and the detail side by side, so opening one does not cover the other —
          which is the whole argument for a panel over a modal: you keep looking at the
          list you found it in. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {blocked ? (
            <Note testId="agent-blocked" title={t('agent.offTitle')} body={t(blocked)} />
          ) : !picked ? (
            <Note
              testId="agent-no-machine"
              title={t('agent.pickFirst')}
              body={native ? t('agent.probeNote') : t('agent.noLocalInBrowser')}
            />
          ) : error ? (
            <Note
              testId="agent-error"
              title={t('agent.failedProbe', { machine: where })}
              body={error}
            />
          ) : !answer && !onAll ? (
            <Note
              testId="agent-not-probed"
              title={t('agent.notProbed', { machine: where })}
              body={t('agent.probeNote')}
            />
          ) : (
            <div className="space-y-4">
              {removeError && (
                <Note
                  testId="agent-remove-failed"
                  title={t('agent.deleteFailed')}
                  body={removeError}
                />
              )}
              {rows.length === 0 ? (
                <Note
                  testId="agent-empty"
                  title={t('agent.none', { machine: where })}
                  body={
                    answer
                      ? t('agent.readAt', { when: new Date(answer.at).toLocaleTimeString() })
                      : ''
                  }
                />
              ) : shown.length === 0 ? (
                // Which filter emptied the screen, because three of them can and a blank
                // panel that does not say leaves the reader turning them off one by one.
                <Note
                  testId="agent-no-match"
                  title={query ? t('agent.noMatch', { query }) : t('agent.noneLeft')}
                  body={t('agent.noneLeftHint', { count: String(rows.length) })}
                />
              ) : layout === 'stacked' ? (
                bands.map((b) => (
                  <Band
                    key={b.adapter.id}
                    adapter={b.adapter}
                    rows={b.rows}
                    folded={folded[b.adapter.id] === true}
                    onFold={() =>
                      setFolded((p) => ({ ...p, [b.adapter.id]: !(p[b.adapter.id] === true) }))
                    }
                    onResume={(r) => resume(r)}
                    onRename={setRenaming}
                    onOpen={setOpen1}
                    declared={declared}
                    onNew={
                      installed.includes(b.adapter)
                        ? () => setStarting({ tool: b.adapter })
                        : undefined
                    }
                    nameOf={onAll ? nameOf : undefined}
                    colorOf={colorOf}
                  />
                ))
              ) : (
                <Rail
                  bands={bands}
                  active={railTool ?? bands[0]?.adapter.id ?? null}
                  onPick={setRailTool}
                  onResume={(r) => resume(r)}
                  onRename={setRenaming}
                  onOpen={setOpen1}
                  declared={declared}
                  onNew={
                    installed.length > 0
                      ? (adapter) =>
                          setStarting({ tool: installed.includes(adapter) ? adapter : null })
                      : undefined
                  }
                  nameOf={onAll ? nameOf : undefined}
                  colorOf={colorOf}
                />
              )}

              {broken.map((tl) => (
                <Note
                  key={tl.id}
                  testId={`agent-broken-${tl.id}`}
                  title={t('agent.failed', { tool: shippedAdapter(tl.id)?.name ?? tl.id })}
                  body={`${t('agent.failedStatus', { status: String(tl.failure!.status) })} · ${tl.failure!.output}`}
                />
              ))}
              {notLookedFor.length > 0 && (
                <p
                  className="font-mono text-xs text-muted-foreground"
                  data-testid="agent-not-looked"
                >
                  {t('agent.notLookedFor', { tools: notLookedFor.join(', ') })}
                </p>
              )}
            </div>
          )}
        </div>
        {open1 && (
          <Detail
            // Keyed by the conversation, so opening a second one starts its panel over
            // rather than carrying the first one's unfolded prompt into it.
            key={`${open1.on}:${open1.adapter.id}:${open1.conv.id}`}
            row={open1}
            on={nameOf(open1.on)}
            onClose={() => setOpen1(null)}
            onResume={() => resume(open1)}
            onRename={() => setRenaming(open1)}
            onDelete={canRemove(open1) ? () => void remove(open1) : undefined}
            onNew={() => setStarting({ tool: open1.adapter })}
            readFacts={() => readFacts(open1)}
            declared={declared}
            deleting={removing === `${open1.on}:${open1.adapter.id}:${open1.conv.id}`}
          />
        )}
      </div>
    </div>
  );

  /** The six adapters, as the probe will run them. Read-only until Tools can edit. */
  function ToolsPanel() {
    return (
      <div className="border-b border-border bg-card px-4 py-3" data-testid="agent-tools">
        <div className="mb-2 text-xs text-muted-foreground">{t('agent.toolsHint')}</div>
        <div className="space-y-2">
          {SHIPPED_ADAPTERS.map((a) => (
            <div key={a.id} className="text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{a.name}</span>
                <span className="font-mono text-muted-foreground">{a.bin}</span>
                <span className="rounded border border-border px-1 text-[11px] text-muted-foreground">
                  {t(PROV_KEY[a.from.kind])}
                </span>
                {a.idKind !== 'uuid' && (
                  <span
                    className="rounded border border-border px-1 text-[11px] text-muted-foreground"
                    title={t(a.idKind === 'index' ? 'agent.idKindIndex' : 'agent.idKindTitle')}
                  >
                    {t(a.idKind === 'index' ? 'agent.idKindIndexShort' : 'agent.idKindTitleShort')}
                  </span>
                )}
              </div>
              <div className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                <div>
                  {t('agent.listCmd')} {a.list}
                </div>
                <div>
                  {t('agent.resumeCmd')} {a.resume}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
}

/**
 * How a last-written time reads on a card: short, and in the reader's own locale.
 *
 * `Intl` rather than a format of our own, because a date is one of the few things every
 * platform already knows how to say in the order the person reading it expects.
 */
const WHEN: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** Why a live read has no branch to report, as a key. One sentence each, no overlap. */
const LIVE_MISSING = {
  cwd: 'agent.liveNoCwd',
  directory: 'agent.liveGone',
  git: 'agent.liveNoGit',
  repository: 'agent.liveNoRepo',
  permission: 'agent.livePermission',
} as const;

/**
 * What is known about one conversation, beside the list rather than over it.
 *
 * The mock calls this the seam every later integration arrives through, and that is why
 * it exists before there is much to put in it. What it holds today is what a LISTING
 * gave: where it runs, when it was last written, the handle, the line that resumes it —
 * and the first thing the person typed.
 *
 * THE FACTS AND THE ACTIONS COME FIRST, THE PROMPT LAST AND FOLDED. A first message can
 * be a pasted file: four thousand characters at the top of the panel pushed the five
 * buttons off the bottom of it, so opening a card meant scrolling to do anything. The
 * prompt is the reason to open the panel and not the reason to scroll it, so it sits
 * under the actions, clamped, with a control that appears only when there is more — and
 * the control is measured rather than guessed from the length, because a "see more" that
 * reveals nothing is worse than no control at all.
 *
 * WHAT IS NOT HERE IS NOT BLANK, IT IS ABSENT. The mock also draws the branch, the
 * working directory, the turn count and the agent's last line — all of them inside a
 * transcript, which is a second read per conversation that does not exist yet. A panel
 * with four empty rows would say Rite looked and found nothing, which is not what
 * happened.
 */
function Detail({
  row,
  on,
  onClose,
  onResume,
  onRename,
  onDelete,
  onNew,
  readFacts,
  declared,
  deleting,
}: {
  row: Row;
  on: string;
  /** The words declared with a colour, so a chip here matches a chip anywhere else. */
  declared?: readonly VocabWord[];

  onClose: () => void;
  onResume: () => void;
  onRename: () => void;
  /** Absent when this tool's listing names no file to remove. */
  onDelete?: () => void;
  onNew: () => void;
  /** Asks the machine what has changed. Resolves null when there is nothing to ask. */
  readFacts: () => Promise<AgentFacts | null>;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const { conv, adapter, mark } = row;
  const tags = mark?.labels ?? [];
  const written = conv.writtenAt ? new Date(conv.writtenAt * 1000) : null;
  const line = agentResumeCmd(adapter, conv.id);
  const ask = useRef<HTMLParagraphElement>(null);
  /** Whether the prompt is taller than the clamp — measured, see the note above. */
  const [more, setMore] = useState(false);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    const el = ask.current;
    setMore(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [conv.ask]);
  /**
   * What the machine says NOW: undefined while it is being asked, null when there is
   * nothing to ask, a string when the ask failed.
   *
   * READ ON EVERY OPEN. The panel is keyed by the conversation, so this effect runs again
   * for the next card — and again for the same card reopened, which is the point: a
   * branch is only true at the moment it was read, so it is read at the moment it is
   * shown and never kept afterwards.
   */
  const [facts, setFacts] = useState<AgentFacts | null | undefined>(undefined);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    // LIVE, AND DROPPED ON THE WAY OUT. The flag was here from the first version with
    // nothing to flip it, so the guard was inert: an answer about the conversation that
    // was open a second ago would have landed in the panel of the next one — the one
    // thing a panel that keeps nothing must not do. `prefer-const` on a `let` nobody
    // reassigns is what pointed at it.
    let live = true;
    readFacts()
      .then((f) => live && setFacts(f))
      .catch((e) => {
        if (!live) return;
        setFacts(null);
        setFactsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
    // Not `readFacts` in the dependencies: it is a closure the parent rebuilds on every
    // render, and asking the machine again on each of those is the one thing this must
    // not do. The conversation is keyed by the panel; `turn` is the reload button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn]);
  const fact = (label: string, value: React.ReactNode, mono = false) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</dd>
    </>
  );
  /** One action, as an icon with its name under the cursor. */
  const act = (
    key: string,
    Icon: (p: { className?: string }) => React.JSX.Element,
    onClick: () => void,
    testId: string,
    danger = false,
  ) => (
    <button
      type="button"
      onClick={onClick}
      title={t(key)}
      aria-label={t(key)}
      disabled={deleting}
      className={`rounded-md border border-border p-1.5 disabled:opacity-50 ${
        danger ? 'text-red-500 hover:bg-red-500/10' : 'hover:bg-muted'
      }`}
      data-testid={testId}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
  return (
    <aside
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-card p-4"
      data-testid="agent-detail"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {/* Clamped, because with no name of its own this falls back to the first
              message — which is the thing that can be a page long. */}
          <div className="line-clamp-2 text-sm font-medium" data-testid="agent-detail-title">
            {mark?.name ?? conv.ask ?? conv.project ?? conv.id}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {on} · {adapter.name}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('agent.detailClose')}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          data-testid="agent-detail-close"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs">
        {/* ONLY WHEN IT IS A REAL PATH, which is what `/` says. Claude files a
            conversation under the working directory with every `/` replaced by `-`, and
            that slug cannot be turned back into a path — so in a panel that now reads the
            TRUE directory off the machine, printing the slug beside it is two answers to
            one question, one of them mangled. Grok's decodes exactly and stands on its
            own; Codex has none. The card still shows the slug: at list time nothing has
            been asked of any machine. */}
        {conv.project?.startsWith('/') && fact(t('agent.detailProject'), conv.project, true)}
        {written && fact(t('agent.detailWritten'), written.toLocaleString())}
        {/* Where it lives, when the listing named a file — which is also what Delete
            removes, so the panel shows it rather than leaving the confirmation to
            introduce a path nobody had seen. */}
        {conv.path && fact(t('agent.detailFile'), conv.path, true)}
        {/* The id, and WHAT KIND of id it is. Gemini's moves as the list changes, which
            is a property of the handle and belongs beside it rather than in a footnote. */}
        {fact(
          adapter.idKind === 'index' ? t('agent.detailIndex') : t('agent.detailId'),
          <>
            <span className="break-all">{conv.id}</span>
            {adapter.idKind !== 'uuid' && (
              <div className="mt-0.5 text-amber-500">
                {t(adapter.idKind === 'index' ? 'agent.idKindIndex' : 'agent.idKindTitle')}
              </div>
            )}
          </>,
          true,
        )}
        {fact(t('agent.detailResumes'), line, true)}
        {tags.length !== 0 &&
          fact(
            t('labels.field'),
            <span className="flex flex-wrap gap-1">
              {tags.map((l) => (
                <LabelChip key={l.toLowerCase()} label={l} declared={declared} />
              ))}
            </span>,
          )}
      </dl>

      {/* WHAT THE MACHINE SAYS NOW, and it is a block of its own rather than two more
          rows above — because everything above came out of a file and everything here
          came out of an answer to a question asked a second ago. Mixing them would make
          a branch look as settled as a uuid, which is the whole reason it is down here
          and not on the card. */}
      {facts !== null && (
        <div className="rounded-md border border-border/70 p-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('agent.detailLive')}</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => {
                setFacts(undefined);
                setFactsError(null);
                setTurn((v) => v + 1);
              }}
              disabled={facts === undefined}
              title={t('agent.again')}
              aria-label={t('agent.again')}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
              data-testid="agent-detail-live-again"
            >
              <IconRefresh className="h-3.5 w-3.5" />
            </button>
          </div>
          {facts === undefined ? (
            <div className="mt-1 text-xs text-muted-foreground" data-testid="agent-detail-live">
              {t('agent.liveReading')}
            </div>
          ) : (
            <dl
              className="mt-1 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs"
              data-testid="agent-detail-live"
            >
              {facts.cwd && fact(t('agent.detailCwd'), facts.cwd, true)}
              {/* A branch, a detached head, or the reason there is neither — never a
                  branch called `HEAD`, which is what `git` prints and nobody is on. */}
              {(facts.branch || facts.detached || facts.missing) &&
                fact(
                  t('agent.detailBranch'),
                  facts.branch ? (
                    <>
                      <span className="font-mono">{facts.branch}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        {t(facts.dirty ? 'agent.liveDirty' : 'agent.liveClean')}
                      </span>
                    </>
                  ) : facts.detached ? (
                    t('agent.liveDetached')
                  ) : (
                    t(LIVE_MISSING[facts.missing!])
                  ),
                )}
            </dl>
          )}
        </div>
      )}
      {factsError && (
        <div
          className="text-[11px] leading-relaxed text-amber-500"
          data-testid="agent-detail-live-failed"
        >
          {t('agent.liveFailed')} — {factsError}
        </div>
      )}

      {/* Resume keeps its word on it: it is what the panel is for, and the four beside it
          are variations on getting hold of the thing. Delete is last and apart, in the
          one colour on this screen that means a file goes away. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onResume}
          disabled={deleting}
          className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          data-testid="agent-detail-resume"
        >
          <IconPlay className="h-3.5 w-3.5" />
          {t('agent.resume')}
        </button>
        {act('agent.rename', IconEdit, onRename, 'agent-detail-rename')}
        {act(
          'agent.detailCopyId',
          IconCopy,
          () => void navigator.clipboard?.writeText(conv.id),
          'agent-detail-copy-id',
        )}
        {act(
          'agent.detailCopyCmd',
          IconTerminal,
          () => void navigator.clipboard?.writeText(line),
          'agent-detail-copy-cmd',
        )}
        {act('agent.new', IconPlus, onNew, 'agent-detail-new')}
        <span className="flex-1" />
        {/* Absent rather than disabled: three of the seven listings name no file, and a
            greyed button invites the question "why not" where there is nothing to do
            about it. The tools that can remove are the ones that showed a path. */}
        {onDelete && act('agent.delete', IconTrash, onDelete, 'agent-detail-delete', true)}
      </div>

      {/* Last, and the only thing on the panel that is quoted rather than stated. */}
      {conv.ask && (
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{t('agent.detailAsked')}</div>
          <p
            ref={ask}
            className={`mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed ${
              whole ? '' : 'line-clamp-6'
            }`}
            data-testid="agent-detail-ask"
          >
            {conv.ask}
          </p>
          {more && (
            <button
              type="button"
              onClick={() => setWhole((v) => !v)}
              className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
              data-testid="agent-detail-ask-more"
            >
              {t(whole ? 'agent.askLess' : 'agent.askMore')}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

/** A titled note. Every empty and every refusal on this screen is one of these. */
function Note({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div className="max-w-xl rounded-md border border-border bg-card p-4" data-testid={testId}>
      <div className="text-sm font-medium">{title}</div>
      {body && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</div>}
    </div>
  );
}

/**
 * One conversation. Project, when it was last written, handle, and a way in.
 *
 * WHAT IS ON THE FIRST LINE IS THE SORT KEY, or something that does not compete with it:
 * a project when the path gives one, otherwise the time this conversation was last
 * written, which is what the list is ordered by. Codex's file name carries the date it
 * STARTED, and putting that on the first line made sixty-one cards read as a shuffle — a
 * conversation begun in September and resumed today sorts first and reads last. It is
 * still there, under `title`, where it cannot be mistaken for the order.
 */
function Card({
  row,
  onResume,
  onRename,
  onOpen,
  declared,
  on,
  edge,
}: {
  row: Row;
  onResume: () => void;
  onRename: () => void;
  onOpen: () => void;
  /** The words declared with a colour, so a chip here matches a chip anywhere else. */
  declared?: readonly VocabWord[];
  /** The machine's name, when the list mixes machines. Absent on a single one. */
  on?: string;
  /** The machine's colour from the Library, when it has one. */
  edge?: string;
}) {
  const { t } = useTranslation();
  const { conv, mark } = row;
  const tags = mark?.labels ?? [];
  const written = conv.writtenAt ? new Date(conv.writtenAt * 1000) : null;
  const stamp = written ? written.toLocaleString(undefined, WHEN) : null;
  // What a conversation IS to someone looking for it: the thing they typed first. Then
  // the project, then the time it was last written — each one a fact the listing gave,
  // never a stand-in for the one above it.
  // A NAME THE PERSON GAVE IT WINS OVER EVERYTHING, which is the whole point of giving
  // one: what the tool reported is still underneath, so a rename adds a handle rather
  // than hiding what it is.
  const headline = mark?.name ?? conv.ask ?? conv.project ?? stamp ?? conv.label ?? null;
  // Whatever is left to place under it, and ONLY what the headline has not already
  // said. Without the second test a Codex card printed its date twice, once as the
  // headline it fell back to and once underneath — which reads as a card with nothing
  // on it.
  const under = [
    on,
    mark ? (conv.ask ?? conv.project) : conv.ask ? conv.project : null,
    headline === stamp ? null : stamp,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      // The machine's colour, always — a card says where it runs before it says anything
      // else. A mark's colour is on the mark, beside its name.
      style={edge ? { borderLeft: `3px solid ${edge}` } : undefined}
      data-testid={`agent-card-${conv.id}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <div
        className="truncate text-sm font-medium"
        title={[conv.ask, conv.project, conv.label && t('agent.started', { when: conv.label })]
          .filter(Boolean)
          .join('\n')}
      >
        {mark?.color && (
          <span
            className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
            style={{ background: mark.color }}
          />
        )}
        {headline ?? <span className="text-muted-foreground">{t('agent.noProject')}</span>}
      </div>
      {/* The labels, under the headline and above everything the tool said — they are the
          person's own filing and the reason they are on the card at all is to be seen
          without reading. */}
      {tags.length !== 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((l) => (
            <LabelChip key={l.toLowerCase()} label={l} small declared={declared} />
          ))}
        </div>
      )}
      {/* Under the headline rather than replacing it, so a card never has to choose
          between two true things — and a time is absent when the host's `stat` answered
          neither syntax, rather than being one nobody measured. */}
      {under && (
        <div
          className="truncate text-[11px] text-muted-foreground"
          title={written ? written.toString() : undefined}
        >
          {under}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {conv.id}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(conv.id);
          }}
          title={t('agent.copyId', { id: conv.id })}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          data-testid={`agent-copy-${conv.id}`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 4h10a2 2 0 012 2v10M6 8h10a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          title={t('agent.rename')}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          data-testid={`agent-rename-${conv.id}`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 7h-.01M3 7V4a1 1 0 011-1h3l10 10-4 4L3 7z"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onResume();
          }}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
          data-testid={`agent-resume-${conv.id}`}
        >
          {t('agent.resume')}
        </button>
      </div>
    </div>
  );
}

/**
 * Naming and filing someone else's conversation.
 *
 * A name, a colour and any number of labels, all this person's, over a session they did
 * not create here. The vendor's files are never touched (ADR 0022 §6): what is written is
 * a row in the marks document Rite owns — a file on this machine, or a blob the account
 * holds and the server cannot read.
 *
 * A NAME AND LABELS ARE TWO ANSWERS TO TWO QUESTIONS, in one dialog because they are one
 * gesture. The name is "which one is this" and there is one of it: it becomes the card's
 * headline. A label is "which group is this in" and there can be several: they drive the
 * filter. One field doing both would make a headline out of a list.
 *
 * Labels are typed as text, comma-separated, and not picked from a list — there is no
 * list until somebody has typed one, and a picker that starts empty is a dialog asking a
 * question it has not been given the means to answer.
 *
 * Clearing both removes the mark entirely rather than leaving an empty one, so the
 * document never carries a row that says nothing.
 */
function RenameDialog({
  row,
  vocabulary,
  onClose,
  onSave,
}: {
  row: Row;
  /** Every word on offer — declared above, or used by this person. Never required. */
  vocabulary: LabelOffer[];
  onClose: () => void;
  onSave: (name: string, color: string | undefined, labels: string[]) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(row.mark?.name ?? '');
  const [color, setColor] = useState(row.mark?.color);
  const [labels, setLabels] = useState(row.mark?.labels ?? []);
  const what = row.conv.ask ?? row.conv.project ?? row.conv.id;
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
      data-testid="agent-rename-dialog"
    >
      <div
        className="w-full max-w-sm rounded-md border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium">{t('agent.rename')}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground" title={what}>
          {what}
        </div>
        <input
          autoFocus
          className="mt-3 h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          placeholder={t('agent.renamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(name.trim(), color, labels);
            if (e.key === 'Escape') onClose();
          }}
          data-testid="agent-rename-input"
        />
        <div className="mt-3 flex items-center gap-1.5">
          {MARK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(color === c ? undefined : c)}
              aria-label={c}
              data-testid={`agent-color-${c.slice(1)}`}
              className={`h-5 w-5 rounded-full border ${
                color === c ? 'border-foreground' : 'border-transparent'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
        {/* The shared field (`components/Labels.tsx`): the library's machines get the same
            one, so the chip, the cap and the picker cannot drift between two screens. The
            prefix keeps this screen's test ids. */}
        <LabelField
          labels={labels}
          onChange={setLabels}
          vocabulary={vocabulary}
          inputId="agent-labels-input"
          testPrefix="agent-labels"
        />
        <div className="mt-4 flex justify-end gap-2">
          {row.mark && (
            // Taking the name away is the other half of giving one, and it belongs on
            // this screen rather than in a document nobody edits by hand.
            <button
              type="button"
              onClick={() => onSave('', undefined, [])}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
              data-testid="agent-rename-clear"
            >
              {t('agent.renameClear')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2.5 py-1 text-xs"
            data-testid="agent-rename-cancel"
          >
            {t('agent.renameCancel')}
          </button>
          <button
            type="button"
            onClick={() => onSave(name.trim(), color, labels)}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
            data-testid="agent-rename-save"
          >
            {t('agent.renameSave')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Starting a conversation, which asks for the one thing it cannot be told.
 *
 * THE WORKING DIRECTORY, AND NOTHING ELSE — the mock's dialog, and the right shape. A new
 * agent needs a tool, a machine and somewhere to stand; the machine is the one being
 * looked at and the tool is usually the band the button was pressed in, so one field is
 * left. BLANK IS THE HOME DIRECTORY, named as a word rather than filled in, because this
 * client cannot know the home directory of a machine it has not asked.
 *
 * NO PRE-PROMPT BOX. ADR 0022 §8 leaves the management layer out deliberately — stored
 * pre-prompts, per-project conventions — and a text area here would be the first half of
 * it, shipped before the thing it is meant to improve has been argued.
 */
function NewAgentDialog({
  tools,
  tool,
  where,
  onClose,
  onStart,
}: {
  /** The tools this machine was found to have. Never empty: the button is not drawn. */
  tools: ShippedAdapter[];
  /** Already chosen, when a band asked. Null when the header did. */
  tool: ShippedAdapter | null;
  where: string;
  onClose: () => void;
  onStart: (adapter: ShippedAdapter, cwd: string) => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState(tool?.id ?? tools[0]?.id ?? '');
  const [cwd, setCwd] = useState('');
  const chosen = tools.find((a) => a.id === pick) ?? tools[0];
  // ABSOLUTE OR BLANK, refused here rather than on the machine. A relative path would be
  // resolved against whatever directory the process happens to stand in — the server
  // refuses one outright (`named_start_dir`), and the agent would then open somewhere
  // nobody named. `~` is not accepted either: a remote shell expands it and a local spawn
  // does not, so the two supports would answer differently to the same word.
  const ok = !cwd.trim() || cwd.trim().startsWith('/');
  const start = () => ok && chosen && onStart(chosen, cwd.trim());
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
      data-testid="agent-new-dialog"
    >
      <div
        className="w-full max-w-sm rounded-md border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium">{t('agent.new')}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{where}</div>
        {/* Fixed when a band asked: the heading it was pressed under already answered
            this, and a picker that reopens the question reads as a second one. */}
        {tool ? (
          <div className="mt-3 text-xs">{tool.name}</div>
        ) : (
          <div className="mt-3">
            <Dropdown
              value={pick}
              options={tools.map((a) => ({ value: a.id, label: a.name }))}
              onChange={setPick}
              label={t('agent.newTool')}
              testId="agent-new-tool"
            />
          </div>
        )}
        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="agent-new-cwd">
          {t('agent.newCwd')}
        </label>
        <input
          id="agent-new-cwd"
          autoFocus
          className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm"
          placeholder={t('agent.newCwdPlaceholder')}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start();
            if (e.key === 'Escape') onClose();
          }}
          data-testid="agent-new-cwd"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2.5 py-1 text-xs"
          >
            {t('agent.renameCancel')}
          </button>
          <button
            type="button"
            onClick={start}
            disabled={!chosen || !ok}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="agent-new-start"
          >
            {t('agent.newStart')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Every CLI at once: a heading per tool, its conversations in a grid under it. */
function Band({
  adapter,
  rows,
  folded,
  onFold,
  onResume,
  onRename,
  onOpen,
  onNew,
  declared,
  nameOf,
  colorOf,
}: {
  adapter: ShippedAdapter;
  rows: Row[];
  /** The words declared with a colour, so a chip here matches a chip anywhere else. */
  declared?: readonly VocabWord[];
  folded: boolean;
  onFold: () => void;
  onResume: (row: Row) => void;
  onRename: (row: Row) => void;
  onOpen: (row: Row) => void;
  /** Start one with this tool. Absent when the machine does not have it. */
  onNew?: () => void;
  /** Names a machine when the list mixes them; absent when it does not. */
  nameOf?: (id: string) => string;
  /** The machine's own colour from the Library, by row. */
  colorOf: (id: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const [tail, setTail] = useState(false);
  // THE BAND SPLITS WHERE THE INFORMATION DOES. A session nobody typed into has a date
  // and an id and nothing else; sixty of them in front of the one that was, which is
  // what a real machine looks like, is a wall that hides the card being looked for.
  //
  // A fold rather than the global switch that was here before, for the reason this
  // screen refuses a second grouping: one mechanism per question. The count is on the
  // line, nothing is hidden without saying so, and a tool with none — Claude Code had
  // none — never grows the control.
  //
  // AND ONLY FOR AN ADAPTER THAT LOOKED. A conversation with no question is a session
  // nobody typed into; a conversation whose adapter never opened the transcript is one
  // nobody has READ. Splitting on the second would put "4 sessions with no question"
  // under Grok, which is not true of Grok — it is true of this client.
  const asked = adapter.readsAsk ? rows.filter((r) => r.conv.ask) : rows;
  const quiet = adapter.readsAsk ? rows.filter((r) => !r.conv.ask) : [];
  const grid = (list: Row[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
      {list.map((r) => (
        <Card
          key={`${r.on}:${r.adapter.id}:${r.conv.id}`}
          row={r}
          onResume={() => onResume(r)}
          onRename={() => onRename(r)}
          onOpen={() => onOpen(r)}
          declared={declared}
          on={nameOf?.(r.on)}
          edge={colorOf(r.on)}
        />
      ))}
    </div>
  );
  return (
    <section data-testid={`agent-band-${adapter.id}`}>
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onFold}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          data-testid={`agent-fold-${adapter.id}`}
        >
          <span className="text-sm font-semibold">{adapter.name}</span>
          <span className="text-xs text-muted-foreground">{rows.length}</span>
          <span className="text-xs text-muted-foreground">· {t('agent.newestFirst')}</span>
        </button>
        {/* Where the mock puts it: the tool is the heading, so a New under that heading
            needs no picker — it is already answered by which band was pressed. */}
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            title={t('agent.newWith', { tool: adapter.name })}
            aria-label={t('agent.newWith', { tool: adapter.name })}
            className="shrink-0 rounded-md border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid={`agent-new-${adapter.id}`}
          >
            <IconPlus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {!folded && (
        <>
          {asked.length > 0 && grid(asked)}
          {quiet.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setTail((v) => !v)}
                className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                data-testid={`agent-quiet-${adapter.id}`}
                title={t('agent.quietHint')}
              >
                <span className={`transition-transform ${tail ? 'rotate-90' : ''}`}>›</span>
                {t('agent.quiet', { count: String(quiet.length) })}
              </button>
              {tail && <div className="mt-2">{grid(quiet)}</div>}
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One CLI at a time, chosen from a rail — and its conversations as a LIST.
 *
 * The mock's argument for this arrangement is density: forty conversations is a long
 * wall of cards and a short scroll in a sidebar. The first version of it here did not
 * deliver that — a narrower grid of the same cards, two across where Stacked fits three,
 * so it was strictly worse than the thing it was offered beside. Looking at it under a
 * real load is what said so.
 *
 * So a row is one line: what was asked, where, when, and the way in. Roughly three times
 * as many fit, which is the whole reason to switch to it.
 *
 * AND NO FOLD HERE, unlike a band. The fold exists because a card costs a lot of height
 * for a session that has only a date on it, so sixty of them bury the one that matters.
 * A line costs almost nothing, and scrolling past sixty lines is what a list is for —
 * adding the control anyway would be a second mechanism for a problem this arrangement
 * does not have.
 */
function Rail({
  bands,
  active,
  onPick,
  onResume,
  onRename,
  onOpen,
  onNew,
  declared,
  nameOf,
  colorOf,
}: {
  bands: { adapter: ShippedAdapter; rows: Row[] }[];
  /** The words declared with a colour, so a chip here matches a chip anywhere else. */
  declared?: readonly VocabWord[];

  active: string | null;
  onPick: (id: string) => void;
  onResume: (row: Row) => void;
  onRename: (row: Row) => void;
  onOpen: (row: Row) => void;
  /** Start one with the tool the rail is on. Absent when the machine lacks it. */
  onNew?: (adapter: ShippedAdapter) => void;
  nameOf?: (id: string) => string;
  /** The machine's own colour from the Library, by row. */
  colorOf: (id: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const current = bands.find((b) => b.adapter.id === active) ?? bands[0];
  return (
    <div className="flex gap-4" data-testid="agent-rail">
      <nav className="w-44 shrink-0 space-y-1">
        {bands.map((b) => (
          <button
            key={b.adapter.id}
            type="button"
            onClick={() => onPick(b.adapter.id)}
            data-testid={`agent-rail-${b.adapter.id}`}
            className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
              b.adapter.id === current?.adapter.id
                ? 'bg-muted font-medium'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            <span className="truncate">{b.adapter.name}</span>
            <span className="text-xs">{b.rows.length}</span>
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {current && onNew && (
          <div className="mb-1.5 flex justify-end">
            <button
              type="button"
              onClick={() => onNew(current.adapter)}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid={`agent-new-${current.adapter.id}`}
            >
              <IconPlus className="h-3.5 w-3.5" />
              {t('agent.newWith', { tool: current.adapter.name })}
            </button>
          </div>
        )}
        {(current?.rows ?? []).map((r) => (
          <RailRow
            key={`${r.on}:${r.adapter.id}:${r.conv.id}`}
            row={r}
            onResume={() => onResume(r)}
            onRename={() => onRename(r)}
            onOpen={() => onOpen(r)}
            declared={declared}
            on={nameOf?.(r.on)}
            edge={colorOf(r.on)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

/** One conversation on one line. Same facts as a card, in a quarter of the height. */
function RailRow({
  row,
  onResume,
  onRename,
  onOpen,
  declared,
  on,
  edge,
  t,
}: {
  row: Row;
  onResume: () => void;
  onRename: () => void;
  onOpen: () => void;
  /** The words declared with a colour, so a chip here matches a chip anywhere else. */
  declared?: readonly VocabWord[];
  on?: string;
  edge?: string;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const { conv, mark } = row;
  const tags = mark?.labels ?? [];
  const written = conv.writtenAt ? new Date(conv.writtenAt * 1000) : null;
  const stamp = written ? written.toLocaleString(undefined, WHEN) : null;
  return (
    <div
      className="group flex items-center gap-3 border-b border-border/60 px-1 py-1.5 text-sm hover:bg-muted/40"
      style={edge ? { borderLeft: `3px solid ${edge}`, paddingLeft: 6 } : undefined}
      data-testid={`agent-card-${conv.id}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <span
        className="min-w-0 flex-1 truncate"
        title={mark?.name ?? conv.ask ?? conv.project ?? conv.id}
      >
        {mark?.color && (
          <span
            className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
            style={{ background: mark.color }}
          />
        )}
        {mark?.name ?? conv.ask ?? conv.project ?? (
          <span className="text-muted-foreground">{t('agent.noProject')}</span>
        )}
      </span>
      {tags.length !== 0 && (
        <span className="hidden shrink-0 gap-1 sm:flex">
          {tags.map((l) => (
            <LabelChip key={l.toLowerCase()} label={l} small declared={declared} />
          ))}
        </span>
      )}
      {(on || (conv.ask && conv.project)) && (
        <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[14rem]">
          {[on, conv.ask ? conv.project : null].filter(Boolean).join(' · ')}
        </span>
      )}
      {stamp && (
        <span className="shrink-0 text-xs text-muted-foreground" title={written!.toString()}>
          {stamp}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(conv.id);
        }}
        title={t('agent.copyId', { id: conv.id })}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
        data-testid={`agent-copy-${conv.id}`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 4h10a2 2 0 012 2v10M6 8h10a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z"
          />
        </svg>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
        title={t('agent.rename')}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
        data-testid={`agent-rename-${conv.id}`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 7h-.01M3 7V4a1 1 0 011-1h3l10 10-4 4L3 7z"
          />
        </svg>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onResume();
        }}
        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
        data-testid={`agent-resume-${conv.id}`}
      >
        {t('agent.resume')}
      </button>
    </div>
  );
}
