/*
 * Open Suite portal header — the single, shared top navigation.
 *
 * Injected same-origin into every surface (the bridge portal itself, plus
 * Nextcloud, Meet, Element, Docs, Grist, ...) so navigation is identical
 * everywhere and lives in ONE place. Served same-origin so it satisfies strict
 * CSPs (e.g. Nextcloud's `script-src 'self'`); it builds DOM nodes and sets
 * styles via the `.style` API / an injected <style> block (not CSP-gated where
 * style-src allows 'unsafe-inline').
 *
 * The base domain is derived from the current host at runtime, so the SAME file
 * works on every app and every deployment without templating.
 *
 * Nav mirrors the portal's pageConfig.jsx:
 *   Home | Office(▾) | Meet | Chat | Tables | Wiki | Calendar
 * where Office is a dropdown that deep-links into Nextcloud.
 */
(function () {
  // Don't render when embedded in an iframe (e.g. an app shown inside the
  // portal) — only decorate top-level navigation.
  if (window.self !== window.top) return;

  var HEADER_ID = "ko-portal-header";
  var HEADER_HEIGHT = 48; // px

  // host = "meet.opensuite.ritzademo.com" -> base = "opensuite.ritzademo.com"
  var host = window.location.hostname;
  var base = host.indexOf(".") === -1 ? host : host.slice(host.indexOf(".") + 1);
  var origin = function (sub) { return window.location.protocol + "//" + sub + "." + base; };

  function suppressElementDeviceVerification() {
    if (host.indexOf("element.") !== 0) return;
    try {
      if (window.localStorage.getItem("must_verify_device") === "true") {
        window.localStorage.removeItem("must_verify_device");
      }
    } catch (e) {}

    if (!document.body) return;
    var bodyText = document.body.innerText || "";
    var reminderText =
      bodyText.indexOf("As of end of October 2026") !== -1 ||
      bodyText.indexOf("unverified devices will not be able") !== -1;
    if (reminderText) {
      var buttons = document.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) {
        var label = (buttons[i].innerText || "").trim();
        if (label !== "Later" && label !== "Continue") continue;
        var node = buttons[i];
        while (node && node !== document.body) {
          var text = node.innerText || "";
          var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
          var isSmallDialog = rect.width >= 240 && rect.width <= 900 && rect.height >= 120 && rect.height <= 650;
          if (
            isSmallDialog &&
            text.indexOf("Verify this device") !== -1 &&
            (
              text.indexOf("As of end of October 2026") !== -1 ||
              text.indexOf("unverified devices will not be able") !== -1
            )
          ) {
            if (node.parentNode) node.parentNode.removeChild(node);
            break;
          }
          node = node.parentElement;
        }
      }
    }

    var isVerificationPage =
      document.querySelector(".mx_CompleteSecurityBody") ||
      bodyText.indexOf("Confirm your digital identity") !== -1 ||
      (bodyText.indexOf("Verify this device to set up secure messaging") !== -1);

    if (!isVerificationPage) return;
    try {
      if (window.sessionStorage.getItem("ko-skipped-element-verification") !== "1") {
        window.sessionStorage.setItem("ko-skipped-element-verification", "1");
        window.location.replace(window.location.origin + window.location.pathname + window.location.search);
      }
    } catch (e) {
      window.location.replace(window.location.origin + window.location.pathname + window.location.search);
    }
  }

  suppressElementDeviceVerification();

  // Office dropdown deep-links into the Nextcloud Office overview sections.
  // The hash is handled below because the stock Office overview keeps its
  // selected section in Vue component state instead of the URL.
  var OFFICE_CHILDREN = [
    { label: "Documents", path: "/apps/office/#documents" },
    { label: "Spreadsheets", path: "/apps/office/#spreadsheets" },
    { label: "Presentations", path: "/apps/office/#presentations" },
    { label: "Diagrams", path: "/apps/office/#diagrams" },
    { label: "Files", path: "/apps/files/files" },
    { label: "Contacts", path: "/apps/contacts" },
    { label: "Projects", path: "/apps/deck/" },
  ];

  // sub = subdomain the item points at; used both for the href and to mark the
  // currently-active app.
  var NAV = [
    { label: "Home", sub: "bridge" },
    { label: "Office", sub: "nextcloud", children: OFFICE_CHILDREN },
    { label: "Meet", sub: "meet" },
    { label: "Chat", sub: "element" },
    { label: "Tables", sub: "grist" },
    { label: "Wiki", sub: "docs" },
    { label: "Calendar", sub: "nextcloud", path: "/apps/calendar" },
  ];

  function injectStyles() {
    if (document.getElementById(HEADER_ID + "-styles")) return;
    var s = document.createElement("style");
    s.id = HEADER_ID + "-styles";
    s.textContent = [
      "#" + HEADER_ID + "{position:fixed;top:0;left:0;right:0;height:" + HEADER_HEIGHT + "px;",
      "z-index:2147483647;display:flex;align-items:center;gap:2px;padding:0 14px;",
      "background:#0b1f33;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;",
      "font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,.25);box-sizing:border-box;}",
      "#" + HEADER_ID + " .ko-brand{display:flex;align-items:center;gap:8px;font-weight:700;margin-right:12px;color:#fff;text-decoration:none;}",
      "#" + HEADER_ID + " .ko-brand .ko-mark{width:26px;height:26px;border-radius:6px;background:#ff5b39;color:#1a1a1a;",
      "display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;}",
      "#" + HEADER_ID + " .ko-item{position:relative;}",
      "#" + HEADER_ID + " .ko-link{display:flex !important;align-items:center;gap:5px;color:#cdd6e0;text-decoration:none;",
      "padding:6px 10px;border-radius:6px;white-space:nowrap;cursor:pointer;background:none;border:0;font:inherit;}",
      "#" + HEADER_ID + " .ko-link:hover{background:rgba(255,255,255,.10);color:#fff;}",
      "#" + HEADER_ID + " .ko-link.ko-active{background:rgba(255,255,255,.16);color:#fff;font-weight:600;}",
      "#" + HEADER_ID + " .ko-caret{font-size:10px;opacity:.8;}",
      "#" + HEADER_ID + " .ko-menu{position:absolute;top:calc(100% + 4px);left:0;min-width:180px;",
      "background:#10263d;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px;",
      "box-shadow:0 6px 24px rgba(0,0,0,.35);display:none;flex-direction:column;gap:2px;}",
      "#" + HEADER_ID + " .ko-item.ko-open .ko-menu{display:flex;}",
      "#" + HEADER_ID + " .ko-menu a{color:#cdd6e0;text-decoration:none;padding:8px 10px;border-radius:6px;white-space:nowrap;}",
      "#" + HEADER_ID + " .ko-menu a:hover{background:rgba(255,255,255,.10);color:#fff;}",
      // The bar overlays the top of apps (no document offset), so full-height
      // apps like Nextcloud Calendar keep their full viewport and their popovers
      // aren't clipped. On the bridge portal we instead hide its built-in nav
      // and push content down, since our bar replaces that nav entirely.
      "html.ko-on-bridge .ant-layout-header{display:none !important;}",
      "html.ko-on-bridge body{padding-top:" + HEADER_HEIGHT + "px !important;}",
      // Element fills the viewport (#matrixchat = 100vh) and puts controls at the
      // very top, which the overlay would cover — push it below the bar and
      // shrink it so nothing (room search, message composer) is hidden or cut.
      "html.ko-on-element #matrixchat{margin-top:" + HEADER_HEIGHT + "px !important;height:calc(100vh - " + HEADER_HEIGHT + "px) !important;}",
      // Nextcloud Calendar's new-event popover sizes its max-height as
      // (100vh - its top), but NC's own 50px header offsets the real top, so the
      // popover renders ~50px too tall and its footer (Save) falls off-screen.
      // Pin it just below our bar and bound its height to the viewport; NC's
      // __content already scrolls. (NC-only class, no-op elsewhere.)
      ".event-popover{top:60px !important;max-height:calc(100vh - 76px) !important;}",
    ].join("");
    document.head.appendChild(s);
  }

  function isActive(item) {
    if (host.indexOf(item.sub + ".") !== 0) return false;
    if (item.path) return window.location.pathname.indexOf(item.path) === 0;
    // Office (nextcloud, no path): active on nextcloud except the calendar path.
    if (item.children) return window.location.pathname.indexOf("/apps/calendar") !== 0;
    return true;
  }

  function buildItem(item) {
    var wrap = document.createElement("div");
    wrap.className = "ko-item";

    if (item.children) {
      var btn = document.createElement("span");
      btn.className = "ko-link" + (isActive(item) ? " ko-active" : "");
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.innerHTML = item.label + ' <span class="ko-caret">▾</span>';
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        wrap.classList.toggle("ko-open");
      });
      wrap.appendChild(btn);

      var menu = document.createElement("div");
      menu.className = "ko-menu";
      item.children.forEach(function (child) {
        var a = document.createElement("a");
        a.href = origin(item.sub) + child.path;
        a.textContent = child.label;
        if (child.path.indexOf("/apps/office/#") === 0) {
          a.addEventListener("click", function () {
            try {
              window.sessionStorage.setItem(
                "ko-office-section",
                child.path.replace(/^\/apps\/office\/#\/?/, "")
              );
            } catch (e) {}
          });
        }
        menu.appendChild(a);
      });
      wrap.appendChild(menu);
    } else {
      var link = document.createElement("a");
      link.className = "ko-link" + (isActive(item) ? " ko-active" : "");
      link.href = origin(item.sub) + (item.path || "");
      link.textContent = item.label;
      wrap.appendChild(link);
    }
    return wrap;
  }

  function mount() {
    if (document.getElementById(HEADER_ID)) return;
    if (!document.body) return;
    injectStyles();
    // On the bridge portal, take over from its built-in nav (hide it + offset).
    if (host.indexOf("bridge.") === 0) {
      document.documentElement.classList.add("ko-on-bridge");
    } else if (host.indexOf("element.") === 0) {
      document.documentElement.classList.add("ko-on-element");
    }

    var bar = document.createElement("nav");
    bar.id = HEADER_ID;

    var brand = document.createElement("a");
    brand.className = "ko-brand";
    brand.href = origin("bridge");
    brand.innerHTML = '<span class="ko-mark">O</span><span>Open Suite</span>';
    bar.appendChild(brand);

    NAV.forEach(function (item) { bar.appendChild(buildItem(item)); });
    document.body.appendChild(bar);

    // Close any open dropdown when clicking elsewhere.
    document.addEventListener("click", function () {
      var open = bar.querySelector(".ko-item.ko-open");
      if (open) open.classList.remove("ko-open");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      suppressElementDeviceVerification();
      mount();
    });
  } else {
    suppressElementDeviceVerification();
    mount();
  }
  setInterval(function () {
    suppressElementDeviceVerification();
    mount();
  }, 1500);
})();

/*
 * Office overview ↔ URL hash.
 *
 * The stock `nextcloud/office` overview app has no router: the open section
 * (Documents / Spreadsheets / Presentations / Diagrams) is in-component Vue
 * state with no URL representation, so the page is always `/apps/office/#`
 * and a section can't be linked to. Rather than fork and rebuild the app, we
 * make the URL hash the source of truth: `#spreadsheets` selects the matching
 * sidebar entry, and clicking a section in the sidebar writes the hash back.
 * This is what makes the Office dropdown's `#<slug>` deep links work.
 *
 * Matched by the section's (English) sidebar label; a localized instance would
 * need the slugs mapped per locale.
 */
(function () {
  if (window.self !== window.top) return;
  if (window.location.pathname.indexOf("/apps/office") !== 0) return;

  function slugOf(el) { return (el.textContent || "").trim().toLowerCase(); }

  function navItems() {
    var nav = document.getElementById("app-navigation-vue");
    return nav ? nav.querySelectorAll('li[class*="app-navigation-entry"]') : [];
  }

  function requestedSection() {
    var hash = (window.location.hash || "").replace(/^#\/?/, "").trim().toLowerCase();
    if (hash) return hash;
    try {
      return (window.sessionStorage.getItem("ko-office-section") || "").trim().toLowerCase();
    } catch (e) {
      return "";
    }
  }

  function writeOfficeHash(slug) {
    if (!slug) return;
    var nextHash = "#" + slug;
    if (window.location.hash !== nextHash) {
      history.replaceState(null, "", nextHash);
    }
  }

  // Select the section named by the hash, retrying while the sidebar (which
  // renders only after the app's async template fetch) comes up.
  function applyFromHash() {
    var want = requestedSection();
    if (!want) return;
    var tries = 0;
    (function attempt() {
      var items = navItems();
      for (var i = 0; i < items.length; i++) {
        if (slugOf(items[i]) === want) {
          writeOfficeHash(want);
          // Already active → leave it, so we don't loop click→hashchange→click.
          if (items[i].className.indexOf("active") === -1) {
            (items[i].querySelector("a") || items[i]).click();
          }
          setTimeout(function () { writeOfficeHash(want); }, 0);
          setTimeout(function () { writeOfficeHash(want); }, 250);
          try {
            window.sessionStorage.removeItem("ko-office-section");
          } catch (e) {}
          return;
        }
      }
      if (tries++ < 40) setTimeout(attempt, 150); // up to ~6s for first paint
    })();
  }

  // Mirror sidebar clicks into the hash so the URL reflects the open section
  // (shareable, back-button friendly). replaceState (not `location.hash =`)
  // so we don't fire our own hashchange and re-click what was just clicked.
  function watchClicks() {
    var nav = document.getElementById("app-navigation-vue");
    if (!nav || nav.dataset.osHashBound) return;
    nav.dataset.osHashBound = "1";
    nav.addEventListener("click", function (e) {
      var li = e.target.closest && e.target.closest('li[class*="app-navigation-entry"]');
      if (!li || !nav.contains(li)) return;
      var slug = slugOf(li);
      writeOfficeHash(slug);
      setTimeout(function () { writeOfficeHash(slug); }, 0);
    });
  }

  window.addEventListener("hashchange", applyFromHash);
  applyFromHash();
  setInterval(watchClicks, 1000);
})();

/*
 * Calendar ↔ Meet integration (Nextcloud Calendar).
 *
 * Adds an "Add Meet link" button to the event editor's location field, fills a
 * Meet link by default on new events, and lets the user remove it (clear the
 * field) and re-add it (the button) — like Google Calendar + Meet.
 *
 * Rooms must be created via the Meet API (a bare URL isn't joinable) and that
 * needs the user's token. Nextcloud can't be iframed (frame-ancestors 'none'),
 * so the calendar is always top-level on the Nextcloud origin — we call a
 * same-origin endpoint in the `meetcal` Nextcloud app, which mints a `meet`
 * token for the user (user_oidc token exchange) and creates the room.
 */
(function () {
  if (!/\/apps\/calendar/.test(window.location.pathname)) return;

  var BTN_CLASS = "os-add-meet";

  // Ask the meetcal app to create/get a room for this event name (same origin).
  function ensureRoom(name, cb) {
    var token = (window.OC && window.OC.requestToken) || "";
    fetch("/apps/meetcal/room", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", requesttoken: token },
      body: JSON.stringify({ name: name }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { cb(j && j.url ? j.url : null); })
      .catch(function () { cb(null); });
  }

  // Set a value on a Vue-controlled field so the framework registers the change.
  // Nextcloud's location field is a <textarea>, so pick the matching prototype
  // (using HTMLInputElement's setter on a textarea throws "Illegal invocation").
  function setReactive(el, value) {
    var proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findLocationInput() {
    var inputs = document.querySelectorAll("input, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].getAttribute("placeholder") || "").toLowerCase();
      if (ph.indexOf("location") !== -1 || ph.indexOf("locatie") !== -1) return inputs[i];
    }
    return null;
  }

  function findTitle() {
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var ph = (inputs[i].getAttribute("placeholder") || "").toLowerCase();
      if (ph === "title" || ph === "titel") return (inputs[i].value || "").trim();
    }
    return "";
  }

  function addLink(loc, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    var title = findTitle() || "Meeting";
    ensureRoom(title, function (url) {
      if (btn) { btn.disabled = false; btn.textContent = "Add Meet link"; }
      if (url) setReactive(loc, url);
    });
  }

  function decorate() {
    var loc = findLocationInput();
    if (!loc) return;
    var wrap = loc.parentElement;
    if (!wrap || wrap.querySelector("." + BTN_CLASS)) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.textContent = "Add Meet link";
    btn.style.cssText =
      "margin-top:6px;font:inherit;cursor:pointer;border:1px solid #2160c4;" +
      "background:#2160c4;color:#fff;border-radius:6px;padding:4px 10px;";
    btn.addEventListener("click", function () { addLink(loc, btn); });
    wrap.appendChild(btn);

    // By default a fresh, empty event gets a link automatically (once).
    if (!loc.value && !loc.dataset.osAutofilled) {
      loc.dataset.osAutofilled = "1";
      addLink(loc, null);
    }
  }

  setInterval(decorate, 1000);
})();
