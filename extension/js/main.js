(function () {
  "use strict";

  var button = document.getElementById("add-layer");
  var status = document.getElementById("status");
  var pending = false;
  var clearTimer = null;

  // Resolves the extension folder on any Windows install location: the
  // per-user folder, the all-users "Program Files (x86)\Common Files" folder,
  // user names with spaces or non-English characters, and network (UNC) paths.
  function extensionRoot() {
    var path = "";
    var cep = window.__adobe_cep__;
    if (cep && typeof cep.getSystemPath === "function") {
      try {
        path = String(cep.getSystemPath("extension") || "");
        try { path = decodeURI(path); } catch (eDecode) {}
        path = path.replace(/^file:\/\/\/(?=[A-Za-z]:)/i, "");
        path = path.replace(/^file:/i, "");
      } catch (eSystem) {
        path = "";
      }
    }
    if (!path) {
      var pathname = window.location.pathname;
      try { pathname = decodeURIComponent(pathname); } catch (eDecode2) {}
      var host = window.location.host || "";
      if (host) {
        path = "//" + host + pathname;
      } else {
        path = pathname.replace(/^\/+(?=[A-Za-z]:)/, "");
      }
      path = path.replace(/\/index\.html?$/i, "");
    }
    path = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return path;
  }

  // ExtendScript receives the call as source text; escaping every non-ASCII
  // character keeps paths intact regardless of the PC's code page.
  function scriptString(value) {
    var json = JSON.stringify(String(value));
    var out = "";
    for (var i = 0; i < json.length; i++) {
      var code = json.charCodeAt(i);
      out += code > 126 ? "\\u" + ("0000" + code.toString(16)).slice(-4) : json.charAt(i);
    }
    return out;
  }

  function donorPath() {
    return extensionRoot() + "/jsx/OpenClickLayerDonor.xml";
  }

  function presetPath() {
    return extensionRoot() + "/presets/Transform(openClick).prfpset";
  }

  function show(message, kind) {
    status.textContent = message;
    status.className = kind || "";
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (message) {
      clearTimer = setTimeout(function () {
        status.textContent = "";
        status.className = "";
        clearTimer = null;
      }, kind === "error" ? 8000 : 4500);
    }
  }

  function setBusy(value) {
    pending = value;
    button.disabled = value;
    button.classList.toggle("busy", value);
    button.setAttribute("aria-busy", value ? "true" : "false");
  }

  function finish(message, kind) {
    setBusy(false);
    show(message, kind);
  }

  function click(event) {
    if (pending) {
      return;
    }

    var combined = !!(event && event.shiftKey);

    var cep = window.__adobe_cep__;
    if (!cep || typeof cep.evalScript !== "function") {
      finish("The Premiere bridge is unavailable. Reopen the panel.", "error");
      return;
    }

    setBusy(true);
    show(combined ? "Adding a combined adjustment layer\u2026" : "Adding adjustment layer\u2026", "pending");

    var settled = false;
    var timeout = setTimeout(function () {
      if (settled) {
        return;
      }
      settled = true;
      finish("Premiere did not respond. Try again.", "error");
    }, 30000);

    var script = "OpenClick.createAdjustmentLayer(" + scriptString(donorPath()) + ", " + (combined ? "true" : "false") + ", " + scriptString(presetPath()) + ")";

    try {
      cep.evalScript(script, function (raw) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);

        var data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          data = null;
        }

        if (!data) {
          finish("Premiere did not respond. Try again.", "error");
          return;
        }
        if (data.ok) {
          finish(data.message || "Adjustment layer added.", "ok");
        } else {
          finish(data.message || "The adjustment layer could not be added.", "error");
        }
      });
    } catch (e) {
      settled = true;
      clearTimeout(timeout);
      finish("Premiere did not respond. Try again.", "error");
    }
  }

  button.addEventListener("click", click);
})();
