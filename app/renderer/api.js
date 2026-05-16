/* ── api.js — Relisten and Nugs.net API clients ─── */
import { nugsAuth } from './state.js';

/* ── Relisten ────────────────────────────────────── */
const API2 = 'https://api.relisten.net/api/v2';
const API3 = 'https://api.relisten.net/api/v3';

export { API2, API3 };

export const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  },
  artists:  ()            => api.get(`${API2}/artists`),
  years:    (slug)        => api.get(`${API2}/artists/${slug}/years`),
  shows:    (slug, year)  => api.get(`${API2}/artists/${slug}/years/${year}`),
  show:     (slug, date)  => api.get(`${API2}/artists/${slug}/shows/${date}`),
  random:   (slug)        => api.get(`${API2}/artists/${slug}/shows/random`),
  top:      (slug)        => api.get(`${API2}/artists/${slug}/shows/top?limit=30`),
  trending: ()            => api.get(`${API3}/trending/shows?limit=30`),
  recent:   ()            => api.get(`${API2}/shows/recently-added?limit=30`),
  onDate:   (m, d)        => api.get(`${API2}/shows/on-date?month=${m}&day=${d}`),
  search:   (q)           => api.get(`${API2}/search?q=${encodeURIComponent(q)}`),
  songs:    (slug)        => api.get(`${API2}/artists/${slug}/songs`),
};

/* ── Nugs.net ────────────────────────────────────── */
const NUGS_ID_URL    = 'https://id.nugs.net';
const NUGS_SUBS_URL  = 'https://subscriptions.nugs.net';
export const NUGS_STREAM = 'https://streamapi.nugs.net';
const NUGS_UA        = 'NugsNet/3.26.724 (Android; 7.1.2; Asus; ASUS_Z01QD; Scale/2.0; en)';
const NUGS_UA_PLAYER = 'nugsnetAndroid';
const NUGS_CLIENT_ID = 'Eg7HuH873H65r5rt325UytR5429';

// Cover-art URL builder + Nugs date parser — implementations live in
// app/shared/helpers.js (browser-free) so they can be unit-tested. We
// re-export from this module so existing import sites (`./api.js`)
// keep working, AND import them locally so internal callers in this
// file (nugsAuth.set construction inside login()) can use them too.
// The `export ... from` form is re-export only; it does NOT bind the
// symbols into module scope. Pure-re-export missed this for ~6 months
// because the login() call site only fires on fresh sign-in (not on
// refresh-token paths), and most users keep refreshing forever.
import { nugsContainerImage, parseNugsDate } from '../shared/helpers.js';
export { nugsContainerImage, parseNugsDate };

/** Decode the JWT payload (no signature verification) — used for `exp` and legacy fields. */
function decodeJwt(token) {
  try {
    const seg = String(token ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(seg.padEnd(seg.length + (4 - seg.length % 4) % 4, '=')));
  } catch { return {}; }
}

/** Convert an access_token's `exp` claim → ms epoch. Falls back to a 1h window. */
function expiryFromToken(token) {
  const exp = Number(decodeJwt(token)?.exp);
  if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  return Date.now() + 60 * 60 * 1000; // conservative fallback
}

export const nugsApi = {
  async login(email, password) {
    const body = new URLSearchParams({
      client_id:  NUGS_CLIENT_ID,
      grant_type: 'password',
      scope:      'openid profile email nugsnet:api nugsnet:legacyapi offline_access',
      username:   email,
      password:   password,
    });

    // ── Step 1: token endpoint ────────────────────────────────────────
    // Previously every failure here threw a generic `nugs:login_failed`,
    // collapsing distinct causes (bad creds, Cloudflare challenge, 2FA
    // required, network down, etc.) into one toast. Now each failure
    // mode raises its own typed error so the UI can show a useful
    // message AND so we log the upstream response body for diagnostics.
    let r;
    try {
      r = await fetch(`${NUGS_ID_URL}/connect/token`, {
        method:  'POST',
        headers: { 'User-Agent': NUGS_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      console.error('[nugs login] network error contacting id.nugs.net:', err);
      throw new Error('nugs:network');
    }
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 400); } catch { /* ignore */ }
      console.error('[nugs login] token endpoint:', r.status, r.statusText, '—', detail);
      // 400/401 are genuine auth failures from Nugs's OAuth server
      // (invalid_grant / invalid_client). Anything else is upstream.
      if (r.status === 400 || r.status === 401) throw new Error('nugs:login_failed');
      throw new Error(`nugs:auth_${r.status}`);
    }
    let tokens;
    try {
      tokens = await r.json();
    } catch {
      const txt = await r.text().catch(() => '');
      console.error('[nugs login] non-JSON token response (likely Cloudflare challenge):', txt.slice(0, 400));
      throw new Error('nugs:bad_response');
    }
    if (!tokens?.access_token) {
      console.error('[nugs login] token response missing access_token:', tokens);
      throw new Error('nugs:bad_response');
    }

    // Decode JWT payload for legacy fields + the real `exp` claim
    const jwtPayload = decodeJwt(tokens.access_token);

    // ── Step 2: userinfo + subscriptions ──────────────────────────────
    // Both endpoints can return HTML error pages or 401s if Nugs's WAF
    // intercepts the bearer token. Catch each independently so a
    // userinfo glitch doesn't blame the subscription check (and vice
    // versa). The JSON parse is the most common silent-failure point.
    const fetchJson = async (url, label) => {
      let resp;
      try {
        resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'User-Agent': NUGS_UA },
        });
      } catch (err) {
        console.error(`[nugs login] ${label} network error:`, err);
        throw new Error('nugs:network');
      }
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.error(`[nugs login] ${label} returned ${resp.status}:`, txt.slice(0, 400));
        throw new Error(`nugs:auth_${resp.status}`);
      }
      try {
        return await resp.json();
      } catch {
        const txt = await resp.text().catch(() => '');
        console.error(`[nugs login] ${label} non-JSON response:`, txt.slice(0, 400));
        throw new Error('nugs:bad_response');
      }
    };

    const [userInfo, subsArr] = await Promise.all([
      fetchJson(`${NUGS_ID_URL}/connect/userinfo`, 'userinfo'),
      fetchJson(`${NUGS_SUBS_URL}/api/v1/me/subscriptions`, 'subscriptions'),
    ]);

    const sub    = Array.isArray(subsArr) ? subsArr[0] : (subsArr?.subscriptions?.[0] ?? subsArr);
    const planId = sub?.plan?.planId ?? sub?.promo?.plan?.planId ?? '';
    if (!sub?.isContentAccessible) {
      console.error('[nugs login] subscription not accessible — sub payload:', sub);
      throw new Error('nugs:no_subscription');
    }

    nugsAuth.set({
      access_token:    tokens.access_token,
      refresh_token:   tokens.refresh_token,
      expires_at:      expiryFromToken(tokens.access_token),
      legacy_token:    jwtPayload.legacyToken  ?? '',
      legacy_uguid:    jwtPayload.legacyUguid  ?? '',
      user_id:         userInfo.sub            ?? '',
      plan_id:         String(planId),
      subscription_id: String(sub?.legacySubscriptionId ?? ''),
      start_stamp:     sub?.startedAt ? Math.floor(parseNugsDate(sub.startedAt)) : 0,
      end_stamp:       sub?.endsAt    ? Math.floor(parseNugsDate(sub.endsAt))    : 0,
    });
  },

  /** Page size used by both `catalog()` and the renderer's pagination loop.
   *  Exported so the loop's "did we get a full page?" check stays in sync. */
  CATALOG_PAGE_SIZE: 500,

  async catalog(artistId, offset = 1) {
    const auth = nugsAuth.get();
    const url  = `${NUGS_STREAM}/api.aspx?method=catalog.containersAll`
      + `&artistList=${artistId}&limit=${nugsApi.CATALOG_PAGE_SIZE}`
      + `&startOffset=${offset}&availType=1&vdisp=1`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': NUGS_UA,
        ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}),
      },
    });
    if (!r.ok) throw new Error(`nugs catalog ${r.status}`);
    const text = await r.text();
    if (text.trimStart().startsWith('<')) throw new Error('nugs:unauthenticated');
    try { return JSON.parse(text); }
    catch { throw new Error('nugs:bad-response'); }
  },

  /** Probe: globally-recent containers across the entire Nugs catalog.
   *  Tries `catalog.containersAll` with no artistList filter — the streamapi
   *  may or may not honour this. Returns an empty array on failure so the
   *  welcome view can fall back to a per-pinned-artist derivation. */
  async recentlyAddedGlobal({ limit = 12 } = {}) {
    const auth = nugsAuth.get();
    const url  = `${NUGS_STREAM}/api.aspx?method=catalog.containersAll`
      + `&limit=${limit}&startOffset=1&availType=1&vdisp=1&sortBy=dateAddedDesc`;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': NUGS_UA,
          ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}),
        },
      });
      if (!r.ok) return [];
      const text = await r.text();
      if (text.trimStart().startsWith('<')) return []; // auth wall
      const data = JSON.parse(text);
      const containers = data?.Response?.containers ?? data?.response?.containers ?? [];
      return containers;
    } catch (err) {
      console.warn('[nugs] recentlyAddedGlobal failed:', err.message);
      return [];
    }
  },

  async release(containerId) {
    const auth = nugsAuth.get();
    const url  = `${NUGS_STREAM}/api.aspx?method=catalog.container&containerID=${containerId}&vdisp=1`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': NUGS_UA,
        ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}),
      },
    });
    if (!r.ok) throw new Error(`nugs release ${r.status}`);
    const text = await r.text();
    if (text.trimStart().startsWith('<')) throw new Error('nugs:unauthenticated');
    try { return JSON.parse(text); }
    catch { throw new Error('nugs:bad-response'); }
  },

  async streamUrl(trackId) {
    const auth = nugsAuth.get();
    if (!auth) throw new Error('nugs:unauthenticated');
    const base = {
      app:                     '1',
      subscriptionID:          auth.subscription_id,
      subCostplanIDAccessList: auth.plan_id,
      nn_userID:               auth.user_id,
      startDateStamp:          String(auth.start_stamp),
      endDateStamp:            String(auth.end_stamp),
    };
    let lastData = null;
    for (const platformID of [1, 10, 4, 7]) {
      const params = new URLSearchParams({ platformID, trackID: trackId, ...base });
      const r = await fetch(`${NUGS_STREAM}/bigriver/subPlayer.aspx?${params}`,
        { headers: { 'User-Agent': NUGS_UA_PLAYER } });
      if (!r.ok) throw new Error(`nugs stream ${r.status}`);
      const data = await r.json();
      const url  = data.streamLink ?? data.StreamLink ?? null;
      if (url) return url;
      lastData = data;
    }
    console.warn('[api] streamUrl null for trackId', trackId, 'last response:', lastData);
    const policy = lastData?.policyMessage ?? lastData?.PolicyMessage ?? lastData?.message ?? lastData?.Message;
    if (policy) throw new Error(`nugs:policy:${policy}`);
    return null;
  },

  async vidStreamUrl(skuId, containerId) {
    const auth = nugsAuth.get();
    if (!auth) throw new Error('nugs:unauthenticated');
    const params = new URLSearchParams({
      skuId, containerID: containerId, chap: '1', app: '1',
      subscriptionID:          auth.subscription_id,
      subCostplanIDAccessList: auth.plan_id,
      nn_userID:               auth.user_id,
      startDateStamp:          String(auth.start_stamp),
      endDateStamp:            String(auth.end_stamp),
    });
    const r = await fetch(`${NUGS_STREAM}/bigriver/subPlayer.aspx?${params}`,
      { headers: { 'User-Agent': NUGS_UA_PLAYER } });
    if (!r.ok) throw new Error(`nugs vid ${r.status}`);
    const data = await r.json();
    return data.streamLink ?? data.StreamLink ?? null;
  },

  async allArtists() {
    if (nugsApi._artistCache) return nugsApi._artistCache;
    const auth = nugsAuth.get();
    const headers = {
      'User-Agent': NUGS_UA,
      ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}),
    };
    let all = [], offset = 1, batch;
    do {
      const r = await fetch(
        `${NUGS_STREAM}/api.aspx?method=catalog.artists&limit=500&startOffset=${offset}`,
        { headers });
      if (!r.ok) break;
      const data = await r.json();
      batch = data?.Response?.artists ?? [];
      all   = all.concat(batch);
      offset += 500;
    } while (batch.length === 500);
    nugsApi._artistCache = all;
    return all;
  },

  searchArtists(query) {
    const q = query.toLowerCase().trim();
    return (nugsApi._artistCache ?? [])
      .filter(a => a.artistName?.toLowerCase().includes(q))
      .slice(0, 20)
      .map(a => ({ id: String(a.artistID), name: a.artistName, numShows: a.numShows ?? 0 }));
  },

  async refresh() {
    const auth = nugsAuth.get();
    if (!auth?.refresh_token) return { ok: false, reason: 'no_refresh_token' };
    const body = new URLSearchParams({
      client_id:     NUGS_CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: auth.refresh_token,
    });
    let r;
    try {
      r = await fetch(`${NUGS_ID_URL}/connect/token`, {
        method:  'POST',
        headers: { 'User-Agent': NUGS_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      // Network blip — keep cached token, caller can retry on next interval tick
      console.warn('[nugs] refresh network error:', err);
      return { ok: false, reason: 'network', err };
    }
    if (r.ok) {
      const tokens = await r.json();
      nugsAuth.set({
        ...auth,
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token ?? auth.refresh_token,
        expires_at:    expiryFromToken(tokens.access_token),
      });
      return { ok: true };
    }
    // 4xx from id.nugs.net — refresh token is invalid/expired. Log out so the
    // Settings UI can prompt for re-auth instead of silently looping forever.
    console.warn('[nugs] refresh rejected by server:', r.status);
    if (r.status >= 400 && r.status < 500) {
      nugsAuth.clear();
      try {
        window.dispatchEvent(new CustomEvent('nugs:logged-out', { detail: { reason: 'refresh_rejected' } }));
      } catch {}
      return { ok: false, reason: 'rejected', status: r.status };
    }
    return { ok: false, reason: 'server_error', status: r.status };
  },
};
