# scripts/local — Developer-only tooling

> **⚠ Not for end users.** These scripts assume an Arch Linux developer
> machine with the repo cloned at a known path and `/opt/days-between`
> writeable via `sudo`. End users should download a release from
> [GitHub Releases](https://github.com/DeceasedCranium/days-between/releases)
> instead.

## What's here

| File | Purpose |
|---|---|
| `days-update.sh` | Maintainer's local sync — `git pull` + `rsync` of `app/` and `assets/` into `/opt/days-between/`. Used to test changes against a system-installed pacman package without rebuilding the package each time. |
| `install-pkg.sh` | Wrapper around `pacman -U --overwrite '/opt/days-between/*' <pkg.tar.zst>`. The `--overwrite` flag is needed because `days-update.sh` rsync writes files pacman doesn't track, which would otherwise conflict on package install. |
| `PKGBUILD` | Arch packaging recipe. Builds `days-between-X.Y.Z-1-any.pkg.tar.zst` for local testing. **Bundles whatever `config.js` is present at build time** — keeps API keys local to the maintainer's machine, not the public release artifacts (those are built by CI without `config.js`). |

## Why these aren't in the repo root

Earlier versions of the project kept these at the top level, which made
the repo look like an Arch-only thing to anyone browsing. They're
maintenance tooling, not part of the application.

Both shell scripts resolve their own symlink before locating `$REPO`,
so symlinking them into `~` (or anywhere else) Just Works:

```bash
ln -sf "$(pwd)/scripts/local/days-update.sh"  ~/days-update.sh
ln -sf "$(pwd)/scripts/local/install-pkg.sh"  ~/install-pkg.sh
```
