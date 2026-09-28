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
import { Backend, type AgentIdentity } from '../utils/backend';
import type { AuthState } from '../utils/authMethod';

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
}

export function AuthSection({ value, onChange, isEdit, errors }: AuthSectionProps) {
  const { t } = useTranslation();
  const native = isNativeShell();
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
        </div>
      )}

      {/* Public key (file) */}
      {value.authType === 'publicKey' && (
        <div className="space-y-4">
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
            />
            {errors?.keyPath && <p className="mt-1 text-sm text-red-500">{errors.keyPath}</p>}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('connections.keyPassphrase')}</label>
            <div className="relative">
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={value.passphrase}
                onChange={(e) => set({ passphrase: e.target.value })}
                placeholder={t('connections.keyPassphrasePlaceholder')}
                className={`${INPUT_CLS} pr-10`}
              />
              <EyeButton shown={showPassphrase} onToggle={() => setShowPassphrase(!showPassphrase)} />
            </div>
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
