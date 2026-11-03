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

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { Dropdown } from './Dropdown';
import type { ConnectionInfo } from '../store/connectionsStore';
import type { RemoteCommandOutput, ServerMode } from '../utils/backend';
import { agentProbeCmd, parseAgentProbe } from '../utils/agentProbe';
import {
  SHIPPED_ADAPTERS,
  agentResumeCmd,
  shippedAdapter,
  type DiscoveredConversation,
  type ShippedAdapter,
} from '../utils/agentAdapters';
import { agentBlockedReason, agentVerdict } from '../utils/agentPolicy';
import { useLayouts } from '../store/layouts';
import { keepAnswer, readAnswers, type Answer } from '../store/agentAnswers';
import type { Mark } from '../store/layoutsFormat';
import { MACHINE_SWATCHES } from '../theme/swatches';
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
  /** Open a pane on this conversation. A null machine is this computer. */
  onResume: (
    machine: ConnectionInfo | null,
    adapter: ShippedAdapter,
    conv: DiscoveredConversation,
  ) => void;
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
  onResume,
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

  const marks = useLayouts((st) => st.marks);
  const setMark = useLayouts((st) => st.setMark);
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
      if (!q) return true;
      return [r.mark?.name, r.conv.ask, r.conv.project, r.conv.label, r.conv.id, r.adapter.name]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q));
    });
  }, [rows, query, since]);

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
      {renaming && (
        <RenameDialog
          row={renaming}
          onClose={() => setRenaming(null)}
          onSave={(name, color) => {
            // An empty name takes the mark away rather than writing a block that says
            // nothing — the same gesture as the Clear button, from the keyboard.
            // `renaming.on`, not the machine being looked at: under `@all` a row can come
            // from any of them, and a mark keyed to the wrong one would name a
            // conversation that machine does not hold.
            const key = { machine: renaming.on, tool: renaming.adapter.id, id: renaming.conv.id };
            void setMark(name ? { ...key, name, color } : { ...key, name: null });
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
            row={open1}
            on={nameOf(open1.on)}
            onClose={() => setOpen1(null)}
            onResume={() => resume(open1)}
            onRename={() => setRenaming(open1)}
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

/**
 * What is known about one conversation, beside the list rather than over it.
 *
 * The mock calls this the seam every later integration arrives through, and that is why
 * it exists before there is much to put in it. What it holds today is what a LISTING
 * gave: the question, where it runs, when it was last written, the handle and the exact
 * line that resumes it.
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
}: {
  row: Row;
  on: string;
  onClose: () => void;
  onResume: () => void;
  onRename: () => void;
}) {
  const { t } = useTranslation();
  const { conv, adapter, mark } = row;
  const written = conv.writtenAt ? new Date(conv.writtenAt * 1000) : null;
  const line = agentResumeCmd(adapter, conv.id);
  const fact = (label: string, value: React.ReactNode, mono = false) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</dd>
    </>
  );
  return (
    <aside
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-card p-4"
      data-testid="agent-detail"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium" data-testid="agent-detail-title">
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
        {mark?.name && conv.ask && fact(t('agent.detailAsked'), conv.ask)}
        {conv.project && fact(t('agent.detailProject'), conv.project, true)}
        {written && fact(t('agent.detailWritten'), written.toLocaleString())}
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
      </dl>

      {/* Read, never written. The vendor's files are not Rite's to change (ADR 0022 §6),
          and saying so where a person is looking at one is cheaper than a document. */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t('agent.detailRead')}</p>

      <div className="mt-auto flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onResume}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
          data-testid="agent-detail-resume"
        >
          {t('agent.resume')}
        </button>
        <button
          type="button"
          onClick={onRename}
          className="rounded-md border border-border px-2.5 py-1 text-xs"
          data-testid="agent-detail-rename"
        >
          {t('agent.rename')}
        </button>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(conv.id)}
          className="rounded-md border border-border px-2.5 py-1 text-xs"
          data-testid="agent-detail-copy-id"
        >
          {t('agent.detailCopyId')}
        </button>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(line)}
          className="rounded-md border border-border px-2.5 py-1 text-xs"
          data-testid="agent-detail-copy-cmd"
        >
          {t('agent.detailCopyCmd')}
        </button>
      </div>
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
  on,
  edge,
}: {
  row: Row;
  onResume: () => void;
  onRename: () => void;
  onOpen: () => void;
  /** The machine's name, when the list mixes machines. Absent on a single one. */
  on?: string;
  /** The machine's colour from the Library, when it has one. */
  edge?: string;
}) {
  const { t } = useTranslation();
  const { conv, mark } = row;
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
 * Naming someone else's conversation.
 *
 * A name and a colour, both this person's, over a session they did not create here. The
 * vendor's files are never touched (ADR 0022 §6): what is written is a `[[mark]]` in the
 * workspace document, which is the same support a layout rides — a file on this machine,
 * or a blob the account holds and the server cannot read.
 *
 * Clearing the name removes the mark entirely rather than leaving an empty one, so a
 * document never carries a block that says nothing.
 */
function RenameDialog({
  row,
  onClose,
  onSave,
}: {
  row: Row;
  onClose: () => void;
  onSave: (name: string, color?: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(row.mark?.name ?? '');
  const [color, setColor] = useState(row.mark?.color);
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
            if (e.key === 'Enter') onSave(name.trim(), color);
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
        <div className="mt-4 flex justify-end gap-2">
          {row.mark && (
            // Taking the name away is the other half of giving one, and it belongs on
            // this screen rather than in a document nobody edits by hand.
            <button
              type="button"
              onClick={() => onSave('', undefined)}
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
          >
            {t('agent.renameCancel')}
          </button>
          <button
            type="button"
            onClick={() => onSave(name.trim(), color)}
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

/** Every CLI at once: a heading per tool, its conversations in a grid under it. */
function Band({
  adapter,
  rows,
  folded,
  onFold,
  onResume,
  onRename,
  onOpen,
  nameOf,
  colorOf,
}: {
  adapter: ShippedAdapter;
  rows: Row[];
  folded: boolean;
  onFold: () => void;
  onResume: (row: Row) => void;
  onRename: (row: Row) => void;
  onOpen: (row: Row) => void;
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
          on={nameOf?.(r.on)}
          edge={colorOf(r.on)}
        />
      ))}
    </div>
  );
  return (
    <section data-testid={`agent-band-${adapter.id}`}>
      <button
        type="button"
        onClick={onFold}
        className="mb-2 flex w-full items-center gap-2 text-left"
        data-testid={`agent-fold-${adapter.id}`}
      >
        <span className="text-sm font-semibold">{adapter.name}</span>
        <span className="text-xs text-muted-foreground">{rows.length}</span>
        <span className="text-xs text-muted-foreground">· {t('agent.newestFirst')}</span>
      </button>
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
  nameOf,
  colorOf,
}: {
  bands: { adapter: ShippedAdapter; rows: Row[] }[];
  active: string | null;
  onPick: (id: string) => void;
  onResume: (row: Row) => void;
  onRename: (row: Row) => void;
  onOpen: (row: Row) => void;
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
        {(current?.rows ?? []).map((r) => (
          <RailRow
            key={`${r.on}:${r.adapter.id}:${r.conv.id}`}
            row={r}
            onResume={() => onResume(r)}
            onRename={() => onRename(r)}
            onOpen={() => onOpen(r)}
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
  on,
  edge,
  t,
}: {
  row: Row;
  onResume: () => void;
  onRename: () => void;
  onOpen: () => void;
  on?: string;
  edge?: string;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const { conv, mark } = row;
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
