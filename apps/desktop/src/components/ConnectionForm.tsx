/**
 * Connection Form Component
 *
 * Form for creating and editing SSH/SFTP connections
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useConnectionsStore, type CreateConnectionInput, type UpdateConnectionInput, type ConnectionInfo, type Protocol } from '../store/connectionsStore';
import { useCollectionsStore } from '../store/collectionsStore';
import type { QuickSSHConnectionInfo } from './QuickSSHModal';

interface ConnectionFormProps {
  connection?: ConnectionInfo | null;
  prefillData?: QuickSSHConnectionInfo | null;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ConnectionForm({ connection, prefillData, onClose, onSuccess }: ConnectionFormProps) {
  const { t } = useTranslation();
  const { createConnection, updateConnection } = useConnectionsStore();
  const { collections, fetchCollections, createCollection } = useCollectionsStore();

  // Load collections on mount
  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  // Form state - use prefillData if provided, otherwise use connection data
  const [name, setName] = useState(connection?.name || (prefillData ? `${prefillData.username}@${prefillData.host}` : ''));
  const [protocol, setProtocol] = useState<Protocol>((connection?.protocol as Protocol) || 'SSH');
  const [hostname, setHostname] = useState(connection?.hostname || prefillData?.host || '');
  const [port, setPort] = useState(connection?.port || prefillData?.port || 22);
  const [username, setUsername] = useState(connection?.username || prefillData?.username || '');
  const [authMethod, setAuthMethod] = useState<'password' | 'publicKey'>(prefillData?.authType || 'password');
  const [password, setPassword] = useState(prefillData?.password || '');
  const [keyPath, setKeyPath] = useState(prefillData?.keyPath || '');
  const [keyPassphrase, setKeyPassphrase] = useState(prefillData?.passphrase || '');
  const [collection, setCollection] = useState(connection?.folder || '');
  const color = connection?.color || ''; // TODO: Implement color picker UI
  const icon = connection?.icon || ''; // TODO: Implement icon picker UI
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
  const [showPassword, setShowPassword] = useState(false);
  const [showKeyPassphrase, setShowKeyPassphrase] = useState(false);
  const [showProtocolDropdown, setShowProtocolDropdown] = useState(false);
  const [showCollectionDropdown, setShowCollectionDropdown] = useState(false);
  const [showNewCollectionInput, setShowNewCollectionInput] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const protocolDropdownRef = useRef<HTMLDivElement>(null);
  const collectionDropdownRef = useRef<HTMLDivElement>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize keep-alive dropdown based on connection settings
  useEffect(() => {
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
  }, [connection, sshKeepAliveOverride, sshKeepAliveInterval]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (protocolDropdownRef.current && !protocolDropdownRef.current.contains(event.target as Node)) {
        setShowProtocolDropdown(false);
      }
      if (collectionDropdownRef.current && !collectionDropdownRef.current.contains(event.target as Node)) {
        setShowCollectionDropdown(false);
        setShowNewCollectionInput(false);
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

    if (authMethod === 'password' && !password && !connection) {
      newErrors.password = t('connections.validation.passwordRequired');
    }

    if (authMethod === 'publicKey' && !keyPath.trim()) {
      newErrors.keyPath = t('connections.validation.keyPathRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Handle new collection creation
  const handleCreateCollection = async () => {
    if (!newCollectionName.trim()) return;

    try {
      const newColl = await createCollection(newCollectionName.trim());
      setCollection(newColl.name);
      setNewCollectionName('');
      setShowNewCollectionInput(false);
      setShowCollectionDropdown(false);
    } catch (error) {
      console.error('Failed to create collection:', error);
    }
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
          ...(collection && { folder: collection }),
          ...(color && { color }),
          ...(icon && { icon }),
          ...(notes && { notes }),
          sshKeepAliveOverride: sshKeepAliveOverride,
          sshKeepAliveInterval: sshKeepAliveInterval,
        };

        // Only include auth method if password or key path is provided
        if (authMethod === 'password' && password) {
          input.authMethod = { type: 'password', password };
        } else if (authMethod === 'publicKey' && keyPath) {
          input.authMethod = {
            type: 'publicKey',
            keyPath,
            ...(keyPassphrase && { passphrase: keyPassphrase }),
          };
        }

        await updateConnection(input);
      } else {
        // Create new connection
        const input: CreateConnectionInput = {
          name,
          protocol,
          hostname,
          port,
          username,
          authMethod:
            authMethod === 'password'
              ? { type: 'password', password }
              : {
                  type: 'publicKey',
                  keyPath,
                  ...(keyPassphrase && { passphrase: keyPassphrase }),
                },
          ...(collection && { folder: collection }),
          ...(color && { color }),
          ...(icon && { icon }),
          ...(notes && { notes }),
          sshKeepAliveOverride: sshKeepAliveOverride,
          sshKeepAliveInterval: sshKeepAliveInterval,
        };

        await createConnection(input);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl rounded-lg bg-background p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">
            {connection ? t('connections.titleEdit') : t('connections.titleNew')}
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label={t('connections.cancel')}
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

          {/* Authentication Method */}
          <div>
            <label className="mb-2 block text-sm font-medium">{t('connections.authMethod')}</label>
            <div className="flex gap-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  value="password"
                  checked={authMethod === 'password'}
                  onChange={(e) => setAuthMethod(e.target.value as 'password' | 'publicKey')}
                  className="mr-2"
                />
                {t('connections.authPassword')}
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  value="publicKey"
                  checked={authMethod === 'publicKey'}
                  onChange={(e) => setAuthMethod(e.target.value as 'password' | 'publicKey')}
                  className="mr-2"
                />
                {t('connections.authPublicKey')}
              </label>
            </div>
          </div>

          {/* Password or Key Path */}
          {authMethod === 'password' ? (
            <div>
              <label className="mb-1 block text-sm font-medium">
                {t('connections.password')} {!connection && <span className="text-red-500">*</span>}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={connection ? '••••••••' : t('connections.passwordPlaceholder')}
                  className="w-full rounded border border-border bg-input px-3 py-2 pr-10 text-foreground focus:border-primary focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  title={showPassword ? t('connections.hidePassword') : t('connections.showPassword')}
                >
                  {showPassword ? (
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
              </div>
              {errors.password && <p className="mt-1 text-sm text-red-500">{errors.password}</p>}
              {connection && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Leave empty to keep current password
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  {t('connections.keyPath')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder={t('connections.keyPathPlaceholder')}
                  className="w-full rounded border border-border bg-input px-3 py-2 text-foreground focus:border-primary focus:outline-none"
                />
                {errors.keyPath && <p className="mt-1 text-sm text-red-500">{errors.keyPath}</p>}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('connections.keyPassphrase')}</label>
                <div className="relative">
                  <input
                    type={showKeyPassphrase ? 'text' : 'password'}
                    value={keyPassphrase}
                    onChange={(e) => setKeyPassphrase(e.target.value)}
                    placeholder={t('connections.keyPassphrasePlaceholder')}
                    className="w-full rounded border border-border bg-input px-3 py-2 pr-10 text-foreground focus:border-primary focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKeyPassphrase(!showKeyPassphrase)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    title={showKeyPassphrase ? t('connections.hidePassword') : t('connections.showPassword')}
                  >
                    {showKeyPassphrase ? (
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
                </div>
              </div>
            </div>
          )}

          {/* Optional Fields - Collapsible */}
          <details className="rounded border border-border p-4">
            <summary className="cursor-pointer font-medium">{t('common.advancedOptions')}</summary>
            <div className="mt-4 space-y-4">
              {/* Collection Selector */}
              <div ref={collectionDropdownRef}>
                <label className="mb-1 block text-sm font-medium">{t('connections.collection')}</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowCollectionDropdown(!showCollectionDropdown)}
                    className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
                  >
                    <span>{collection || t('connections.collectionNone')}</span>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {showCollectionDropdown && (
                    <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg max-h-60 overflow-y-auto divide-y divide-border">
                      {/* No collection option */}
                      <button
                        type="button"
                        onClick={() => {
                          setCollection('');
                          setShowCollectionDropdown(false);
                        }}
                        className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
                      >
                        {t('connections.collectionNone')}
                      </button>

                      {/* Existing collections */}
                      {collections.map((coll) => (
                        <button
                          key={coll.id}
                          type="button"
                          onClick={() => {
                            setCollection(coll.name);
                            setShowCollectionDropdown(false);
                          }}
                          className="w-full px-3 py-2 text-left hover:bg-muted flex items-center gap-2 transition-colors"
                        >
                          {coll.color && (
                            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: coll.color }} />
                          )}
                          {coll.name}
                        </button>
                      ))}

                      {/* Create new collection */}
                      <div className="border-t border-border">
                        {showNewCollectionInput ? (
                          <div className="p-2">
                            <input
                              type="text"
                              value={newCollectionName}
                              onChange={(e) => setNewCollectionName(e.target.value)}
                              onKeyPress={(e) => e.key === 'Enter' && handleCreateCollection()}
                              placeholder={t('connections.collectionNamePlaceholder')}
                              className="w-full rounded border border-border bg-input px-2 py-1 text-sm"
                              autoFocus
                            />
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                onClick={handleCreateCollection}
                                className="flex-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                              >
                                {t('connections.collectionCreate')}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowNewCollectionInput(false);
                                  setNewCollectionName('');
                                }}
                                className="flex-1 rounded bg-secondary px-2 py-1 text-xs hover:bg-secondary/80"
                              >
                                {t('connections.cancel')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowNewCollectionInput(true)}
                            className="w-full px-3 py-2 text-left text-primary hover:bg-muted"
                          >
                            {t('connections.collectionNew')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
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
