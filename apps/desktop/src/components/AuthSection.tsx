/**
 * AuthSection — shared authentication controls for the connection forms.
 *
 * One source of truth for the New machine form AND Quick SSH, so they stay ISO.
 *
 * Password and key are always offered; the SSH agent only in the native shell, which is
 * the only place `$SSH_AUTH_SOCK` exists. A key is two different things and the member
 * chooses which in a server context (ADR 0028): carried in the record, or named on disk.
 */
import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import { RevealToggle } from './RevealToggle';
import { useTranslation } from '../i18n/i18n';
import { isNativeShell, pickNativeFile } from '../utils/nativeShell';
import { useServerSession } from '../store/serverSessionStore';
import { Backend, type AgentIdentity } from '../utils/backend';
import type { AuthState } from '../utils/authMethod';
import type { RevealedSecret } from '../store/connectionsStore';

const INPUT_CLS =
  'w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none';

interface AuthSectionProps {
  value: AuthState;
  onChange: Dispatch<SetStateAction<AuthState>>;
  /** Edit mode: password is optional (leave blank to keep the current one). */
  isEdit?: boolean;
  errors?: { password?: string; keyPath?: string };
  /**
   * Read this machine's stored secret back into the fields (ADR 0024 §5). Absent ⇒ no
   * reveal is offered: a machine being created has nothing to reveal, a viewer may use a
   * credential without extracting it, and an instance may turn it off for everyone.
   */
  onReveal?: () => Promise<RevealedSecret>;
  /**
   * A key passphrase is already stored for this machine. The field stays empty — a secret
   * is not re-displayed without being asked for — so the row has to SAY one is there, or
   * an empty box beside a ticked "remember this passphrase" reads as a contradiction.
   */
  hasStoredPassphrase?: boolean;
  /**
   * An SSH password is already stored for this machine. Same reason as above: the field
   * stays empty, so the row has to say one is there.
   */
  hasStoredPassword?: boolean;
  /**
   * Which key this machine already carries (ADR 0028 §6). A file input cannot be
   * prefilled, so without this the row showed "no file chosen" on a machine whose key is
   * stored — which reads as *nothing was saved*. Null where the key's format does not
   * publish its public half; absent on a machine being created.
   */
  storedKey?: { fingerprint: string | null; algorithm: string | null } | null;
}

export function AuthSection({
  value,
  onChange,
  isEdit,
  errors,
  onReveal,
  hasStoredPassphrase,
  hasStoredPassword,
  storedKey,
}: AuthSectionProps) {
  const { t } = useTranslation();
  const native = isNativeShell();
  // A key means one of two things, and in a server context the member chooses which
  // (ADR 0028 §1): carried in the record, so every member of the collection can open the
  // machine, or named on disk, so only a member who has that file can. A local vault has no
  // collection and no account to seal to, so there it is a path and there is no choice.
  const serverMode = useServerSession((st) => st.mode);
  const inVault = !serverMode?.accounts;
  // One policy over every secret a record can keep (ADR 0024 §4): the SSH password, the
  // key passphrase, a carried key. It binds this form and not the data — the record is
  // sealed here before it leaves, so no instance can check it afterwards.
  const mayRemember = serverMode?.allowSecretStorage !== false;
  // A carried key IS a stored secret (ADR 0024 §4 names it), and this form is where that
  // policy is enforced: the record is sealed before it leaves, so the server cannot check
  // it afterwards. Off ⇒ the carried support is not offered, which makes key auth on this
  // instance a desktop matter (ADR 0028 §5).
  const mayCarry = mayRemember;
  const support = inVault ? 'path' : mayCarry ? value.keySupport : 'path';
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  // On a click and never on render: nothing stored is on screen until it is asked for.
  const doReveal = async (field: 'password' | 'passphrase') => {
    if (!onReveal) return;
    setRevealError(null);
    try {
      const secret = await onReveal();
      if (field === 'password') {
        // `rememberPassword` follows what came back, as the passphrase branch does: a
        // revealed secret exists, so the box that says whether Rite keeps it must agree.
        set({ password: secret.password ?? '', rememberPassword: !!secret.password });
        setShowPassword(true);
      } else {
        set({ passphrase: secret.passphrase ?? '', rememberPassphrase: !!secret.passphrase });
        setShowPassphrase(true);
      }
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : t('connections.revealFailed'));
    }
  };

  // A function, not a component: a component declared inside a render gets a new identity
  // on every render, so React tears the button down and rebuilds it for nothing.
  const revealButton = (field: 'password' | 'passphrase') =>
    onReveal ? (
      <button
        type="button"
        onClick={() => void doReveal(field)}
        className="mt-1 text-sm text-primary hover:underline"
        data-testid={`auth-reveal-${field}`}
      >
        {t('connections.reveal')}
      </button>
    ) : null;

  // Read in the page and nowhere else: there is no upload endpoint for a private key, and
  // there is not going to be one — an endpoint that accepts a key is one that has held it.
  const readKeyFile = (file: File) => {
    setKeyError(null);
    const reader = new FileReader();
    reader.onerror = () => setKeyError(t('connections.keyUnreadable'));
    reader.onload = () => {
      const text = String(reader.result ?? '');
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        // The public half is the file people reach for first, and it fails much later —
        // at authentication, as "permission denied", with nothing naming the cause.
        setKeyError(t('connections.keyLooksPublic'));
        return;
      }
      set({ key: text, keyName: file.name });
    };
    reader.readAsText(file);
  };
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  // Replacing a stored key is asked for, not offered: the picker is what wipes it.
  const [replacingKey, setReplacingKey] = useState(false);
  const keyAlreadyStored = !!storedKey && value.keySupport === 'carried';
  const showStoredKey = keyAlreadyStored && !replacingKey && !value.key;
  /**
   * Patch the auth state from the LATEST value, not the one this render captured.
   *
   * `readKeyFile` finishes asynchronously, and its callback used to spread the `value`
   * frozen when the file was chosen — so a passphrase typed in the meantime was wiped by
   * the read completing. Silently: the field emptied, the machine saved without one, and
   * the next connection failed with "The key is encrypted" and nothing to explain it.
   * Updating through the setter means the owner merges onto its newest state, so a late
   * callback cannot undo what was typed after it.
   */
  const set = (patch: Partial<AuthState>) => onChange((prev) => ({ ...prev, ...patch }));

  // The context can take the choice away, and the state has to carry that: `support` above
  // is the decision, while the forms validate and submit `value.keySupport`. Left to
  // diverge, a local vault rendered the path field over a state that still said "carried",
  // so a typed path was answered with "choose the private key file" — a file input that was
  // never on screen — and the path was dropped on submit.
  useEffect(() => {
    if (value.keySupport !== support) onChange((prev) => ({ ...prev, keySupport: support }));
  }, [support, value.keySupport, onChange]);

  // Live SSH-agent identities (native only). `null` = still querying; an empty
  // list = no agent / no keys (a normal, graceful state — not an error).
  const [identities, setIdentities] = useState<AgentIdentity[] | null>(null);
  useEffect(() => {
    if (value.authType !== 'agent' || !native) return;
    let cancelled = false;
    // Reset to the "checking" state, then query the agent — this fetch-on-switch
    // is exactly the effect's job.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setIdentities(null);
    Backend.Terminal.listAgentIdentities()
      .then((list) => {
        if (!cancelled) setIdentities(list);
      })
      .catch(() => {
        if (!cancelled) setIdentities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [value.authType, native]);

  return (
    <div className="space-y-4">
      {/* Authentication type */}
      <div>
        <label className="mb-2 block text-sm font-medium">{t('connections.authMethod')}</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              checked={value.authType === 'password'}
              onChange={() => set({ authType: 'password' })}
            />
            <span className="text-sm">{t('connections.authPassword')}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              checked={value.authType === 'publicKey'}
              onChange={() => set({ authType: 'publicKey' })}
            />
            <span className="text-sm">{t('connections.authPublicKey')}</span>
          </label>
          {native && (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                checked={value.authType === 'agent'}
                onChange={() => set({ authType: 'agent' })}
              />
              <span className="text-sm">{t('connections.authAgent')}</span>
            </label>
          )}
        </div>
      </div>

      {/* Password */}
      {value.authType === 'password' && (
        <div>
          <label className="mb-1 block text-sm font-medium">
            {t('connections.password')} {!isEdit && <span className="text-red-500">*</span>}
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={value.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder={isEdit ? '••••••••' : t('connections.passwordPlaceholder')}
              className={`${INPUT_CLS} pr-10`}
            />
            <RevealToggle shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
          {errors?.password && <p className="mt-1 text-sm text-red-500">{errors.password}</p>}
          {isEdit && (
            <p className="mt-1 text-sm text-muted-foreground">
              {hasStoredPassword
                ? t('connections.passwordStored')
                : t('connections.passwordLeaveEmpty')}
            </p>
          )}
          {revealButton('password')}
          {revealError && (
            <p className="mt-1 text-sm text-amber-500" data-testid="auth-reveal-error">
              {revealError}
            </p>
          )}
          {/* The passphrase row's twin, and unticked for the same reason. Where the
              instance forbids a stored secret the choice is gone and the password is
              asked for at every connection instead. */}
          {mayRemember ? (
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm leading-5">
              <input
                type="checkbox"
                checked={value.rememberPassword}
                onChange={(e) => set({ rememberPassword: e.target.checked })}
                data-testid="auth-remember-password"
                className="mt-0.5 flex-none"
              />
              <span>
                {t('connections.passwordRemember')}
                <span className="block text-muted-foreground">
                  {hasStoredPassword
                    ? t('connections.passwordRememberForget')
                    : t('connections.passwordRememberWhy')}
                </span>
              </span>
            </label>
          ) : (
            <p className="mt-2 text-sm" data-testid="auth-remember-password-forbidden">
              <span className="text-amber-500">{t('connections.passwordRememberOff')}</span>
              {t('connections.passwordRememberOffWhy')}
            </p>
          )}
        </div>
      )}

      {/* A key: carried in the record, or standing on the machine (ADR 0028) */}
      {value.authType === 'publicKey' && (
        <div className="space-y-4">
          {/* The choice itself, where there is one. Two radios rather than a checkbox: they
              are not a setting and its absence, they are two different answers to "who may
              open this machine", and the text under each has to say which. */}
          {!inVault && mayCarry && (
            <div className="space-y-2" data-testid="key-support">
              {(['carried', 'path'] as const).map((option) => (
                <label
                  key={option}
                  className="flex cursor-pointer items-start gap-2 text-sm leading-5"
                >
                  <input
                    type="radio"
                    name="key-support"
                    checked={value.keySupport === option}
                    onChange={() => set({ keySupport: option })}
                    data-testid={`key-support-${option}`}
                    className="mt-0.5 flex-none"
                  />
                  <span>
                    {t(option === 'carried' ? 'connections.keyCarried' : 'connections.keyOnDisk')}
                    <span className="block text-muted-foreground">
                      {t(
                        option === 'carried'
                          ? 'connections.keyCarriedWhy'
                          : 'connections.keyOnDiskWhy',
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {/* Forbidden rather than chosen: the instance keeps no secret in a record, so the
              only key support left is a path — and that makes this machine desktop-only. */}
          {!inVault && !mayCarry && (
            <p className="text-sm text-muted-foreground" data-testid="key-carry-forbidden">
              {t('connections.keyCarryForbidden')}
            </p>
          )}
          {support === 'path' ? (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('connections.keyPath')} <span className="text-red-500">*</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={value.keyPath}
                  onChange={(e) => set({ keyPath: e.target.value })}
                  placeholder={t('connections.keyPathPlaceholder')}
                  className={INPUT_CLS}
                  data-testid="auth-key-path"
                />
                {/* Only where a chooser can answer with a PATH. A browser file input hands
                    over the contents and never the path, so in the web build the field is
                    typed — and a button that could not fill it would be a lie. */}
                {native && (
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await pickNativeFile(t('connections.keyPathDialog'));
                      if (picked) set({ keyPath: picked });
                    }}
                    className="flex-none rounded border border-border px-3 py-2 text-sm hover:bg-muted"
                    data-testid="auth-key-browse"
                  >
                    {t('connections.keyPathBrowse')}
                  </button>
                )}
              </div>
              {errors?.keyPath && <p className="mt-1 text-sm text-red-500">{errors.keyPath}</p>}
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('connections.keyFile')}
                {!keyAlreadyStored && <span className="text-red-500"> *</span>}
              </label>
              {/* A stored key names itself instead of showing an empty picker, which read as
                  "nothing was saved" (ADR 0028 §6). The picker comes back on Replace: the
                  key is not re-chosen by accident, and an edit that touches nothing else
                  keeps it. */}
              {showStoredKey ? (
                <div
                  className="flex flex-wrap items-center gap-2 rounded border border-border bg-input px-3 py-2"
                  data-testid="auth-key-stored"
                >
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">
                    {storedKey?.fingerprint ?? t('connections.keyStoredUnnamed')}
                  </code>
                  {storedKey?.algorithm && (
                    <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {storedKey.algorithm}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setReplacingKey(true)}
                    className="flex-none text-sm text-primary hover:underline"
                    data-testid="auth-key-replace"
                  >
                    {t('connections.keyReplace')}
                  </button>
                </div>
              ) : (
                <input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readKeyFile(file);
                  }}
                  className={`${INPUT_CLS} file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1 file:text-foreground`}
                  data-testid="auth-key-file"
                />
              )}
              <p className="mt-1 text-sm text-muted-foreground">
                {value.key
                  ? t('connections.keyFileLoaded', {
                      name: value.keyName || t('connections.keyFileUnnamed'),
                    })
                  : showStoredKey
                    ? t('connections.keyStoredWhy')
                    : t('connections.keyFileHint')}
              </p>
              {keyError && (
                <p className="mt-1 text-sm text-red-500" data-testid="auth-key-error">
                  {keyError}
                </p>
              )}
              {errors?.keyPath && !value.key && (
                <p className="mt-1 text-sm text-red-500">{errors.keyPath}</p>
              )}
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('connections.keyPassphrase')}
            </label>
            <div className="relative">
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={value.passphrase}
                onChange={(e) => set({ passphrase: e.target.value })}
                // The same dots the password field shows when one is stored: an empty box
                // with a neutral hint cannot tell "nothing is kept" from "something is".
                placeholder={
                  hasStoredPassphrase && !value.passphrase
                    ? '••••••••'
                    : t('connections.keyPassphrasePlaceholder')
                }
                className={`${INPUT_CLS} pr-10`}
                data-testid="auth-passphrase"
              />
              <RevealToggle
                shown={showPassphrase}
                onToggle={() => setShowPassphrase(!showPassphrase)}
              />
            </div>
            {hasStoredPassphrase && (
              <p
                className="mt-1 text-sm text-muted-foreground"
                data-testid="auth-passphrase-stored"
              >
                {t('connections.keyPassphraseStored')}
              </p>
            )}
            {revealButton('passphrase')}
            {revealError && (
              <p className="mt-1 text-sm text-amber-500" data-testid="auth-reveal-error">
                {revealError}
              </p>
            )}
            {/* Unchecked by default, and gone where the instance says so. A passphrase kept
                beside the key it protects is no longer a second barrier — so the row says
                what it does instead of implying one. */}
            {mayRemember ? (
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm leading-5">
                {/* `items-start` aligns the box with the top of a two-line label, which
                    leaves it sitting above the first line's text: the box is 1rem and the
                    line is 1.25rem. Half the difference puts it on the line, and
                    `flex-none` keeps it square when the label wraps. */}
                <input
                  type="checkbox"
                  checked={value.rememberPassphrase}
                  onChange={(e) => set({ rememberPassphrase: e.target.checked })}
                  data-testid="auth-remember-passphrase"
                  className="mt-0.5 flex-none"
                />
                <span>
                  {t('connections.keyRemember')}
                  <span className="block text-muted-foreground">
                    {hasStoredPassphrase
                      ? t('connections.keyRememberForget')
                      : t('connections.keyRememberWhy')}
                  </span>
                </span>
              </label>
            ) : (
              <p className="mt-2 text-sm" data-testid="auth-remember-forbidden">
                <span className="text-amber-500">{t('connections.keyRememberOff')}</span>
                {t('connections.keyRememberOffWhy')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* SSH agent (native only) */}
      {value.authType === 'agent' && native && (
        <div className="space-y-3">
          {identities === null ? (
            <p className="text-sm text-muted-foreground">{t('connections.authAgentChecking')}</p>
          ) : identities.length === 0 ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="mb-1 text-sm font-medium text-foreground">
                ⚠︎ {t('connections.authAgentNone')}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('connections.authAgentNoneHint')}
              </p>
            </div>
          ) : (
            <>
              {/* Identity picker — pin one or offer all */}
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {t('connections.authAgentIdentity')}
                </label>
                <select
                  value={value.agentIdentity}
                  onChange={(e) => set({ agentIdentity: e.target.value })}
                  className={INPUT_CLS}
                >
                  <option value="">{t('connections.authAgentOfferAll')}</option>
                  {identities.map((id) => (
                    <option key={id.fingerprint} value={id.fingerprint}>
                      {id.name} · {id.hardware ? 'hardware · FIDO' : id.algo}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t('connections.authAgentIdentityHint')}
                </p>
              </div>

              {/* Detected identities + security rationale */}
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="mb-2 text-sm font-medium text-foreground">
                  ✓ {identities.length}{' '}
                  {identities.length > 1
                    ? t('connections.authAgentIdentitiesN')
                    : t('connections.authAgentIdentity1')}
                </p>
                <ul className="space-y-1.5">
                  {identities.map((id) => (
                    <li key={id.fingerprint} className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">{id.name}</span>
                      <span className="font-mono text-muted-foreground">{id.fingerprint}</span>
                      <span
                        className={`ml-auto flex-none rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          id.hardware
                            ? 'bg-primary/20 text-primary'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {id.hardware ? 'hardware · FIDO' : id.algo}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t('connections.authAgentNote')}
                </p>
              </div>

              {/* Agent forwarding (opt-in) */}
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={value.agentForward}
                  onChange={(e) => set({ agentForward: e.target.checked })}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">{t('connections.authAgentForward')}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    ⚠ {t('connections.authAgentForwardHint')}
                  </span>
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
