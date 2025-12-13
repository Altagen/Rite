# RITE Database Migrations

## Migration Strategy

### Alpha/Beta Phase (Current)
**DO NOT create new migration files during alpha/beta.**

Instead, modify `001_initial_schema.sql` directly. Users are expected to reset their databases during active development.

To reset database:
```bash
rm ~/.local/share/rite/vault.db*
```

### Post-Release (v1.0+)
After the first stable release, create numbered migrations starting from `002_*.sql`.

## How the Migration System Works

The migration system is **future-proof** and **safe by design**:

### 1. Version Detection
- On startup, checks current DB schema version (stored in `schema_version` table)
- Fresh databases start at version 0
- Existing databases have their version tracked

### 2. Selective Execution
- Only runs migrations newer than current DB version
- Example: DB at v1 with migrations 001-003 available → only runs 002 and 003
- Prevents re-running old migrations (avoids duplicate column errors)

### 3. Automatic Backups
- Before applying each migration, creates timestamped backup
- Backup location: `~/.local/share/rite/backups/vault_pre_migration_*.db`
- Uses SQLite `VACUUM INTO` for safe, consistent backups

### 4. Safety Checks
- **Downgrade Prevention**: If DB version is newer than app supports, app refuses to start
- **Idempotent Operations**: All migrations use `IF NOT EXISTS` clauses
- **Safe Fail**: If migration fails, app won't start (prevents data corruption)

### Example Migration Flow

```
DB v1 → App supports v1-v3
├─ Detect current version: 1
├─ Migrations to apply: 2, 3
├─ Backup DB → vault_pre_migration_20251129_115556.db
├─ Apply migration 002
├─ Backup DB → vault_pre_migration_20251129_115601.db
├─ Apply migration 003
└─ Done! DB now at v3
```

## Migration Rules

### Naming Convention
```
XXX_descriptive_name.sql
```
- `XXX`: Three-digit number (002, 003, etc.)
- Use snake_case for descriptive name
- Example: `002_add_profiles_table.sql`

### Migration File Structure
```sql
-- Migration XXX: Title
-- Purpose: Brief description of what this migration does
--
-- IMPORTANT: This migration must be idempotent (safe to run multiple times)

-- Your SQL here

-- Update schema version
INSERT OR IGNORE INTO schema_version (version, applied_at)
VALUES (XXX, strftime('%s', 'now'));
```

### Writing Safe Migrations

#### ✅ DO:
```sql
-- Use IF NOT EXISTS for tables
CREATE TABLE IF NOT EXISTS new_table (...);

-- Use IF NOT EXISTS for indexes
CREATE INDEX IF NOT EXISTS idx_name ON table(column);

-- Use ALTER TABLE ADD COLUMN with IF NOT EXISTS (SQLite 3.35.0+)
-- Or check column existence first

-- Use INSERT OR IGNORE for default data
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (...);
```

#### ❌ DON'T:
```sql
-- Don't drop tables (breaks old data)
DROP TABLE old_table;

-- Don't use non-idempotent operations
ALTER TABLE connections DROP COLUMN old_field;

-- Don't modify existing columns (breaks compatibility)
ALTER TABLE connections MODIFY COLUMN name TEXT;
```

### Backward Compatibility

**Golden Rule:** Never break existing databases.

- **Adding**: ✅ Safe - add new tables, columns (with defaults), indexes
- **Modifying**: ⚠️ Risky - requires careful migration logic
- **Deleting**: ❌ Dangerous - avoid unless absolutely necessary

### Migration Testing Checklist

Before committing a new migration:

- [ ] Test on fresh database (no existing data)
- [ ] Test on database with existing data
- [ ] Test running migration twice (idempotency)
- [ ] Verify no data loss
- [ ] Check performance impact on large datasets
- [ ] Update schema version correctly

### Rollback Strategy

**We don't support rollbacks.** Instead:

1. Users should backup before upgrading
2. Migrations must be additive when possible
3. If a migration fails, the app should fail to start (safe fail)

### Auto-Backup (Implemented ✅)

The migration system automatically creates a backup before applying each migration:

```rust
// Automatic backup implementation
if current_version > 0 {
    // Create timestamped backup: vault_pre_migration_YYYYMMDD_HHMMSS.db
    self.create_migration_backup().await?;
}
// Then apply migration safely
```

**Backup Location:** `~/.local/share/rite/backups/vault_pre_migration_*.db`

**Backup Method:** SQLite `VACUUM INTO` (recommended by SQLite docs for backups)

**When Backups Are Created:**
- Before each migration (except initial DB setup at version 0)
- Backups contain the complete database state before the migration
- Old backups are NOT automatically deleted (manual cleanup required)

## Current Schema Version

**Version 1** (Consolidated MVP Schema)
- Authentication (master password, unlock attempts)
- Settings (key-value store)
- Connections (SSH/SFTP/local with encrypted credentials)
- Known Hosts (SSH host key verification)

## Future Migrations (Examples)

### When to create migrations:

1. **New features requiring DB changes**
   - Example: `002_add_profiles_table.sql` for profiles/termconfs

2. **Performance optimizations**
   - Example: `003_add_connection_usage_index.sql`

3. **Security enhancements**
   - Example: `004_add_credential_rotation.sql`

### Migration Examples

#### Adding a new table:
```sql
-- Migration 002: Profiles/Termconfs Support
-- Purpose: Add profiles table for reproducible terminal configurations

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_name
ON profiles(name COLLATE NOCASE);

INSERT OR IGNORE INTO schema_version (version, applied_at)
VALUES (2, strftime('%s', 'now'));
```

#### Adding a column:
```sql
-- Migration 003: Connection Tags
-- Purpose: Add tags column for better connection organization

-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- So we use a workaround to make it idempotent

-- Check if column exists (requires pragma)
-- If not exists, add it
ALTER TABLE connections ADD COLUMN tags TEXT DEFAULT NULL;

INSERT OR IGNORE INTO schema_version (version, applied_at)
VALUES (3, strftime('%s', 'now'));
```

## Troubleshooting

### "Migration already applied" error
- Check `schema_version` table
- Verify migration number matches

### "Column already exists" error
- Migration is not idempotent
- Need to add existence checks

### Data loss after migration
- **DON'T PANIC**
- Check if backup exists (future feature)
- File issue with migration details

## See Also

- [SQLite ALTER TABLE docs](https://www.sqlite.org/lang_altertable.html)
- [Database Schema Documentation](../../docs/ARCHITECTURE.md#database)
