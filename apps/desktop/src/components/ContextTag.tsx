/**
 * The small context chrome the mock puts on every vault/server row
 * (`design/mock/desktop.html` — `.tag locked|unlocked|server`, `.badge`, `.curtag`).
 *
 * A vault is "open" only where we can know it: the window you are looking at. Any
 * other vault in the roster reads "locked", which is the truth in the ordinary
 * one-window case — a vault with no window has no running server, so its master
 * key is nowhere in memory. A server is neither: it is labelled for what it is.
 */

export type ContextTagState = 'locked' | 'open' | 'server';

const LABEL: Record<ContextTagState, string> = {
  locked: 'Locked',
  open: 'Open',
  server: 'Server',
};

export function ContextTag({ state }: { state: ContextTagState }) {
  return (
    <span className={`m-tag m-tag-${state} flex-none text-[11px] normal-case tracking-[0.02em]`}>
      {LABEL[state]}
    </span>
  );
}

/** The same three states as the coloured disc the context pill wears. */
export function ContextDot({ state }: { state: ContextTagState }) {
  return <span className={`m-dot m-dot-${state}`} aria-hidden />;
}

/** "● current" beside the name of the context this window already holds. */
export function CurrentMark() {
  return <span className="ml-1 flex-none text-[10px] font-bold text-primary">● current</span>;
}

/** The mock's five badge gradients, picked from the name so a vault keeps its colour. */
const BADGES = [
  'linear-gradient(135deg,#9ece6a,#5aa457)',
  'linear-gradient(135deg,#7c9cf5,#5b7fe0)',
  'linear-gradient(135deg,#e5b567,#c98f3a)',
  'linear-gradient(135deg,#bb9af7,#8a63e8)',
  'linear-gradient(135deg,#56c7c0,#2f9a93)',
];

/**
 * A context's avatar: the device-local image or emoji it was given (ADR 0014), else
 * a gradient square with its initial — the mock's default, which tells two vaults
 * apart at a glance where one generic glyph for all of them would not.
 */
export function ContextBadge({
  icon,
  name,
  small,
}: {
  icon?: string;
  name: string;
  /** The context menu's denser 28px badge (the mock shrinks it there). */
  small?: boolean;
}) {
  const base = small
    ? 'grid h-7 w-7 flex-none place-items-center rounded-lg'
    : 'grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px]';
  if (icon?.startsWith('data:')) {
    return <img src={icon} alt="" className={`${base} object-cover`} />;
  }
  if (icon) {
    return (
      <span className={`${base} ${small ? 'text-base' : 'text-lg'} leading-none`} aria-hidden>
        {icon}
      </span>
    );
  }
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className={`${base} ${small ? 'text-xs' : 'text-sm'} font-bold text-[#0a0e1a]`}
      style={{ backgroundImage: BADGES[hash % BADGES.length] }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
