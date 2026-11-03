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
import { agentProbeCmd, parseAgentProbe, type ProbedTool } from '../utils/agentProbe';
import {
  SHIPPED_ADAPTERS,
  shippedAdapter,
  type DiscoveredConversation,
  type ShippedAdapter,
} from '../utils/agentAdapters';
import { agentBlockedReason, agentVerdict } from '../utils/agentPolicy';
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

/** One machine's answer, with when it was read. */
interface Answer {
  at: number;
  tools: ProbedTool[];
}

/** A conversation plus the adapter that reported it — what a row needs. */
interface Row {
  adapter: ShippedAdapter;
  conv: DiscoveredConversation;
}

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
  // Per machine, so switching back does not throw away an answer that cost a round trip.
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'stacked' | 'rail'>('stacked');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [railTool, setRailTool] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);

  const native = isNativeShell();
  const onLocal = machineId === LOCAL;
  const machine = connections.find((c) => c.id === machineId) ?? null;
  /** What the screen calls the thing being looked at: a name, or this computer. */
  const where = onLocal ? t('agent.thisMachine') : (machine?.name ?? '');
  const picked = onLocal || !!machine;
  const answer = machineId ? answers[machineId] : undefined;
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
      setAnswers((prev) => ({
        ...prev,
        [machineId]: { at: Date.now(), tools: parseAgentProbe(out.stdout, SHIPPED_ADAPTERS) },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [machineId, onLocal, machine, probeAgents]);

  /** Every conversation the answer holds, in the order each tool reported. */
  const rows: Row[] = useMemo(() => {
    if (!answer) return [];
    const out: Row[] = [];
    for (const tool of answer.tools) {
      const adapter = shippedAdapter(tool.id);
      if (!adapter || !tool.lines) continue;
      for (const conv of adapter.parse(tool.lines)) out.push({ adapter, conv });
    }
    return out;
  }, [answer]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.conv.project, r.conv.label, r.conv.id, r.adapter.name]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    );
  }, [rows, query]);

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
    ...(native ? [{ value: LOCAL, label: t('agent.thisMachine') }] : []),
    ...connections.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" data-testid="agent-manager">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t('agent.title')}</div>
          <div className="truncate text-xs text-muted-foreground" data-testid="agent-subtitle">
            {picked
              ? answer
                ? t(rows.length === 1 ? 'agent.countOne' : 'agent.count', {
                    count: String(rows.length),
                    machine: where,
                  })
                : t('agent.notProbed', { machine: where })
              : t('agent.pickFirst')}
          </div>
        </div>
        <span className="flex-1" />
        {rows.length > 0 && (
          <input
            className="h-8 w-56 rounded-md border border-border bg-card px-2 text-sm"
            placeholder={t('agent.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="agent-search"
          />
        )}
        {rows.length > 0 && (
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
        )}
        <Dropdown
          value={machineId ?? ''}
          options={machineOptions}
          onChange={(v) => onPickMachine(v === '' ? null : v)}
          label={t('agent.pickMachine')}
          testId="agent-machine"
        />
        <button
          type="button"
          onClick={() => setToolsOpen((v) => !v)}
          className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
          data-testid="agent-tools-toggle"
        >
          {t('agent.tools')}
        </button>
        {picked && !blocked && (
          <button
            type="button"
            onClick={() => void probe()}
            disabled={busy || !probeAgents}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            data-testid="agent-probe"
          >
            {busy ? t('agent.probing') : t('agent.probe', { machine: where })}
          </button>
        )}
      </header>

      {toolsOpen && <ToolsPanel />}

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
        ) : !answer ? (
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
                body={t('agent.readAt', { when: new Date(answer.at).toLocaleTimeString() })}
              />
            ) : shown.length === 0 ? (
              <Note testId="agent-no-match" title={t('agent.noMatch', { query })} body="" />
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
                  onResume={(r) => onResume(machine, r.adapter, r.conv)}
                />
              ))
            ) : (
              <Rail
                bands={bands}
                active={railTool ?? bands[0]?.adapter.id ?? null}
                onPick={setRailTool}
                onResume={(r) => onResume(machine, r.adapter, r.conv)}
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
              <p className="font-mono text-xs text-muted-foreground" data-testid="agent-not-looked">
                {t('agent.notLookedFor', { tools: notLookedFor.join(', ') })}
              </p>
            )}
          </div>
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
function Card({ row, onResume }: { row: Row; onResume: () => void }) {
  const { t } = useTranslation();
  const { conv } = row;
  const written = conv.writtenAt ? new Date(conv.writtenAt * 1000) : null;
  const stamp = written ? written.toLocaleString(undefined, WHEN) : null;
  const headline = conv.project ?? stamp ?? conv.label ?? null;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      data-testid={`agent-card-${conv.id}`}
    >
      <div
        className="truncate text-sm font-medium"
        title={[conv.project, conv.label && t('agent.started', { when: conv.label })]
          .filter(Boolean)
          .join(' · ')}
      >
        {headline ?? <span className="text-muted-foreground">{t('agent.noProject')}</span>}
      </div>
      {/* Under a project rather than replacing it, so a card never has to choose between
          the two — and absent when the host's `stat` answered neither syntax, rather
          than showing a time nobody measured. */}
      {stamp && conv.project && (
        <div className="truncate text-[11px] text-muted-foreground" title={written!.toString()}>
          {stamp}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {conv.id}
        </span>
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(conv.id)}
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
          onClick={onResume}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted"
          data-testid={`agent-resume-${conv.id}`}
        >
          {t('agent.resume')}
        </button>
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
}: {
  adapter: ShippedAdapter;
  rows: Row[];
  folded: boolean;
  onFold: () => void;
  onResume: (row: Row) => void;
}) {
  const { t } = useTranslation();
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
          {rows.map((r) => (
            <Card key={`${r.adapter.id}:${r.conv.id}`} row={r} onResume={() => onResume(r)} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One CLI at a time, chosen from a rail.
 *
 * The argument for it, from the mock: a list holds more rows per screen than cards do,
 * and forty conversations is a long wall of cards and a short scroll in a sidebar.
 */
function Rail({
  bands,
  active,
  onPick,
  onResume,
}: {
  bands: { adapter: ShippedAdapter; rows: Row[] }[];
  active: string | null;
  onPick: (id: string) => void;
  onResume: (row: Row) => void;
}) {
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
      <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(230px,1fr))] content-start gap-2">
        {(current?.rows ?? []).map((r) => (
          <Card key={`${r.adapter.id}:${r.conv.id}`} row={r} onResume={() => onResume(r)} />
        ))}
      </div>
    </div>
  );
}
