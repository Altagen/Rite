# Installing RITE

What a release ships, and how to run it. Building from source is in the
[README](./README.md); running an instance for a team is in [docs/SERVER.md](docs/SERVER.md).

## What a release contains

Every tag publishes, on its [release page](https://github.com/Altagen/Rite/releases):

| Asset | Contents |
|-------|----------|
| `rite-<version>-linux-x86_64.tar.gz` | the desktop client, one binary |
| `rite-<version>-linux-aarch64.tar.gz` | same, ARM64 |
| `rite-<version>-macos-x86_64.tar.gz` | same, Intel Macs |
| `rite-<version>-macos-aarch64.tar.gz` | same, Apple Silicon |
| `rite-<version>-checksums.txt` | SHA-256 of every tarball above |
| `sbom-<version>.json` | CycloneDX bill of materials for the client |

The server is a container image rather than a release asset:
`ghcr.io/altagen/rite-server:<version>`, built for linux/amd64 and linux/arm64.

There are no `.deb`, `.rpm`, `.dmg` or AppImage packages, and no auto-update. The
client is a single binary; an update is a new binary in place of the old one.

## Desktop client

### With the script

```bash
curl -fsSLO https://raw.githubusercontent.com/Altagen/Rite/main/scripts/install.sh
less install.sh          # it is short, and it runs on your machine
sh install.sh            # latest release, into ~/.local
```

It resolves the latest release, verifies the checksum, places the binary, and writes the
launcher entry and the icons — so Rite appears in the application menu and no longer
depends on the terminal it was started from.

| Option | Effect |
|--------|--------|
| `--prefix DIR` | install under `DIR/bin` and `DIR/share` instead of `~/.local` |
| `--version TAG` | a release you name rather than the latest |
| `--bin PATH` | a binary you already have, instead of downloading one |
| `--uninstall` | remove what it wrote; the vault is untouched |

A launcher reads `XDG_DATA_HOME` and `XDG_DATA_DIRS` only, so `--prefix` outside them
writes a correct entry that no menu will show. `--prefix /usr/local` is in them, and is
the system-wide install.

The script can be piped — `curl -fsSL <url> | sh -s -- --prefix /opt/rite` — and the two
steps above are still the documented form: Rite's premise is that a server is not trusted
with a secret, so it will not ask anyone to run a script they have not seen.

### By hand

```bash
VERSION=0.2.8
BASE=https://github.com/Altagen/Rite/releases/download/$VERSION

curl -fLO $BASE/rite-$VERSION-linux-x86_64.tar.gz
curl -fLO $BASE/rite-$VERSION-checksums.txt
sha256sum -c --ignore-missing rite-$VERSION-checksums.txt

tar -xzf rite-$VERSION-linux-x86_64.tar.gz
install -Dm755 rite ~/.local/bin/rite
~/.local/bin/rite --install
```

The last line is what the script does for you: it writes the launcher entry and the icons.
Without it the binary runs, and nothing on the desktop knows Rite exists. It takes
`--prefix DIR` too, and `rite --uninstall` takes it all back.

**The binary emits, an installer places.** `rite --print-app-id`,
`--print-desktop-entry PATH`, `--print-icon SIZE`, `--print-icon-sizes` and
`--print-data-dir` write to stdout
and touch nothing, which is how a packager builds a `.deb` or a PKGBUILD without this
repository's script and without guessing the app-id.

`--ignore-missing` is what makes the checksum file usable: it lists every platform's
tarball, and you downloaded one. Without it, `sha256sum` reports the three you do not
have as failures and exits non-zero on a download that was fine.

If `~/.local/bin` is not on your `PATH`, either add it or put the binary somewhere that
is. Then `rite` opens the window.

### Linux system libraries

The client renders in a WebKitGTK webview, which it does not carry. These are runtime
packages, not the `-dev` ones a source build needs:

```bash
# Debian / Ubuntu
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0

# Fedora / RHEL
sudo dnf install webkit2gtk4.1 gtk3

# Arch
sudo pacman -S webkit2gtk-4.1 gtk3
```

Missing them, the binary fails to start with a loader error naming
`libwebkit2gtk-4.1.so.0` — a packaging problem, not a RITE one.

### macOS

The same tarball, unpacked the same way. The binary is unsigned and unnotarised, so a
download through a browser carries a quarantine flag and Gatekeeper refuses to open it:

```bash
xattr -d com.apple.quarantine rite
```

A download with `curl` is not quarantined and needs nothing.

## Server

One image, the configuration outside it:

```bash
podman pull ghcr.io/altagen/rite-server:0.2.8
```

[docs/SERVER.md](docs/SERVER.md) covers what it needs to be useful: a volume for the
database, TLS, the first administrator, and the instance policies that a deployment
declares as code.

## Where it keeps state

The client writes under one directory, and nothing outside it:

| Path (Linux) | Contents |
|--------------|----------|
| `~/.local/share/rite/vault.db` | the encrypted vault: machines, collections, secrets |
| `~/.local/share/rite/device.json` | this machine's UI preferences |
| `~/.local/share/rite/vaults.json` | which vault files this client knows about |
| `~/.config/rite/layouts.toml` | the workspace file: presets and layouts ([docs/LAYOUTS.md](docs/LAYOUTS.md)) |

On macOS both directories are `~/Library/Application Support/rite/`.

`rite --print-data-dir` prints the first one as the running binary resolves it, honouring
`XDG_DATA_HOME`. A backup script reads it from there rather than hardcoding the table
above.

The vault is encrypted with a key derived from your passphrase (Argon2id), so a copy of
`vault.db` is worth nothing without it — and unrecoverable if you forget it.

## Uninstalling

```bash
rite --uninstall                      # the binary, the entry and the icons
rm -rf ~/.local/share/rite ~/.config/rite   # every trace, vault included
```

The second command destroys the vault. Nothing else holds a copy.

## Updating

Download the new tarball, verify it, replace the binary. The vault is migrated in place
the first time a client that needs a newer schema opens it, and never migrated backward:
once a newer client has opened a vault, going back to an older one is a restore from your
own backup, not a downgrade.
