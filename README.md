# Syncthing Custom GUI

Modern dark-theme Web UI for Syncthing, with NAS-centric sync management.

![screenshot](https://img.shields.io/badge/theme-dark-1a1a2e) ![stack](https://img.shields.io/badge/stack-HTML%2FJS%2FPython-blue)

## Features

- **NAS as hub** — NAS shows all folders; local PC selectively syncs
- **Real-time progress** — Events API driven: scan% → upload% → done
- **File change watcher** — Sidecar detects new files within 3s, triggers scan
- **Folder management** — drag-sort, notes, global/per-folder ignore rules
- **Path migration** — seamless path change (pause → recreate → resume)
- **Delete control** — optional NAS file deletion on folder removal
- **Zero build** — pure HTML/CSS/JS frontend, Python stdlib backend

## Architecture

```
Browser (:8080)
  └── Sidecar (:8385)  ← Python, proxies all API + NAS SSH
        ├── Syncthing (:8384)  ← local instance
        └── NAS Syncthing (SSH)  ← remote instance in Docker
```

## Quick Start

```bash
# 1. Clone
git clone https://github.com/UCHIHAHA103/syncthing-custom-gui.git
cd syncthing-custom-gui

# 2. Configure NAS credentials
cp .env.example .env
# Edit .env: set NAS_SSH and NAS_API_KEY

# 3. Launch
.\start.ps1
# Or manually:
#   python backend/sidecar.py <syncthing-api-key>
#   python -m http.server 8080 --directory frontend
```

## Configuration

| Variable | Description |
|---|---|
| `NAS_SSH` | SSH target for NAS (e.g. `user@192.168.x.x`) |
| `NAS_API_KEY` | Syncthing API key on NAS |
| Syncthing API key | Passed as CLI arg or via `SYNCTHING_API_KEY` env var |

Config files stored in `~/.config/syncthing-custom-gui/`.

## Tech Stack

- **Frontend**: HTML / CSS / JS (no framework, no build)
- **Backend**: Python 3 standard library only
- **API**: Syncthing REST API + Events API + custom sidecar endpoints

## License

MIT
