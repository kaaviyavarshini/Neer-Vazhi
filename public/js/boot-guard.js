/**
 * web/js/boot-guard.js
 * Classic (non-module) script, loaded FIRST on every page so it still works when
 * a CDN script or ES module fails to load. Turns silent failures into an on-screen
 * message instead of a black page / endless spinner:
 *   - a <script> (Cesium, Three, our own modules) that fails to load
 *   - any uncaught runtime error or unhandled promise rejection
 *   - a watchdog: the app never called window.__bootReady() within 25 s
 * Pages call window.__bootReady() once loading has finished, and
 * window.__bootFail(message) to report a handled failure.
 */
(function () {
  'use strict';

  var WATCHDOG_MS = 25000;
  var ready = false;
  var box = null;
  var list = null;
  var shown = {};

  function ensureBox() {
    if (box) return;
    box = document.createElement('div');
    box.id = 'boot-error';
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;' +
      'width:min(640px,calc(100vw - 24px));box-sizing:border-box;padding:14px 16px;' +
      'background:#7f1d1d;border:1px solid #ef4444;border-radius:8px;color:#fff;' +
      'font:13px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.6)';

    var title = document.createElement('strong');
    title.textContent = 'Something failed to load';
    title.style.cssText = 'display:block;margin-bottom:6px;font-size:14px';

    list = document.createElement('ul');
    list.style.cssText = 'margin:0 0 10px 18px;padding:0;word-break:break-word';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.style.cssText =
      'background:#fff;color:#7f1d1d;border:0;border-radius:4px;padding:6px 14px;' +
      'font:600 13px inherit;cursor:pointer';
    btn.addEventListener('click', function () { location.reload(); });

    box.appendChild(title);
    box.appendChild(list);
    box.appendChild(btn);
    (document.body || document.documentElement).appendChild(box);
  }

  function report(msg) {
    msg = String(msg || '').trim();
    if (!msg || shown[msg]) return;
    shown[msg] = true;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { shown[msg] = false; report(msg); });
      return;
    }
    ensureBox();
    var li = document.createElement('li');
    li.textContent = msg; // textContent: never interpret messages as HTML
    list.appendChild(li);
    if (window.console) console.error('[boot-guard] ' + msg);
  }

  // Resource load failures don't bubble, so listen in the capture phase.
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      var url = t.src || t.href || '';
      if (t.tagName === 'SCRIPT' ||
          (t.tagName === 'LINK' && /stylesheet/i.test(t.rel) && !/fonts\.(googleapis|gstatic)\.com/.test(url))) {
        if (url) {
          report('Could not load ' + url + ' — check your internet connection, any ad/content blocker, or that the file exists.');
        } else {
          // Inline module whose import failed: the browser gives no URL for it.
          report('A page script could not start because a library it imports failed to download ' +
                 '(usually cdn.jsdelivr.net being blocked or offline). Check your internet connection ' +
                 'or ad/content blocker, then reload.');
        }
      }
      return;
    }
    var m = e.message || '';
    if (/ResizeObserver loop/.test(m)) return; // harmless browser noise
    var where = e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '';
    report((m || 'Unknown script error') + where);
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('Unhandled error: ' + (r && r.message ? r.message : r));
  });

  window.__bootFail = report;
  window.__bootReady = function () { ready = true; clearTimeout(timer); };

  var timer = setTimeout(function () {
    if (!ready) {
      report('Still loading after ' + (WATCHDOG_MS / 1000) + ' s — something is stuck. ' +
             'Open DevTools (F12) and check the Console and Network tabs.');
    }
  }, WATCHDOG_MS);
})();
