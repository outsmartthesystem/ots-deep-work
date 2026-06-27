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

// ── UTM capture ──────────────────────────────────────────────────────────────
// GA4 already attributes the automatic page_view to the session's
// source/medium/campaign. We ALSO capture the UTMs here so every custom funnel
// event can carry them as event params, and so attribution survives even though
// the whole interview happens on this one page. Persisted in sessionStorage.
(function captureUtm() {
  try {
    var params = new URLSearchParams(window.location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    var utm = {};
    keys.forEach(function (k) {
      var v = params.get(k);
      if (v) utm[k] = String(v).slice(0, 200);
    });
    if (Object.keys(utm).length) {
      sessionStorage.setItem('ots_utm', JSON.stringify(utm));
    }
    window.OTS_UTM = utm;
  } catch (e) { window.OTS_UTM = {}; }
})();

// ── otsTrack: the one safe entry point for funnel events ─────────────────────
// Merges the captured UTMs onto every event so interview starts and completions
// can be broken down by utm_campaign in GA4. No-ops safely if gtag was blocked
// (e.g. an ad blocker) so analytics can never break the interview itself.
window.otsTrack = function (name, params) {
  try {
    var utm = (window.OTS_UTM && Object.keys(window.OTS_UTM).length) ? window.OTS_UTM : null;
    if (!utm) {
      try { utm = JSON.parse(sessionStorage.getItem('ots_utm') || '{}'); } catch (e) { utm = {}; }
    }
    var merged = Object.assign({}, utm, params || {});
    if (typeof window.gtag === 'function') window.gtag('event', name, merged);
  } catch (e) { /* analytics must never break the interview */ }
};

// Funnel step 1: landing page viewed. Distinct from GA4's automatic page_view so
// it carries the UTM params explicitly as event params.
window.otsTrack('interview_landing_view');
