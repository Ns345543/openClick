(function () {
  "use strict";

  var layerButton = document.getElementById("add-layer");
  var nestButton = document.getElementById("nest-clips");
  var statusLine = document.getElementById("status");
  var pending = false;

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

  function log(message, kind) {
    if (!message || !window.console) {
      return;
    }
    var method = kind === "error" ? console.error : console.log;
    if (typeof method === "function") {
      method.call(console, "openClick: " + message);
    }
  }

  function setBusy(value) {
    pending = value;
    var buttons = [layerButton, nestButton];
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      if (!button) {
        continue;
      }
      button.disabled = value;
      button.classList.toggle("busy", value);
      button.setAttribute("aria-busy", value ? "true" : "false");
    }
  }

  function showStatus(message, kind) {
    if (!statusLine) {
      return;
    }
    if (!message) {
      statusLine.textContent = "";
      statusLine.className = "status";
      statusLine.hidden = true;
      return;
    }
    statusLine.textContent = message;
    statusLine.className = kind ? "status " + kind : "status";
    statusLine.hidden = false;
  }

  function finish(message, kind) {
    setBusy(false);
    showStatus(message, kind);
    log(message, kind);
  }

  function replyText(raw) {
    var text = raw === undefined || raw === null ? "" : String(raw);
    text = text.replace(/\s+/g, " ").trim();
    if (text === "undefined" || text === "null") {
      return "";
    }
    return text.length > 400 ? text.slice(0, 400) + "..." : text;
  }

  function run(script, timeoutMs, fallback) {
    if (pending) {
      return;
    }

    showStatus("");

    var cep = window.__adobe_cep__;
    if (!cep || typeof cep.evalScript !== "function") {
      finish("The Premiere bridge is unavailable. Reopen the panel.", "error");
      return;
    }

    setBusy(true);

    var settled = false;
    var timeout = setTimeout(function () {
      if (settled) {
        return;
      }
      settled = true;
      finish("Premiere did not respond. Try again.", "error");
    }, timeoutMs);

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
          var reply = replyText(raw);
          finish(reply ? "Premiere replied: " + reply : "Premiere did not respond. Try again.", "error");
          return;
        }
        if (data.ok) {
          finish(data.message || fallback.ok, "ok");
        } else {
          var detail = data.message || fallback.error;
          if (data.code && data.code !== "OK") {
            detail += " (" + data.code + ")";
          }
          finish(detail, "error");
        }
      });
    } catch (e) {
      settled = true;
      clearTimeout(timeout);
      finish("Premiere did not respond. Try again.", "error");
    }
  }

  function addLayer(event) {
    if (pending) {
      return;
    }
    var combined = !!(event && event.shiftKey);
    var script = "OpenClick.createAdjustmentLayer(" + scriptString(donorPath()) + ", " + (combined ? "true" : "false") + ", " + scriptString(presetPath()) + ")";
    run(script, 30000, {
      ok: combined ? "Adjustment layer added across selected clips." : "Adjustment layer added.",
      error: "The adjustment layer could not be added."
    });
  }

  function nestClips(event) {
    if (pending) {
      return;
    }
    var combined = !!(event && event.shiftKey);
    var unnest = !!(event && event.altKey);
    var script = "OpenClick.nestClips(" + (combined ? "true" : "false") + ", " + (unnest ? "true" : "false") + ")";
    run(script, unnest ? 120000 : 60000, {
      ok: unnest ? "Unnested the nested clips." : (combined ? "Nested the selected clips into one clip." : "Nested the selected clips."),
      error: unnest ? "The clips could not be unnested." : "The clips could not be nested."
    });
  }

  if (layerButton) {
    layerButton.addEventListener("click", addLayer);
  }
  if (nestButton) {
    nestButton.addEventListener("click", nestClips);
  }
})();
