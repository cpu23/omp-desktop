// Connection page for the omp-desktop shell.
//
// The Linux shell serves this embedded page as omp://bootstrap/index.html and
// exposes only the reply-capable ompDesktopConnect bridge here. Tauri retains
// its narrowly scoped `connect` command on macOS and Windows.
(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var detailEl = document.getElementById("detail");
  var retryEl = document.getElementById("retry");
  var running = false;

  function invoke(command) {
    var webkit = window.webkit;
    var handler = webkit && webkit.messageHandlers && webkit.messageHandlers.ompDesktopConnect;
    if (handler && typeof handler.postMessage === "function") {
      return handler.postMessage(command);
    }
    var internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === "function") {
      return internals.invoke(command);
    }
    return Promise.reject(new Error("Native connection bridge is unavailable on this page"));
  }

  function describe(error) {
    if (error && typeof error === "object" && typeof error.message === "string") {
      return error.message;
    }
    return String(error);
  }

  function showFailure(error) {
    statusEl.textContent = "Cannot reach the omp-desktop daemon.";
    detailEl.textContent = describe(error);
    detailEl.hidden = false;
    retryEl.disabled = false;
    retryEl.hidden = false;
    running = false;
  }

  function connect() {
    if (running) {
      return;
    }
    running = true;
    retryEl.disabled = true;
    retryEl.hidden = true;
    detailEl.hidden = true;
    detailEl.textContent = "";
    statusEl.textContent = "Connecting to the omp-desktop daemon…";

    invoke("connect").then(
      function (build) {
        // The shell navigates to the daemon as part of this call; this line
        // only covers the moment before the new page paints.
        statusEl.textContent = "Connected (build " + build + "). Opening the session…";
        running = false;
      },
      function (error) {
        showFailure(error);
      }
    );
  }

  retryEl.addEventListener("click", connect);

  var recoveryError = window.__OMP_DESKTOP_RECOVERY_ERROR__;
  if (typeof recoveryError === "string" && recoveryError.length > 0) {
    showFailure(recoveryError);
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
