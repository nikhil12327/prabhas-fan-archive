/* =====================================================================
   Prabhas — The Fan Archive : output-safety helpers
   Loaded as a classic script by index.html and public/admin/index.html
   BEFORE backend.js / admin.js, and importable by scripts/test-sanitize.mjs.

   Everything rendered from the database or a URL parameter is untrusted:
   wishes, captions, leaderboard names, product copy, storage paths, emails.
   These helpers are the canonical encoders for every such sink.
   ===================================================================== */
(function (root) {
  'use strict';

  /* "&" built at runtime so this file survives tooling that decodes HTML
     entities — the five replacements below must stay literal in the file. */
  var AMP = String.fromCharCode(38); // &
  function ent(name) { return AMP + name + ';'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      if (c === '&') return ent('amp');
      if (c === '<') return ent('lt');
      if (c === '>') return ent('gt');
      if (c === '"') return ent('quot');
      return ent('#39'); // single quote
    });
  }

  /* Remove control characters (0x00-0x20, 0x7F) and whitespace. Written as
     a charCode loop on purpose: it cannot be defeated by tab/newline forms
     like "java<LF>script:" and it never needs a fragile character class. */
  function stripControl(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code <= 32 || code === 127) continue;
      out += s.charAt(i);
    }
    return out;
  }

  /**
   * Allow-list URL sanitiser for values placed into href/src.
   * Returns the URL when it is safe to render, otherwise ''.
   *   - same-origin paths (starts with a single "/") are allowed
   *   - http, https, mailto, tel and upi schemes are allowed
   *   - javascript:, data:, vbscript: and every other scheme are rejected,
   *     after control characters and whitespace are stripped, so
   *     "java<tab>script:" and " JAVASCRIPT:" are caught too
   *   - protocol-relative URLs (//evil.com) are rejected
   */
  function safeUrl(u) {
    var raw = stripControl(String(u == null ? '' : u));
    if (!raw) return '';
    if (raw.charAt(0) === '/' && raw.charAt(1) !== '/') return raw; // /path
    if (raw.indexOf('./') === 0) return raw;
    if (raw.indexOf('../') === 0) return raw;
    if (raw.indexOf('//') === 0) return '';                          // protocol-relative
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    if (!m) return '';                                               // scheme-less junk
    var scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' ||
        scheme === 'upi' || scheme === 'tel') {
      return raw;
    }
    return '';
  }

  /**
   * Storage-object path guard: only a single filename segment made of
   * [A-Za-z0-9._-], no traversal, no slash, no quote, bounded length.
   * Returns the path or ''.
   */
  function safePath(p) {
    var s = String(p == null ? '' : p);
    if (!s || s.length > 140) return '';
    if (s.indexOf('..') !== -1) return '';
    if (s.indexOf('/') !== -1) return '';
    if (s.indexOf('\\') !== -1) return '';
    return /^[A-Za-z0-9._-]+$/.test(s) ? s : '';
  }

  /** Coerce anything from the database to a finite number (or 0). */
  function num(n) {
    var v = Number(n);
    return isFinite(v) ? v : 0;
  }

  var api = { esc: esc, safeUrl: safeUrl, safePath: safePath, num: num };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ArchiveSanitize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
