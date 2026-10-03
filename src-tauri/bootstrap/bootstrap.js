// Connection page for the omp-desktop shell.
//
// This page is served locally by Tauri (tauri://localhost). The only native
// call it makes is the narrowly scoped `connect` command (src/shell.rs): that
// verifies the daemon through GET /api/build, starts the omp-desktopd systemd
// user unit when nothing is listening, and then navigates this window to the
// daemon origin, where the existing web client runs same-origin. The remote
// daemon page has no access to any of this.
(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var detailEl = document.getElementById("detail");
  var retryEl = document.getElementById("retry");
  var running = false;

  function invoke(command) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("Tauri IPC is unavailable on this page"));
    }
    return internals.invoke(command);
  }

  function describe(error) {
    if (error && typeof error === "object" && typeof error.message === "string") {
      return error.message;
    }
    return String(error);
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
        statusEl.textContent = "Cannot reach the omp-desktop daemon.";
        detailEl.textContent = describe(error);
        detailEl.hidden = false;
        retryEl.disabled = false;
        retryEl.hidden = false;
        running = false;
      }
    );
  }

  retryEl.addEventListener("click", connect);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    connect();
  }
})();
