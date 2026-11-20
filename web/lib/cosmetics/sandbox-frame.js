// The sandboxed iframe's only script (/cosmetics-sandbox.html, sandbox="allow-scripts" → an opaque origin, its CSP
// allows no network, no images, no styles). It starts the pack code's module worker from the source the app page hands
// over once, with a MessageChannel port, and relays: page → worker, worker → page (pictures as ImageData – see canvas-proxy.mjs).
// See web/lib/cosmetics/sandbox.mjs.
/* global addEventListener, parent, Worker */
(function () {
  'use strict';
  var started = false;
  addEventListener('message', function (e) {
    var d = e.data;
    if (started || e.source !== parent || !d || d.op !== 'souldew-sandbox' || typeof d.source !== 'string' || !e.ports || !e.ports[0]) return;
    started = true;
    var port = e.ports[0];
    // a data: URL – a blob: URL made in an opaque origin can't start a worker in Chromium; the worker gets an opaque
    // origin of its own either way
    var url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(d.source);
    var worker = new Worker(url, { type: 'module', name: typeof d.name === 'string' ? d.name.slice(0, 40) : 'souldew-cosmetics' });
    worker.onmessage = function (m) { port.postMessage(m.data); };
    worker.onerror = function (err) {
      port.postMessage({ op: '__souldew_error', message: String((err && err.message) || 'worker error') });
      if (err && err.preventDefault) err.preventDefault();
    };
    port.onmessage = function (m) {
      var x = m.data;
      if (x && x.op === '__souldew_terminate') {
        worker.terminate();
        port.close();
        return;
      }
      worker.postMessage(x);
    };
  });
  parent.postMessage({ op: 'souldew-sandbox-ready' }, '*');
})();
