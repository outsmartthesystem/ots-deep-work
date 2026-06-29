// Google Analytics 4 (GA4) bootstrap for the Family Money Story Interview.
//
// The interview's Content Security Policy forbids inline <script> (script-src is
// 'self' + 'unsafe-eval' only), so the GA init that would normally sit inline in
// <head> lives here in a same-origin file instead. index.html loads this right
// after the async gtag.js loader. Measurement ID: G-4RW1Q6HN4M.

window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-4RW1Q6HN4M');

// ── Attribution capture (UTMs + Builder-funnel params) ───────────────────────
// GA4 already attributes the automatic page_view to the session's
// source/medium/campaign. We ALSO capture these from the URL so every custom
// funnel event can carry them as event params — and so attribution survives even
// though the whole interview happens on this one page.
//
// The "carry" params arrive from the marketing funnel (jaypbhakta.com/build →
// /build-next) and let GA4 break interview start/complete down by the marketing
// A/B variant (ab_hero) and the parent's Builder Gap result (builder_gap).
// Both sets are persisted in sessionStorage so they survive later turns / resume.
function captureParams(storageKey, keys, globalName) {
  var out = {};
  try {
    var params = new URLSearchParams(window.location.search);
    keys.forEach(function (k) {
      var v = params.get(k);
      if (v) out[k] = String(v).slice(0, 200);
    });
    if (Object.keys(out).length) {
      sessionStorage.setItem(storageKey, JSON.stringify(out));
    } else {
      // No params on this URL (a later interview step or a resume) — fall back to
      // whatever we captured earlier this session.
      try { out = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch (e) { out = {}; }
    }
  } catch (e) { out = {}; }
  window[globalName] = out;
  return out;
}

captureParams('ots_utm', ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'], 'OTS_UTM');
captureParams('ots_carry', ['builder_gap', 'age_band', 'entry_hook', 'ab_hero', 'path_variant'], 'OTS_CARRY');

// ── otsTrack: the one safe entry point for funnel events ─────────────────────
// Merges the captured attribution params onto every event so interview starts and
// completions can be broken down by utm_campaign, ab_hero, builder_gap, etc. in
// GA4. No-ops safely if gtag was blocked (e.g. an ad blocker) so analytics can
// never break the interview itself.
function storedParams(storageKey, globalName) {
  var v = (window[globalName] && Object.keys(window[globalName]).length) ? window[globalName] : null;
  if (!v) { try { v = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch (e) { v = {}; } }
  return v || {};
}
window.otsTrack = function (name, params) {
  try {
    var merged = Object.assign(
      {},
      storedParams('ots_utm', 'OTS_UTM'),
      storedParams('ots_carry', 'OTS_CARRY'),
      params || {}
    );
    if (typeof window.gtag === 'function') window.gtag('event', name, merged);
  } catch (e) { /* analytics must never break the interview */ }
};

// ── Booking-link click → funnel event ────────────────────────────────────────
// The Blueprint includes an <a> to the "Family Money Story Alignment Call"
// (Google Calendar). Capture clicks on it as cta_click_blueprint_review so the
// booking step is measurable. Capture phase + delegated on document so it works
// no matter when the Blueprint renders, and even if a handler stops propagation.
// Carries the attribution params automatically via otsTrack.
document.addEventListener('click', function (e) {
  try {
    var a = (e.target && e.target.closest) ? e.target.closest('a[href]') : null;
    if (a && /calendar\.app\.google|calendly\.com/i.test(a.href)) {
      window.otsTrack('cta_click_blueprint_review', { cta_position: 'blueprint' });
    }
  } catch (err) { /* never break the interview */ }
}, true);

// Funnel step 1: landing page viewed. Distinct from GA4's automatic page_view so
// it carries the attribution params explicitly as event params.
window.otsTrack('interview_landing_view');
