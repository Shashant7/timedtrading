// tt-rail-lazy-load.js — defer ~880KB right-rail bundle until first use or idle prefetch.
(function () {
  if (typeof window === "undefined") return;

  var _ready = null;
  var _bust = "";
  try {
    var _cur = document.currentScript;
    if (_cur && _cur.src) {
      var _m = _cur.src.match(/[?&]v=([^&]+)/);
      if (_m) _bust = "?v=" + _m[1];
    }
  } catch (_) {}
  var RAIL_SCRIPTS = [
    "/vendor/lightweight-charts.standalone.production.js?v=vendor",
    "shared-rail-helpers.js" + _bust,
    "shared-verdict-ui.js" + _bust,
    "shared-right-rail.compiled.js" + _bust,
    "ticker-spider-chart.js" + _bust,
    "shared-rail-bootstrap.js" + _bust,
  ];

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-tt-rail-src="' + src + '"]')) {
        resolve();
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.dataset.ttRailSrc = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("rail script failed: " + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  window.ensureTimedRightRail = function ensureTimedRightRail() {
    if (window.TimedRightRail && window.TimedRightRail.Overlay) {
      return Promise.resolve(window.TimedRightRail);
    }
    if (!_ready) {
      _ready = RAIL_SCRIPTS.reduce(function (chain, src) {
        return chain.then(function () { return loadScript(src); });
      }, Promise.resolve()).catch(function (err) {
        _ready = null;
        throw err;
      });
    }
    return _ready;
  };
})();
