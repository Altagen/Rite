# RITE Security Model

This document outlines the security architecture, threat model, and best practices for RITE.

## Security Principles

1. **Zero-Knowledge Architecture**: Sync servers (if used) never see unencrypted data
2. **Defense in Depth**: Multiple layers of protection
3. **Secure by Default**: Strong security settings out of the box
4. **User Transparency**: Clear communication about security trade-offs
5. **Privacy First**: User controls their data and where it's stored

## Cryptography Stack

### Key Derivation
- **Algorithm**: Argon2id (RFC 9106)
- **Parameters**:
  - Memory: 64 MiB (default)
  - Iterations: 3
  - Parallelism: 4
  - Salt: 128-bit (16 bytes), unique per user
  - Output: 256-bit (32 bytes) master key

**Rationale**: Argon2id is the winner of the Password Hashing Competition and provides excellent resistance against both GPU and side-channel attacks.

### Symmetric Encryption
- **Algorithm**: ChaCha20-Poly1305 (AEAD)
- **Key Size**: 256-bit
- **Nonce**: 96-bit, randomly generated per encryption

**Rationale**: ChaCha20-Poly1305 is faster than AES-GCM on systems without hardware AES support and provides authenticated encryption.

### File Encryption (Sync/Export)
- **Tool**: age (Actually Good Encryption)
- **Key Type**: Asymmetric (X25519) or symmetric
- **Format**: Standard age format with armor

**Rationale**: age is a modern, simple, and secure alternative to GPG with a much smaller attack surface.

## Threat Model

### In Scope

#### Physical Access to Unlocked Device
**Threat**: Attacker gains physical access while app is unlocked

**Mitigations**:
- Auto-lock after configurable inactivity (default: 15 minutes)
- Lock on system sleep/screensaver (configurable)
- Option to close SSH sessions on lock
- Clipboard auto-clear (configurable)

#### Physical Access to Locked Device
**Threat**: Attacker has physical access to locked laptop/storage

**Mitigations**:
- Database encrypted at rest with master key
- Master key derived from strong password (Argon2id)
- Sensitive data zeroized from memory when locked
- No plaintext credentials on disk

#### Network Attacks
**Threat**: Man-in-the-middle, network sniffing

**Mitigations**:
- SSH's built-in encryption and authentication
- Host key verification (SSH)
- No credentials sent over network in plaintext
- Sync data encrypted before transmission (E2E)

#### Sync Server Compromise
**Threat**: Attacker gains access to sync server

**Mitigations**:
- End-to-end encryption (server only sees encrypted blobs)
- Zero-knowledge architecture
- User can self-host sync backend
- Multiple sync backend options (Git, S3, WebDAV)

#### Brute Force Attacks
**Threat**: Attacker attempts to brute force master password

**Mitigations**:
- Argon2id with high memory cost (64 MiB+)
- Configurable KDF parameters for stronger protection
- Password strength indicator and requirements
- No password recovery (by design)

#### Malware on User's System
**Threat**: Keylogger, memory scraper, malicious process

**Mitigations**:
- Memory zeroization for sensitive data (using `zeroize` crate)
- mlock() to prevent swapping of sensitive pages (Phase 2, Linux)
- Limited attack surface: no credentials stored in plaintext
- **Note**: Local malware with root/admin access is largely unstoppable

### Out of Scope

#### Remote Code Execution
We assume the RITE binary itself is trusted and not compromised. Users should:
- Download from official sources
- Verify PGP signatures (when available)
- Build from source if needed

#### Advanced Persistent Threats (APT)
State-level actors with physical access to hardware or ability to compromise the OS are out of scope.

#### Side-Channel Attacks
Timing attacks, power analysis, and similar advanced techniques are mitigated where possible but not the primary focus.

## Data Storage

### Local Database
- **Location**: `~/.local/share/rite/vault.db` (Linux)
- **Format**: SQLite
- **Encryption**: Individual field encryption with ChaCha20-Poly1305
- **Master Key**: Stored in memory only (derived from password on unlock)

### Sensitive Data
The following are encrypted before storage:
- Host passwords
- SSH private keys (if imported)
- Connection details (optional: can be plaintext for quick access)
- Sync credentials

### Metadata (Not Encrypted)
- Host names (for indexing and search)
- Protocol types
- Tags and groups
- Last connection timestamp

**Rationale**: Metadata needs to be searchable. Highly sensitive users can enable full database encryption.

### Keyring Integration
- **Linux**: Secret Service API (GNOME Keyring, KWallet)
- **macOS**: Keychain (Phase 2)
- **Use Case**: Store master password (opt-in) or sync credentials

## Configuration Security

### Master Password
- **Minimum Length**: 12 characters (enforced)
- **Strength Meter**: Real-time feedback
- **Recovery**: None (by design - user must backup)
- **Reset**: Delete vault (data loss)

### Auto-Lock Settings
```toml
[security]
auto_lock_minutes = 15      # Lock after inactivity
lock_on_sleep = true         # Lock when system sleeps
close_ssh_on_lock = false    # Keep sessions alive (default)
clear_clipboard_seconds = 0  # 0 = disabled, >0 = auto-clear
```

### SSH Key Management
- **Storage**: Private keys encrypted in vault OR referenced from `~/.ssh/`
- **Passphrases**: Encrypted with master key
- **Agent**: SSH agent integration for external keys

## Sync Security (Phase 2+)

### End-to-End Encryption Flow
```
1. User unlocks vault with master password
2. Master key derived via Argon2id
3. Vault data encrypted with age (using derived key)
4. Encrypted blob pushed to sync backend
5. On other device: pull blob → decrypt with same master password
```

**Server never sees**:
- Master password
- Decrypted vault data
- SSH credentials
- Connection details

### Sync Backends
All backends support E2E encryption:
- **Git**: Encrypted file committed and pushed
- **S3**: Encrypted blob uploaded
- **WebDAV**: Encrypted file synced

## Logging and Debugging

### Production Logs
- **Location**: `~/.local/share/rite/logs/`
- **Contents**: Events, errors, connection attempts
- **Excluded**: Passwords, private keys, command output with secrets

### Debug Mode
- **Opt-in only**: `RITE_DEBUG=1` or config flag
- **Warning displayed**: "Debug mode may log sensitive data"
- **Use case**: Development and troubleshooting only
- **Not for production**

## Security Checklist (Pre-Release)

- [ ] All dependencies audited (`cargo audit`)
- [ ] Crypto implementation reviewed
- [ ] No hardcoded secrets or test credentials
- [ ] Proper zeroization of sensitive data
- [ ] Input validation on all Tauri commands
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention in frontend
- [ ] CSP headers configured
- [ ] File path traversal prevention
- [ ] Fuzzing of parsers (SSH config, theme JSON, etc.)
- [ ] Third-party security audit (recommended)

## Vulnerability Reporting

**Do NOT open public GitHub issues for security vulnerabilities.**

Contact: [Your email or security contact]

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within 48 hours and will coordinate disclosure timeline.

## Best Practices for Users

1. **Use a strong master password** (16+ characters, unique)
2. **Backup your recovery key** (print or store securely offline)
3. **Enable auto-lock** (don't leave unlocked unattended)
4. **Use SSH keys over passwords** when possible
5. **Verify host keys** on first connection
6. **Self-host sync** if you handle highly sensitive servers
7. **Keep RITE updated** for security patches
8. **Don't log credentials** (disable debug mode in production)

## Future Security Enhancements

- [ ] Full database encryption (alternative to field-level)
- [ ] Hardware security key support (YubiKey, etc.) - Phase 4+
- [ ] Biometric unlock (Touch ID, Face ID) - macOS Phase 4+
- [ ] Encrypted audit logs
- [ ] Rate limiting for password attempts
- [ ] Canary tokens for breach detection
- [ ] Reproducible builds

## References

- [RFC 9106 - Argon2](https://datatracker.ietf.org/doc/html/rfc9106)
- [age encryption](https://age-encryption.org/)
- [ChaCha20-Poly1305](https://datatracker.ietf.org/doc/html/rfc8439)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
