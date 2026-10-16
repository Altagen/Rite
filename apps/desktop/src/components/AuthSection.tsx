/**
 * AuthSection — shared authentication controls for the connection forms.
 *
 * One source of truth for the New machine form AND Quick SSH, so they stay ISO
 * (this mirrors the design mock's shared auth section). Password and public-key
 * (file) are always offered; SSH agent is offered only in the native shell —
 * a browser can't reach $SSH_AUTH_SOCK.
 */
import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n/i18n';
import { isNativeShell } from '../utils/nativeShell';
import { useServerSession } from '../store/serverSessionStore';
import { Backend, type AgentIdentity } from '../utils/backend';
import type { AuthState } from '../utils/authMethod';
import type { RevealedSecret } from '../store/connectionsStore';

const INPUT_CLS =
  'w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none';

function EyeButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      title={shown ? t('connections.hidePassword') : t('connections.showPassword')}
    >
      {shown ? (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
        </svg>
      ) : (
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      )}
    </button>
  );
}

interface AuthSectionProps {
  value: AuthState;
  onChange: (next: AuthState) => void;
  /** Edit mode: password is optional (leave blank to keep the current one). */
  isEdit?: boolean;
  errors?: { password?: string; keyPath?: string };
  /**
   * Read this machine's stored secret back into the fields (ADR 0024 §5). Absent ⇒ no
   * reveal is offered: a machine being created has nothing to reveal, a viewer may use a
   * credential without extracting it, and an instance may turn it off for everyone.
   */
  onReveal?: () => Promise<RevealedSecret>;
}

export function AuthSection({ value, onChange, isEdit, errors, onReveal }: AuthSectionProps) {
  const { t } = useTranslation();
  const native = isNativeShell();
  // Where SSH will run decides what a key field can mean (ADR 0024 §2). On this machine's
  // own vault, a path: the key stays on disk and Rite keeps a reference, which is better
  // than a copy. Pointed at a server, SSH runs there — a path would name a file in its
  // container, which no member can put there — so the key travels with the record.
  const serverMode = useServerSession((st) => st.mode);
  const sshRunsHere = !serverMode?.accounts;
  const mayRemember = serverMode?.allowPassphraseStorage !== false;
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  // On a click and never on render: nothing stored is on screen until it is asked for.
  const doReveal = async (field: 'password' | 'passphrase') => {
    if (!onReveal) return;
    setRevealError(null);
    try {
      const secret = await onReveal();
      if (field === 'password') {
        set({ password: secret.password ?? '' });
        setShowPassword(true);
      } else {
        set({ passphrase: secret.passphrase ?? '', rememberPassphrase: !!secret.passphrase });
        setShowPassphrase(true);
      }
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : t('connections.revealFailed'));
    }
  };

  const RevealButton = ({ field }: { field: 'password' | 'passphrase' }) =>
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
  const set = (patch: Partial<AuthState>) => onChange({ ...value, ...patch });

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
      .then((list) => { if (!cancelled) setIdentities(list); })
      .catch(() => { if (!cancelled) setIdentities([]); });
    return () => { cancelled = true; };
  }, [value.authType, native]);

  return (
    <div className="space-y-4">
      {/* Authentication type */}
      <div>
        <label className="mb-2 block text-sm font-medium">{t('connections.authMethod')}</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={value.authType === 'password'} onChange={() => set({ authType: 'password' })} />
            <span className="text-sm">{t('connections.authPassword')}</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={value.authType === 'publicKey'} onChange={() => set({ authType: 'publicKey' })} />
            <span className="text-sm">{t('connections.authPublicKey')}</span>
          </label>
          {native && (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="radio" checked={value.authType === 'agent'} onChange={() => set({ authType: 'agent' })} />
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
            <EyeButton shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
          {errors?.password && <p className="mt-1 text-sm text-red-500">{errors.password}</p>}
          {isEdit && <p className="mt-1 text-sm text-muted-foreground">Leave empty to keep current password</p>}
          <RevealButton field="password" />
          {revealError && (
            <p className="mt-1 text-sm text-amber-500" data-testid="auth-reveal-error">
              {revealError}
            </p>
          )}
        </div>
      )}

      {/* Public key — a file on this machine, or the key itself (ADR 0024 §2) */}
      {value.authType === 'publicKey' && (
        <div className="space-y-4">
          {sshRunsHere ? (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('connections.keyPath')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={value.keyPath}
                onChange={(e) => set({ keyPath: e.target.value })}
                placeholder={t('connections.keyPathPlaceholder')}
                className={INPUT_CLS}
                data-testid="auth-key-path"
              />
              {errors?.keyPath && <p className="mt-1 text-sm text-red-500">{errors.keyPath}</p>}
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('connections.keyFile')} <span className="text-red-500">*</span>
              </label>
              <input
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) readKeyFile(file);
                }}
                className={`${INPUT_CLS} file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1 file:text-foreground`}
                data-testid="auth-key-file"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                {value.key
                  ? t('connections.keyFileLoaded', { name: value.keyName || t('connections.keyFileUnnamed') })
                  : t('connections.keyFileHint')}
              </p>
              {keyError && (
                <p className="mt-1 text-sm text-red-500" data-testid="auth-key-error">
                  {keyError}
                </p>
              )}
              {errors?.keyPath && !value.key && <p className="mt-1 text-sm text-red-500">{errors.keyPath}</p>}
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">{t('connections.keyPassphrase')}</label>
            <div className="relative">
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={value.passphrase}
                onChange={(e) => set({ passphrase: e.target.value })}
                placeholder={t('connections.keyPassphrasePlaceholder')}
                className={`${INPUT_CLS} pr-10`}
                data-testid="auth-passphrase"
              />
              <EyeButton shown={showPassphrase} onToggle={() => setShowPassphrase(!showPassphrase)} />
            </div>
            <RevealButton field="passphrase" />
            {revealError && (
              <p className="mt-1 text-sm text-amber-500" data-testid="auth-reveal-error">
                {revealError}
              </p>
            )}
            {/* Unchecked by default, and gone where the instance says so. A passphrase kept
                beside the key it protects is no longer a second barrier — so the row says
                what it does instead of implying one. */}
            {mayRemember ? (
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.rememberPassphrase}
                  onChange={(e) => set({ rememberPassphrase: e.target.checked })}
                  data-testid="auth-remember-passphrase"
                />
                <span>
                  {t('connections.keyRemember')}
                  <span className="block text-muted-foreground">{t('connections.keyRememberWhy')}</span>
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
              <p className="mb-1 text-sm font-medium text-foreground">⚠︎ {t('connections.authAgentNone')}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('connections.authAgentNoneHint')}</p>
            </div>
          ) : (
            <>
              {/* Identity picker — pin one or offer all */}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('connections.authAgentIdentity')}</label>
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
                <p className="mt-1.5 text-xs text-muted-foreground">{t('connections.authAgentIdentityHint')}</p>
              </div>

              {/* Detected identities + security rationale */}
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="mb-2 text-sm font-medium text-foreground">
                  ✓ {identities.length} {identities.length > 1 ? t('connections.authAgentIdentitiesN') : t('connections.authAgentIdentity1')}
                </p>
                <ul className="space-y-1.5">
                  {identities.map((id) => (
                    <li key={id.fingerprint} className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-foreground">{id.name}</span>
                      <span className="font-mono text-muted-foreground">{id.fingerprint}</span>
                      <span
                        className={`ml-auto flex-none rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          id.hardware ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {id.hardware ? 'hardware · FIDO' : id.algo}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t('connections.authAgentNote')}</p>
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
                  <span className="mt-0.5 block text-xs text-muted-foreground">⚠ {t('connections.authAgentForwardHint')}</span>
                </span>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
