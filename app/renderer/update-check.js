/* ── update-check.js — in-app GitHub release notifier ──────────────────────
 * Once per launch (after a short startup delay so we don't fight the boot
 * sequence), fetches the latest release from the GitHub API and compares
 * its tag to the running app's version. If a newer release exists, shows
 * a small dismissable badge in the bottom-right.
 *
 * The user can dismiss a specific version (won't be shown again until a
 * new one appears) via localStorage `dismissedUpdateVersion`.
 *
 * No telemetry, no auth — the GitHub API call is unauthenticated and
 * subject to a 60-req/hour rate limit per IP, which is fine for a single
 * check per launch.
 * ──────────────────────────────────────────────────────────────────────── */

import { $, esc } from './utils.js';
import { compareVersions } from '../shared/helpers.js';

const REPO        = 'DeceasedCranium/days-between';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const STARTUP_DELAY_MS = 4000;
const DISMISS_KEY = 'dismissedUpdateVersion';

function showUpdateBadge({ version, releaseUrl, body }) {
  // Dismiss if we've already shown this exact version.
  if (localStorage.getItem(DISMISS_KEY) === version) return;

  const existing = document.getElementById('updateBadge');
  if (existing) existing.remove();

  const badge = document.createElement('div');
  badge.id = 'updateBadge';
  badge.className = 'update-badge';
  badge.innerHTML = `
    <div class="update-badge-text">
      <strong>Update available</strong>
      <span>v${esc(version)} is ready</span>
    </div>
    <button class="update-badge-view" id="updateBadgeView">View</button>
    <button class="update-badge-dismiss" id="updateBadgeDismiss" title="Dismiss">×</button>`;
  document.body.appendChild(badge);

  $('updateBadgeView').addEventListener('click', () => {
    window.ipc?.openUrl(releaseUrl);
  });
  $('updateBadgeDismiss').addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, version);
    badge.remove();
  });

  // Slide-in animation hook
  requestAnimationFrame(() => badge.classList.add('visible'));
}

async function check() {
  try {
    const current = await window.ipc?.appVersion?.();
    if (!current) return;
    const r = await fetch(RELEASE_API, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!r.ok) {
      // Silent — rate-limited or transient network issue, try next launch.
      return;
    }
    const data = await r.json();
    const latest = data?.tag_name;
    if (!latest) return;
    if (compareVersions(latest, current) <= 0) return;
    showUpdateBadge({
      version:    String(latest).replace(/^v/, ''),
      releaseUrl: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
      body:       data.body ?? '',
    });
  } catch (err) {
    // Network error / no internet / etc. — silent.
    console.info('[update-check] skipped:', err.message);
  }
}

export function initUpdateCheck() {
  setTimeout(check, STARTUP_DELAY_MS);
}
