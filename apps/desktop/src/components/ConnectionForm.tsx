/**
 * Connection Form Component
 *
 * Form for creating and editing SSH/SFTP connections
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../i18n/i18n';
import { type CreateConnectionInput, type UpdateConnectionInput, type ConnectionInfo, type Protocol } from '../store/connectionsStore';
import type { QuickSSHConnectionInfo } from './QuickSSHModal';
import { AuthSection } from './AuthSection';
import { makeAuthState, toAuthMethodInput, type AuthState } from '../utils/authMethod';

interface ConnectionFormProps {
  connection?: ConnectionInfo | null;
  prefillData?: QuickSSHConnectionInfo | null;
  onClose: () => void;
  onSuccess?: () => void;
  // The active context's connection source (ADR 0014): local = the store; accounts
  // = browser-crypto over the per-user vault. The form is context-agnostic.
  create: (input: CreateConnectionInput) => Promise<void>;
  update: (input: UpdateConnectionInput) => Promise<void>;
  // ADR 0016: shared collections the caller may save into (owner/editor). When
  // present (accounts context), the form offers a "save to collection" target.
  collectionTargets?: { id: string; name: string }[];
  // Preselect this collection as the save target (e.g. opening the form from a
  // collection view). Only applies when creating.
  defaultCollectionId?: string | null;
  // Preselect this sub-folder path (e.g. opening the form from a folder's ＋).
  defaultFolder?: string | null;
}

const MACHINE_COLORS = ['#7c9cf5', '#9ece6a', '#e5b567', '#f0a35e', '#f7768e', '#bb9af7', '#56c7c0', '#8b93a7'];

export function ConnectionForm({
  connection,
  prefillData,
  onClose,
  onSuccess,
  create,
  update,
  collectionTargets,
  defaultCollectionId,
  defaultFolder,
}: ConnectionFormProps) {
  const { t } = useTranslation();

  // Form state - use prefillData if provided, otherwise use connection data
  const [name, setName] = useState(connection?.name || (prefillData ? `${prefillData.username}@${prefillData.host}` : ''));
  const [protocol, setProtocol] = useState<Protocol>((connection?.protocol as Protocol) || 'SSH');
  const [hostname, setHostname] = useState(connection?.hostname || prefillData?.host || '');
  const [port, setPort] = useState(connection?.port || prefillData?.port || 22);
  const [username, setUsername] = useState(connection?.username || prefillData?.username || '');
  // Authentication state — shared shape with Quick SSH via <AuthSection>.
  const [auth, setAuth] = useState<AuthState>(
    makeAuthState({
      authType: prefillData?.authType ?? 'password',
      password: prefillData?.password ?? '',
      keyPath: prefillData?.keyPath ?? '',
      passphrase: prefillData?.passphrase ?? '',
    }),
  );
  const [folder, setFolder] = useState(connection?.folder || defaultFolder || '');
  // ADR 0016 save target (accounts context): a collection id. "Personal" (the
  // vault-backed collection) is always the first target, the default.
  const [collectionTargetId, setCollectionTargetId] = useState<string>(
    connection?.collectionId ?? defaultCollectionId ?? collectionTargets?.[0]?.id ?? '',
  );
  const [color, setColor] = useState(connection?.color || '');
  const icon = connection?.icon || ''; // TODO: Implement icon picker UI
  // Health-check opt-out (ADR 0017): false ⇒ never actively probe this machine.
  const [hcOptOut, setHcOptOut] = useState(connection?.hc === false);
  const [notes, setNotes] = useState(connection?.notes || '');
  const [sshKeepAliveOverride, setSshKeepAliveOverride] = useState<string | null>(
    connection?.sshKeepAliveOverride ?? null
  );
  const [sshKeepAliveInterval, setSshKeepAliveInterval] = useState<number | null>(
    connection?.sshKeepAliveInterval ?? null
  );

  // Dropdown state for keep-alive
  const [selectedKeepAlive, setSelectedKeepAlive] = useState<number | 'disabled'>('disabled');
  const [customKeepAlive, setCustomKeepAlive] = useState<string>('');
  const [showKeepAliveDropdown, setShowKeepAliveDropdown] = useState(false);
  const keepAliveDropdownRef = useRef<HTMLDivElement>(null);

  // UI state
  const [showProtocolDropdown, setShowProtocolDropdown] = useState(false);
  const protocolDropdownRef = useRef<HTMLDivElement>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize keep-alive dropdown based on connection settings
  useEffect(() => {
    // Sync the keep-alive dropdown from the connection being edited; these
    // setState calls intentionally run only when the connection changes.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (connection) {
      if (sshKeepAliveOverride === null || sshKeepAliveOverride === 'disabled') {
        // No override or disabled
        setSelectedKeepAlive('disabled');
      } else if (sshKeepAliveOverride === 'enabled') {
        if (sshKeepAliveInterval && [15, 30, 60].includes(sshKeepAliveInterval)) {
          setSelectedKeepAlive(sshKeepAliveInterval);
        } else if (sshKeepAliveInterval && sshKeepAliveInterval > 0) {
          setSelectedKeepAlive(-1);
          setCustomKeepAlive(String(sshKeepAliveInterval));
        } else {
          setSelectedKeepAlive(30); // Default
        }
      }
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [connection, sshKeepAliveOverride, sshKeepAliveInterval]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (protocolDropdownRef.current && !protocolDropdownRef.current.contains(event.target as Node)) {
        setShowProtocolDropdown(false);
      }
      if (keepAliveDropdownRef.current && !keepAliveDropdownRef.current.contains(event.target as Node)) {
        setShowKeepAliveDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Validation
  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = t('connections.validation.nameRequired');
    }

    if (!hostname.trim()) {
      newErrors.hostname = t('connections.validation.hostnameRequired');
    }

    if (port < 1 || port > 65535) {
      newErrors.port = t('connections.validation.portInvalid');
    }

    if (!username.trim()) {
      newErrors.username = t('connections.validation.usernameRequired');
    }

    if (auth.authType === 'password' && !auth.password && !connection) {
      newErrors.password = t('connections.validation.passwordRequired');
    }

    if (auth.authType === 'publicKey' && !auth.keyPath.trim()) {
      newErrors.keyPath = t('connections.validation.keyPathRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Keep-alive dropdown helpers
  const getKeepAliveLabel = () => {
    if (selectedKeepAlive === 'disabled') return t('sshKeepAlive.disabled');
    if (selectedKeepAlive === 15) return `15 ${t('sshKeepAlive.seconds')}`;
    if (selectedKeepAlive === 30) return `30 ${t('sshKeepAlive.seconds')}`;
    if (selectedKeepAlive === 60) return `60 ${t('sshKeepAlive.seconds')}`;
    if (selectedKeepAlive === -1) {
      return customKeepAlive ? `${customKeepAlive} ${t('sshKeepAlive.seconds')}` : t('sshKeepAlive.custom');
    }
    return t('sshKeepAlive.disabled');
  };

  const handleKeepAliveChange = (value: number | 'disabled') => {
    setSelectedKeepAlive(value);
    setShowKeepAliveDropdown(false);

    // Map to backend values
    if (value === 'disabled') {
      setSshKeepAliveOverride('disabled');
      setSshKeepAliveInterval(null);
      setCustomKeepAlive('');
    } else if (value === -1) {
      setSshKeepAliveOverride('enabled');
      // Custom value will be set when user types
    } else {
      setSshKeepAliveOverride('enabled');
      setSshKeepAliveInterval(value);
      setCustomKeepAlive('');
    }
  };

  // Handle submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) {
      return;
    }

    setIsSubmitting(true);

    try {
      if (connection) {
        // Update existing connection
        const input: UpdateConnectionInput = {
          id: connection.id,
          name,
          protocol,
          hostname,
          port,
          username,
          ...(folder && { folder }),
          ...(color && { color }),
          ...(icon && { icon }),
          ...(notes && { notes }),
          sshKeepAliveOverride: sshKeepAliveOverride,
          sshKeepAliveInterval: sshKeepAliveInterval,
          hc: hcOptOut ? false : null, // always send so turning it back off clears the opt-out
        };

        // Only include auth method when there's something to change: for password
        // keep the existing one if left blank; key-file needs a path; agent has no
        // secret so it's always safe to (re)apply.
        if (auth.authType === 'password') {
          if (auth.password) input.authMethod = { type: 'password', password: auth.password };
        } else if (auth.authType === 'publicKey') {
          if (auth.keyPath) input.authMethod = toAuthMethodInput(auth);
        } else {
          input.authMethod = toAuthMethodInput(auth);
        }

        await update(input);
      } else {
        // Create new connection
        const input: CreateConnectionInput = {
          name,
          protocol,
          hostname,
          port,
          username,
          authMethod: toAuthMethodInput(auth),
          ...(folder && { folder }),
          ...(collectionTargetId && { collectionId: collectionTargetId }),
          ...(color && { color }),
          ...(icon && { icon }),
          ...(notes && { notes }),
          sshKeepAliveOverride: sshKeepAliveOverride,
          sshKeepAliveInterval: sshKeepAliveInterval,
          ...(hcOptOut && { hc: false }),
        };

        await create(input);
      }

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Failed to save connection:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="m-backdrop" onClick={onClose}>
      <div className="m-modal max-w-2xl max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold">
              {connection ? t('connections.titleEdit') : t('connections.titleNew')}
            </h2>
            {defaultCollectionId && collectionTargets?.find((c) => c.id === (connection?.collectionId ?? defaultCollectionId)) && (
              <p className="mt-1 text-sm text-muted-foreground">
                in “{collectionTargets.find((c) => c.id === (connection?.collectionId ?? defaultCollectionId))?.name}”
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t('connections.cancel')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('connections.name')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('connections.namePlaceholder')}
              className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
            />
            {errors.name && <p className="mt-1 text-sm text-red-500">{errors.name}</p>}
          </div>

          {/* Protocol Dropdown */}
          <div ref={protocolDropdownRef}>
            <label className="mb-1 block text-sm font-medium">{t('connections.protocol')}</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowProtocolDropdown(!showProtocolDropdown)}
                className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
              >
                <span>{protocol}</span>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Dropdown Menu */}
              {showProtocolDropdown && (
                <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg divide-y divide-border">
                  <button
                    type="button"
                    onClick={() => {
                      setProtocol('SSH');
                      setShowProtocolDropdown(false);
                      // Update port to default SSH port if it's SFTP port
                      if (port === 22 || port === 2222) setPort(22);
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                  >
                    SSH
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProtocol('SFTP');
                      setShowProtocolDropdown(false);
                      // Keep port as is, SFTP typically uses same port as SSH
                    }}
                    className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                  >
                    SFTP
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Hostname and Port */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium">
                {t('connections.hostname')} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder={t('connections.hostnamePlaceholder')}
                className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
              />
              {errors.hostname && <p className="mt-1 text-sm text-red-500">{errors.hostname}</p>}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('connections.port')} <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value) || 22)}
                className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
              />
              {errors.port && <p className="mt-1 text-sm text-red-500">{errors.port}</p>}
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('connections.username')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('connections.usernamePlaceholder')}
              className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
            />
            {errors.username && <p className="mt-1 text-sm text-red-500">{errors.username}</p>}
          </div>

          {/* Authentication — shared with Quick SSH (password / key file / agent) */}
          <AuthSection
            value={auth}
            onChange={setAuth}
            isEdit={!!connection}
            errors={{ password: errors.password, keyPath: errors.keyPath }}
          />

          {/* Colour */}
          <div>
            <label className="mb-1 block text-sm font-medium">{t('connections.color')}</label>
            <div className="m-swatches">
              {MACHINE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`m-sw ${color === c ? 'sel' : ''}`}
                  style={{ backgroundColor: c }}
                  aria-label={`colour ${c}`}
                />
              ))}
            </div>
          </div>

          {/* Health-check (ADR 0017): a machine can opt out of active probing. */}
          <div>
            <label className="mb-1 block text-sm font-medium">Health-check</label>
            <select
              value={hcOptOut ? 'off' : 'inherit'}
              onChange={(e) => setHcOptOut(e.target.value === 'off')}
              className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
            >
              <option value="inherit">Follow the collection / server policy</option>
              <option value="off">Never probe this machine</option>
            </select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              A machine can opt out of active probing; it can&apos;t opt into more than the server allows.
            </p>
          </div>

          {/* Save-to-collection target (ADR 0016) — accounts context only */}
          {collectionTargets && collectionTargets.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium">{t('connections.saveToCollection')}</label>
              <select
                value={collectionTargetId}
                onChange={(e) => setCollectionTargetId(e.target.value)}
                disabled={!!connection}
                className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none disabled:opacity-60"
              >
                {collectionTargets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {connection && (
                <p className="mt-1 text-xs text-muted-foreground">{t('connections.collectionMoveUnsupported')}</p>
              )}
            </div>
          )}

          {/* Optional Fields - Collapsible */}
          <details className="rounded border border-border p-4">
            <summary className="cursor-pointer font-medium">{t('common.advancedOptions')}</summary>
            <div className="mt-4 space-y-4">
              {/* Folder — a personal organiser label (not sharing; that's a collection) */}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('connections.folder')}</label>
                <input
                  type="text"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder={t('connections.folderPlaceholder')}
                  className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="mb-1 block text-sm font-medium">{t('connections.notes')}</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('connections.notesPlaceholder')}
                  rows={3}
                  className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                />
              </div>

              {/* SSH Keep-Alive Settings */}
              <div ref={keepAliveDropdownRef}>
                <label className="mb-1 block text-sm font-medium">{t('sshKeepAlive.label')}</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowKeepAliveDropdown(!showKeepAliveDropdown)}
                    className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
                  >
                    <span>{getKeepAliveLabel()}</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {showKeepAliveDropdown && (
                    <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg divide-y divide-border">
                      <button
                        type="button"
                        onClick={() => handleKeepAliveChange('disabled')}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('sshKeepAlive.disabled')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleKeepAliveChange(15)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        15 {t('sshKeepAlive.seconds')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleKeepAliveChange(30)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        30 {t('sshKeepAlive.seconds')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleKeepAliveChange(60)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        60 {t('sshKeepAlive.seconds')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleKeepAliveChange(-1)}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('sshKeepAlive.custom')}
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  {t('sshKeepAlive.description')}
                </p>
              </div>

              {/* Custom Keep-Alive Input */}
              {selectedKeepAlive === -1 && (
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('sshKeepAlive.customLabel')}</label>
                  <input
                    type="number"
                    value={customKeepAlive}
                    onChange={(e) => {
                      setCustomKeepAlive(e.target.value);
                      const val = parseInt(e.target.value);
                      if (!isNaN(val) && val > 0) {
                        setSshKeepAliveInterval(val);
                      }
                    }}
                    placeholder={t('common.seconds')}
                    min="1"
                    max="300"
                    className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                  />
                </div>
              )}
            </div>
          </details>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              {t('connections.cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isSubmitting ? t('connections.saving') : t('connections.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
