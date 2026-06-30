// tt-rail-lazy-load.js — defer ~880KB right-rail bundle until first use or idle prefetch.
(function () {
  if (typeof window === "undefined") return;

  var _ready = null;
  var RAIL_SCRIPTS = [
    "https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js",
    "shared-rail-helpers.js?v=20260614-pml-rank",
    "shared-right-rail.compiled.js?v=20260623f",
    "ticker-spider-chart.js?v=20260501a",
    "shared-rail-bootstrap.js?v=20260629-rail-flash",
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

// cache-bust:1782822622388:208136213
