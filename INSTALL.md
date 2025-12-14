# RITE - Installation Guide

Complete installation guide for RITE on different platforms.

## Installation from Package (Recommended)

### Linux - Debian/Ubuntu (.deb)

```bash
# Download from GitHub Releases
wget https://github.com/<org>/Rite/releases/download/0.1.0/RITE_0.1.0_amd64.deb

# Verify checksum
sha256sum -c RITE_0.1.0_amd64.deb.sha256

# Install
sudo dpkg -i RITE_0.1.0_amd64.deb

# Install dependencies if needed
sudo apt-get install -f
```

### Linux - Fedora/RHEL (.rpm)

```bash
# Download from GitHub Releases
wget https://github.com/<org>/Rite/releases/download/0.1.0/RITE-0.1.0-1.x86_64.rpm

# Verify checksum
sha256sum -c RITE-0.1.0-1.x86_64.rpm.sha256

# Install
sudo dnf install ./RITE-0.1.0-1.x86_64.rpm

# Or with rpm
sudo rpm -i RITE-0.1.0-1.x86_64.rpm
```

### Linux - tar.gz Archive (Universal)

```bash
# Download from GitHub Releases
wget https://github.com/<org>/Rite/releases/download/0.1.0/rite-0.1.0-linux-x86_64.tar.gz

# Verify checksum
sha256sum -c rite-0.1.0-linux-x86_64.tar.gz.sha256

# Extract (contains binary only)
tar -xzf rite-0.1.0-linux-x86_64.tar.gz

# Install to ~/.local/bin
mkdir -p ~/.local/bin
mv rite-0.1.0-linux-x86_64 ~/.local/bin/rite
chmod +x ~/.local/bin/rite

# Ensure ~/.local/bin is in PATH
echo $PATH | grep -q "$HOME/.local/bin" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### macOS (.dmg)

```bash
# Download from GitHub Releases
# For Intel Macs:
wget https://github.com/<org>/Rite/releases/download/0.1.0/RITE_0.1.0_x64.dmg

# For Apple Silicon:
wget https://github.com/<org>/Rite/releases/download/0.1.0/RITE_0.1.0_aarch64.dmg

# Verify checksum
shasum -a 256 -c RITE_0.1.0_*.dmg.sha256

# Mount and install
open RITE_0.1.0_*.dmg
# Drag RITE.app to Applications
```

## System Dependencies

### Debian/Ubuntu

```bash
sudo apt-get update
sudo apt-get install \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0
```

### Fedora/RHEL

```bash
sudo dnf install \
  webkit2gtk4.1 \
  gtk3
```

### Arch Linux

```bash
sudo pacman -S \
  webkit2gtk \
  gtk3
```

### macOS

No additional dependencies required.

## Installation from Source

### Prerequisites

- **Rust**: 1.70+ ([rustup.rs](https://rustup.rs/))
- **Node.js**: 20+ ([nodejs.org](https://nodejs.org/))
- **pnpm**: 8+ (`npm install -g pnpm`)
- **go-task**: 3+ ([taskfile.dev](https://taskfile.dev/installation/))

### Build Dependencies

#### Debian/Ubuntu

```bash
sudo apt-get install \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl wget file \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

#### Fedora/RHEL

```bash
sudo dnf install \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl wget file \
  gtk3-devel \
  libappindicator-gtk3-devel \
  librsvg2-devel
```

#### Arch Linux

```bash
sudo pacman -S \
  webkit2gtk \
  base-devel \
  curl wget file \
  openssl \
  gtk3 \
  libappindicator-gtk3 \
  librsvg \
  go-task
```

#### macOS

```bash
# Install Xcode command line tools
xcode-select --install

# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install go-task
brew install go-task
```

### Build Steps

```bash
# 1. Clone the repository
git clone https://github.com/<org>/Rite.git
cd Rite

# 2. Install dependencies
pnpm install

# 3. Build for current platform
task build

# Binary will be at:
# - Linux: apps/desktop/src-tauri/target/release/rite
# - macOS: apps/desktop/src-tauri/target/release/rite

# 4. Or build with all artifacts (packages)
task prepare-release

# Artifacts will be in ./dist/
```

### Local Installation

```bash
# Linux - from binary
sudo cp apps/desktop/src-tauri/target/release/rite /usr/local/bin/

# Or install generated .deb package
task install

# macOS - copy app
cp -r apps/desktop/src-tauri/target/release/bundle/macos/RITE.app /Applications/
```

## Verify Installation

```bash
# Check RITE is installed
which rite

# Show version
rite --version

# Or launch GUI
rite
```

## Initial Configuration

On first launch, RITE creates:

### Linux
- **Config**: `~/.config/rite/`
- **Data**: `~/.local/share/rite/`
- **Database**: `~/.local/share/rite/vault.db`

### macOS
- **Config**: `~/Library/Application Support/rite/`
- **Data**: `~/Library/Application Support/rite/`
- **Database**: `~/Library/Application Support/rite/vault.db`

## Uninstallation

### Debian/Ubuntu

```bash
sudo apt-get remove rite
```

### Fedora/RHEL

```bash
sudo dnf remove rite
# or
sudo rpm -e rite
```

### tar.gz Archive

```bash
rm ~/.local/bin/rite
```

### macOS

```bash
# Remove application
rm -rf /Applications/RITE.app

# Or if installed via Homebrew (future)
brew uninstall rite
```

### Remove User Data

```bash
# Linux
rm -rf ~/.config/rite
rm -rf ~/.local/share/rite

# macOS
rm -rf ~/Library/Application\ Support/rite
```

## Updating

### Packages

```bash
# Download new version from GitHub Releases
# Then reinstall as above
```

### From Source

```bash
cd Rite
git pull
pnpm install
task build
task install
```

## Auto-Update Support

⚠️ **Not yet available** - Auto-update will be added in a future version.

For now, updates must be done manually.

## Troubleshooting

### "Command not found: rite"

Verify binary is in PATH:
```bash
# Linux
echo $PATH | grep -q "$HOME/.local/bin" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# macOS
echo $PATH
```

### "Library not found: libwebkit2gtk"

Install system dependencies (see System Dependencies section above).

### "Permission denied"

```bash
chmod +x ~/.local/bin/rite
```

### Database Locked / Permissions

```bash
# Linux
chmod 600 ~/.local/share/rite/vault.db

# macOS
chmod 600 ~/Library/Application\ Support/rite/vault.db
```

## Documentation

- [README.md](./README.md) - Overview
- [QUICKSTART.md](./QUICKSTART.md) - Quick start guide
- [RELEASE.md](./RELEASE.md) - Release process
- [ROADMAP.md](./docs/ROADMAP.md) - Planned features

## Support

- **Issues**: https://github.com/<org>/Rite/issues
- **Discussions**: https://github.com/<org>/Rite/discussions
- **Documentation**: ./docs/
