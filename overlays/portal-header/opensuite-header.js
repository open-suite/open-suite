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
 * This is the only menu definition. App integrations only arrange to execute
 * this asset same-origin; they do not carry their own navigation arrays.
 */
(function () {
  // Don't render when embedded in an iframe (e.g. an app shown inside the
  // portal) — only decorate top-level navigation.
  if (window.self !== window.top) return;

  var HEADER_ID = "ko-portal-header";
  // The deploy publisher replaces "source" with a content hash. That lets a
  // newer runtime asset replace an older image-baked header deterministically.
  var HEADER_VERSION = "source";
  var HEADER_HEIGHT = 48; // px
  var HEADER_HEIGHT_VAR = "--ko-header-height";
  var headerResizeObserver = null;
  document.documentElement.style.setProperty(HEADER_HEIGHT_VAR, HEADER_HEIGHT + "px");

  // host = "meet.opensuite.ritzademo.com" -> base = "opensuite.ritzademo.com"
  var host = window.location.hostname;
  var base = host.indexOf(".") === -1 ? host : host.slice(host.indexOf(".") + 1);
  var origin = function (sub) { return window.location.protocol + "//" + sub + "." + base; };

  // Prewarm the apps the user is most likely to open next, so the first click
  // skips DNS + TLS + TCP + HTTP/2 setup (typically 100-300ms on a cold
  // cross-subdomain hop) and the app's ingress/pod is already awake.
  //
  // Only preconnect: a single idle keep-alive socket per origin, which the
  // browser reaps on its own — no bytes fetched, no measurable cost if the
  // user never navigates. We deliberately do NOT prerender the pages: that
  // would download and boot each SPA in the background (a real cost the user
  // would feel), and cross-subdomain prerender needs a per-app
  // Supports-Loading-Mode opt-in header and still can't pre-establish each
  // app's own OIDC session (SameSite=Lax blocks setting it from here). So the
  // login round-trip is unavoidable cross-origin; preconnect shaves the
  // connection setup off it. Portal page only.
  if (host.indexOf("bridge.") === 0) {
    var prewarm = function () {
      // Mail and Chat first (the ask); then the other subdomains a portal user
      // commonly jumps to. Keycloak too — every app's login round-trips it.
      ["messages", "element", "nextcloud", "meet", "docs", "grist", "id"].forEach(function (sub) {
        var l = document.createElement("link");
        l.rel = "preconnect";
        l.href = origin(sub);
        l.crossOrigin = "use-credentials"; // match the credentialed app navigations
        document.head.appendChild(l);
      });
    };
    if (window.requestIdleCallback) window.requestIdleCallback(prewarm, { timeout: 3000 });
    else setTimeout(prewarm, 1500);
  }

  // Demo resets used to delete and recreate the seeded direct-message room.
  // Element can retain those purged rooms in its local sync database even
  // after Synapse no longer returns them. 09-portal-header.sh enables this
  // one-time migration only on demo deployments. This is the same database
  // Element's own "Clear cache and reload" action deletes; auth and both
  // crypto databases are deliberately left intact.
  var ELEMENT_SYNC_MIGRATION = "";
  if (host.indexOf("element.") === 0 && ELEMENT_SYNC_MIGRATION) {
    var elementMigrationKey = "opensuite.element.sync-migration";
    var elementSyncDatabase = "matrix-js-sdk:riot-web-sync";
    try {
      if (window.localStorage.getItem(elementMigrationKey) !== ELEMENT_SYNC_MIGRATION) {
        var deleteSyncDatabase = window.indexedDB.deleteDatabase(elementSyncDatabase);
        deleteSyncDatabase.onsuccess = function () {
          window.localStorage.setItem(elementMigrationKey, ELEMENT_SYNC_MIGRATION);
        };
        deleteSyncDatabase.onerror = function () {
          console.warn("Open Suite could not clear Element's stale sync cache", deleteSyncDatabase.error);
        };
        deleteSyncDatabase.onblocked = function () {
          console.warn("Open Suite will retry Element's sync-cache migration on the next load");
        };
      }
    } catch (e) {
      console.warn("Open Suite could not run Element's sync-cache migration", e);
    }
  }
  // Office dropdown deep-links into the Nextcloud Office overview sections.
  // The header sidecar rewrites these clean URLs to the stock Office app while
  // preserving the visible path for reloads, sharing, and switching sections.
  var OFFICE_CHILDREN = [
    { label: "Documents", path: "/apps/office/documents" },
    { label: "Spreadsheets", path: "/apps/office/spreadsheets" },
    { label: "Presentations", path: "/apps/office/presentations" },
    { label: "Diagrams", path: "/apps/office/diagrams" },
    { label: "Files", path: "/apps/files/files" },
  ];

  var MORE_CHILDREN = [
    { label: "Tables", sub: "grist" },
    { label: "Wiki", sub: "docs" },
    { label: "Contacts", sub: "nextcloud", path: "/apps/contacts" },
  ];

  // sub = subdomain the item points at; used for both the href and active app.
  var NAV = [
    { label: "Home", sub: "bridge" },
    // Element's authenticated bare-root startup pushes #/home, leaving both
    // / and /#/home above the referring Portal entry. Enter its supported
    // canonical home route directly so Back returns to Portal; Element still
    // preserves explicit room hashes across its replace-only SSO callback.
    { label: "Chat", sub: "element", path: "/#/home" },
    { label: "Meet", sub: "meet" },
    { label: "Office", sub: "nextcloud", children: OFFICE_CHILDREN },
    { label: "Calendar", sub: "nextcloud", path: "/apps/calendar" },
    { label: "More", children: MORE_CHILDREN },
  ];

  // Mail (La Suite Messages) is an optional app: 09-portal-header.sh flips
  // this to true when it is deployed, so no dead link ships by default.
  var MAIL_ENABLED = false;
  if (MAIL_ENABLED) NAV.splice(1, 0, { label: "Mail", sub: "messages" });

  // Nextcloud: never show its own login form or OIDC error screens
  // ("Access forbidden — the received state has expired" after following a
  // stale login URL). Both get a clean silent OIDC retry instead.
  // Rate-limited via sessionStorage so a failing login can't redirect-loop.
  if (window.location.hostname.indexOf("nextcloud.") === 0) {
    var ncPath = window.location.pathname;
    var ncStale = document.body && /received state has expired|Access forbidden/i.test(document.body.innerText || "");
    if (ncPath === "/login" || ncPath.indexOf("/login/") === 0 || ncStale) {
      var ncLast = +sessionStorage.getItem("osNcAutoLogin") || 0;
      if (Date.now() - ncLast > 60000) {
        sessionStorage.setItem("osNcAutoLogin", String(Date.now()));
        var ncLoginTarget = new URLSearchParams(window.location.search).get("redirect_url") ||
          new URLSearchParams(window.location.search).get("redirectUrl");
        var ncReturnTo = ncLoginTarget || sessionStorage.getItem("osNcRequestedPath") || "/apps/files/files";
        if (ncPath !== "/login" && ncPath.indexOf("/login/") !== 0 &&
            ncPath.indexOf("/apps/user_oidc/") !== 0) {
          ncReturnTo = window.location.pathname + window.location.search + window.location.hash;
        }
        if (/^https?:\/\//i.test(ncReturnTo)) {
          var ncReturnUrl = new URL(ncReturnTo);
          ncReturnTo = ncReturnUrl.origin === window.location.origin
            ? ncReturnUrl.pathname + ncReturnUrl.search + ncReturnUrl.hash
            : "";
        }
        // user_oidc accepts only a same-origin absolute path. Keep that
        // invariant here too rather than passing an external/protocol-relative
        // target through the recovery flow.
        if (ncReturnTo.charAt(0) !== "/" || ncReturnTo.indexOf("//") === 0) {
          ncReturnTo = "/apps/files/files";
        }
        // Keep the destination through the callback. If the provider state is
        // stale, the next rendered error page can retry the same destination.
        sessionStorage.setItem("osNcRequestedPath", ncReturnTo);
        window.location.replace("/apps/user_oidc/login/1?redirectUrl=" +
          encodeURIComponent(ncReturnTo));
      }
    } else if (ncPath.indexOf("/apps/user_oidc/") !== 0) {
      sessionStorage.setItem("osNcRequestedPath", ncPath + window.location.search + window.location.hash);
    }
  }

  function injectStyles() {
    var old = document.getElementById(HEADER_ID + "-styles");
    if (old && old.dataset.version === HEADER_VERSION) return;
    if (old) old.remove();
    var s = document.createElement("style");
    s.id = HEADER_ID + "-styles";
    s.dataset.version = HEADER_VERSION;
    s.textContent = [
      "#" + HEADER_ID + "{position:fixed;top:0;left:0;right:0;height:" + HEADER_HEIGHT + "px;",
      "z-index:2147483647;display:flex;align-items:center;gap:2px;padding:0 14px;",
      "background:#0b1f33;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;",
      "font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,.25);box-sizing:border-box;}",
      "#" + HEADER_ID + " .ko-brand{display:flex;align-items:center;gap:8px;font-weight:700;margin-right:12px;color:#fff;text-decoration:none;}",
      "#" + HEADER_ID + " .ko-brand .ko-mark{width:26px;height:26px;border-radius:6px;background:#ff5b39;color:#1a1a1a;",
      "display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;}",
      "#" + HEADER_ID + " .ko-desktop-nav{display:flex;align-items:center;gap:2px;flex:1;min-width:0;}",
      "#" + HEADER_ID + " .ko-item{position:relative;}",
      "#" + HEADER_ID + " .ko-link{display:flex !important;align-items:center;gap:5px;color:#cdd6e0;text-decoration:none;",
      "padding:6px 10px;border-radius:6px;white-space:nowrap;cursor:pointer;background:none;border:0;font:inherit;}",
      "#" + HEADER_ID + " .ko-link:hover{background:rgba(255,255,255,.10);color:#fff;}",
      "#" + HEADER_ID + " .ko-link.ko-active{background:rgba(255,255,255,.16);color:#fff;font-weight:600;}",
      "#" + HEADER_ID + " .ko-logout{margin-left:auto;display:flex;align-items:center;color:#cdd6e0;text-decoration:none;",
      "padding:6px 10px;border-radius:6px;white-space:nowrap;flex:0 0 auto;}",
      "#" + HEADER_ID + " .ko-logout:hover,#" + HEADER_ID + " .ko-logout:focus-visible{",
      "background:rgba(255,255,255,.10);color:#fff;outline:2px solid #fff;outline-offset:1px;}",
      "#" + HEADER_ID + " .ko-caret{font-size:10px;opacity:.8;}",
      "#" + HEADER_ID + " .ko-menu{position:absolute;top:calc(100% + 4px);left:0;min-width:180px;",
      "background:#10263d;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px;",
      "box-shadow:0 6px 24px rgba(0,0,0,.35);display:none;flex-direction:column;gap:2px;}",
      "#" + HEADER_ID + " .ko-item.ko-open .ko-menu{display:flex;}",
      "#" + HEADER_ID + " .ko-menu a{color:#cdd6e0;text-decoration:none;padding:8px 10px;border-radius:6px;white-space:nowrap;}",
      "#" + HEADER_ID + " .ko-menu a:hover{background:rgba(255,255,255,.10);color:#fff;}",
      "#" + HEADER_ID + " .ko-mobile-toggle,#" + HEADER_ID + " .ko-mobile-menu{display:none;}",
      "@media(max-width:899px){",
      "#" + HEADER_ID + "{padding:0 10px;}",
      "#" + HEADER_ID + " .ko-brand{margin-right:auto;}",
      "#" + HEADER_ID + " .ko-desktop-nav{display:none;}",
      "#" + HEADER_ID + " .ko-mobile-toggle{display:flex;align-items:center;justify-content:center;width:36px;height:36px;",
      "padding:0;border:0;border-radius:6px;background:none;color:#fff;font:inherit;font-size:24px;cursor:pointer;}",
      "#" + HEADER_ID + " .ko-mobile-toggle:hover,#" + HEADER_ID + " .ko-mobile-toggle:focus-visible{",
      "background:rgba(255,255,255,.10);outline:2px solid #fff;outline-offset:1px;}",
      "#" + HEADER_ID + " .ko-mobile-menu{position:fixed;top:var(" + HEADER_HEIGHT_VAR + ");left:0;right:0;",
      "max-height:calc(100dvh - var(" + HEADER_HEIGHT_VAR + "));overflow:auto;padding:8px 10px 12px;",
      "background:#10263d;border-top:1px solid rgba(255,255,255,.12);box-shadow:0 8px 20px rgba(0,0,0,.3);",
      "box-sizing:border-box;flex-direction:column;gap:3px;}",
      "#" + HEADER_ID + ".ko-mobile-open .ko-mobile-menu{display:flex;}",
      "#" + HEADER_ID + " .ko-mobile-menu a,#" + HEADER_ID + " .ko-mobile-menu summary{",
      "display:block;color:#e6edf4;text-decoration:none;padding:10px;border-radius:6px;cursor:pointer;list-style:none;}",
      "#" + HEADER_ID + " .ko-mobile-menu a:hover,#" + HEADER_ID + " .ko-mobile-menu summary:hover{",
      "background:rgba(255,255,255,.10);color:#fff;}",
      "#" + HEADER_ID + " .ko-mobile-menu summary::-webkit-details-marker{display:none;}",
      "#" + HEADER_ID + " .ko-mobile-menu summary:after{content:'▾';float:right;opacity:.8;}",
      "#" + HEADER_ID + " .ko-mobile-menu details[open] summary:after{transform:rotate(180deg);}",
      "#" + HEADER_ID + " .ko-mobile-children{padding-left:14px;}",
      "#" + HEADER_ID + " .ko-mobile-logout{margin-top:5px;border-top:1px solid rgba(255,255,255,.12);border-radius:0;}",
      "}",
      // On the bridge portal our shell replaces the native header. These rules
      // are also present in the response's critical head CSS, before app paint.
      "html.ko-on-bridge .ant-layout-header{display:none !important;}",
      "html.ko-on-bridge body{padding-top:var(" + HEADER_HEIGHT_VAR + ") !important;}",
      // Element fills the viewport (#matrixchat = 100vh) and puts controls at the
      // very top, which the overlay would cover — push it below the bar and
      // shrink it so nothing (room search, message composer) is hidden or cut.
      "html.ko-on-element #matrixchat{margin-top:var(" + HEADER_HEIGHT_VAR + ") !important;height:calc(100vh - var(" + HEADER_HEIGHT_VAR + ")) !important;}",
      // Nextcloud's native header is absolute and #content is fixed. Reserve a
      // real row for both so Calendar's navigation and controls are never under
      // the suite shell and the app still fits exactly inside the viewport.
      "html.ko-on-nextcloud #header:not(.header-guest){top:var(" + HEADER_HEIGHT_VAR + ") !important;}",
      "html.ko-on-nextcloud #content{margin-top:calc(var(--header-height) + var(" + HEADER_HEIGHT_VAR + ")) !important;",
      "height:calc(var(--body-height) - var(" + HEADER_HEIGHT_VAR + ")) !important;}",
      // Nextcloud Office deliberately moves its full-screen Collabora iframe
      // over Nextcloud's own 50px header. Our fixed suite header occupies that
      // same space, so without an offset it covers Collabora's File/Insert tab
      // row. Move only the full-screen editor down; embedded/split previews keep
      // their native geometry.
      "html.ko-on-nextcloud .viewer__content:not(.viewer--split) .office-viewer:not(.viewer__file--hidden):not(.widget-file){",
      "transform:translateY(var(" + HEADER_HEIGHT_VAR + "));height:calc(100vh - var(" + HEADER_HEIGHT_VAR + ")) !important;",
      "height:calc(100dvh - var(" + HEADER_HEIGHT_VAR + ")) !important;}",
      // Nextcloud Calendar's new-event popover sizes its max-height as
      // (100vh - its top), but NC's own 50px header offsets the real top, so the
      // popover renders ~50px too tall and its footer (Save) falls off-screen.
      // Pin it just below our bar and bound its height to the viewport; NC's
      // __content already scrolls. (NC-only class, no-op elsewhere.)
      ".event-popover{top:calc(var(" + HEADER_HEIGHT_VAR + ") + var(--header-height) + 12px) !important;",
      "max-height:calc(100vh - var(" + HEADER_HEIGHT_VAR + ") - var(--header-height) - 28px) !important;}",
    ].join("");
    document.head.appendChild(s);
  }

  function hrefFor(item, inheritedSub) {
    return origin(item.sub || inheritedSub) + (item.path || "");
  }

  function isActive(item, inheritedSub) {
    var sub = item.sub || inheritedSub;
    if (item.children) {
      return item.children.some(function (child) { return isActive(child, sub); });
    }
    if (!sub || host.indexOf(sub + ".") !== 0) return false;
    return item.path ? window.location.pathname.indexOf(item.path) === 0 : true;
  }

  function syncHeaderHeight(bar) {
    var height = Math.round(bar.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty(HEADER_HEIGHT_VAR, height + "px");
  }

  function buildItem(item) {
    var wrap = document.createElement("div");
    wrap.className = "ko-item";

    if (item.children) {
      var btn = document.createElement("button");
      btn.className = "ko-link" + (isActive(item) ? " ko-active" : "");
      btn.type = "button";
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = item.label + ' <span class="ko-caret">▾</span>';
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        wrap.classList.toggle("ko-open");
        btn.setAttribute("aria-expanded", wrap.classList.contains("ko-open") ? "true" : "false");
      });
      wrap.appendChild(btn);

      var menu = document.createElement("div");
      menu.className = "ko-menu";
      item.children.forEach(function (child) {
        var a = document.createElement("a");
        a.href = hrefFor(child, item.sub);
        a.textContent = child.label;
        menu.appendChild(a);
      });
      wrap.appendChild(menu);
    } else {
      var link = document.createElement("a");
      link.className = "ko-link" + (isActive(item) ? " ko-active" : "");
      link.href = hrefFor(item);
      link.textContent = item.label;
      wrap.appendChild(link);
    }
    return wrap;
  }

  function buildMobileItem(item) {
    if (!item.children) {
      var link = document.createElement("a");
      link.href = hrefFor(item);
      link.textContent = item.label;
      if (isActive(item)) link.className = "ko-active";
      return link;
    }

    var details = document.createElement("details");
    var summary = document.createElement("summary");
    summary.textContent = item.label;
    details.appendChild(summary);
    var children = document.createElement("div");
    children.className = "ko-mobile-children";
    item.children.forEach(function (child) {
      var link = document.createElement("a");
      link.href = hrefFor(child, item.sub);
      link.textContent = child.label;
      children.appendChild(link);
    });
    details.appendChild(children);
    return details;
  }

  function logoutLink(className) {
    var logout = document.createElement("a");
    logout.className = className;
    logout.href = MAIL_ENABLED
      ? origin("messages") + "/api/v1.0/logout/"
      : origin("auth") + "/logout?rd=" + encodeURIComponent(origin("bridge") + "/");
    logout.textContent = "Log out";
    logout.setAttribute("aria-label", "Logout");
    return logout;
  }

  function mount() {
    if (!document.body) return;
    var existing = document.getElementById(HEADER_ID);
    if (existing && existing.dataset.version === HEADER_VERSION) return;
    injectStyles();
    // On the bridge portal, take over from its built-in nav (hide it + offset).
    if (host.indexOf("bridge.") === 0) {
      document.documentElement.classList.add("ko-on-bridge");
    } else if (host.indexOf("element.") === 0) {
      document.documentElement.classList.add("ko-on-element");
    } else if (host.indexOf("nextcloud.") === 0) {
      document.documentElement.classList.add("ko-on-nextcloud");
    }

    // The sidecar puts this stable node in the initial HTML. Keep the node
    // identity across publication/version changes; only enhance its contents.
    var bar = existing || document.createElement("nav");
    bar.textContent = "";
    bar.id = HEADER_ID;
    bar.dataset.version = HEADER_VERSION;
    bar.removeAttribute("data-shell");
    bar.setAttribute("aria-label", "Open Suite");

    var brand = document.createElement("a");
    brand.className = "ko-brand";
    brand.href = origin("bridge");
    brand.innerHTML = '<span class="ko-mark">O</span><span>Open Suite</span>';
    bar.appendChild(brand);

    var desktop = document.createElement("div");
    desktop.className = "ko-desktop-nav";
    NAV.forEach(function (item) { desktop.appendChild(buildItem(item)); });
    desktop.appendChild(logoutLink("ko-logout"));
    bar.appendChild(desktop);

    var mobileToggle = document.createElement("button");
    mobileToggle.className = "ko-mobile-toggle";
    mobileToggle.type = "button";
    mobileToggle.textContent = "☰";
    mobileToggle.setAttribute("aria-label", "Open navigation");
    mobileToggle.setAttribute("aria-expanded", "false");
    bar.appendChild(mobileToggle);

    var mobileMenu = document.createElement("div");
    mobileMenu.className = "ko-mobile-menu";
    NAV.forEach(function (item) { mobileMenu.appendChild(buildMobileItem(item)); });
    mobileMenu.appendChild(logoutLink("ko-mobile-logout"));
    bar.appendChild(mobileMenu);

    mobileToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      bar.classList.toggle("ko-mobile-open");
      var open = bar.classList.contains("ko-mobile-open");
      mobileToggle.setAttribute("aria-expanded", open ? "true" : "false");
      mobileToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    });

    if (!existing) document.body.appendChild(bar);
    document.documentElement.classList.remove("ko-shell-pending");
    syncHeaderHeight(bar);
    if (typeof ResizeObserver !== "undefined") {
      if (headerResizeObserver) headerResizeObserver.disconnect();
      headerResizeObserver = new ResizeObserver(function () { syncHeaderHeight(bar); });
      headerResizeObserver.observe(bar);
    }

    // Close menus when clicking elsewhere or pressing Escape.
    document.addEventListener("click", function (e) {
      var open = bar.querySelector(".ko-item.ko-open");
      if (open) open.classList.remove("ko-open");
      if (!bar.contains(e.target)) {
        bar.classList.remove("ko-mobile-open");
        mobileToggle.setAttribute("aria-expanded", "false");
        mobileToggle.setAttribute("aria-label", "Open navigation");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      bar.classList.remove("ko-mobile-open");
      mobileToggle.setAttribute("aria-expanded", "false");
      mobileToggle.setAttribute("aria-label", "Open navigation");
    });
  }

  mount();
  if (!document.body || !document.getElementById(HEADER_ID)) {
    if (typeof MutationObserver !== "undefined") {
      var shellObserver = new MutationObserver(function () {
        if (document.body) {
          shellObserver.disconnect();
          mount();
        }
      });
      shellObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      document.addEventListener("DOMContentLoaded", mount);
    }
  }
  setInterval(function () {
    mount();
  }, 1500);
})();

/*
 * Office overview clean URLs.
 *
 * The stock `nextcloud/office` overview app has no router: the open section
 * (Documents / Spreadsheets / Presentations / Diagrams) is in-component Vue
 * state with no URL representation. The sidecar serves the same Office app for
 * `/apps/office/<section>`, and this code selects the matching sidebar entry.
 * Clicking a section updates the visible path, so reloads and switching between
 * sections stay deterministic without hash/session handoffs.
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
    var match = window.location.pathname.match(/^\/apps\/office\/(documents|spreadsheets|presentations|diagrams)\/?$/);
    if (match) return match[1];
    var param = new URLSearchParams(window.location.search).get("koOfficeSection");
    return (param || "").trim().toLowerCase();
  }

  function writeOfficePath(slug) {
    if (!slug) return;
    var nextPath = "/apps/office/" + slug;
    var nextHref = window.location.origin + nextPath;
    if (window.location.href !== nextHref) {
      history.replaceState(null, "", nextPath);
    }
  }

  // Select the section named by the URL, retrying while the sidebar (which
  // renders only after the app's async template fetch) comes up.
  function applyFromUrl() {
    var want = requestedSection();
    if (!want) return;
    var tries = 0;
    (function attempt() {
      var items = navItems();
      for (var i = 0; i < items.length; i++) {
        if (slugOf(items[i]) === want) {
          writeOfficePath(want);
          // Already active → leave it, so we don't loop click→hashchange→click.
          if (items[i].className.indexOf("active") === -1) {
            (items[i].querySelector("a") || items[i]).click();
          }
          setTimeout(function () { writeOfficePath(want); }, 0);
          setTimeout(function () { writeOfficePath(want); }, 250);
          setTimeout(function () { writeOfficePath(want); }, 1000);
          return;
        }
      }
      if (tries++ < 40) setTimeout(attempt, 150); // up to ~6s for first paint
    })();
  }

  // Mirror sidebar clicks into the path so the URL reflects the open section.
  function watchClicks() {
    var nav = document.getElementById("app-navigation-vue");
    if (!nav || nav.dataset.osHashBound) return;
    nav.dataset.osHashBound = "1";
    nav.addEventListener("click", function (e) {
      var li = e.target.closest && e.target.closest('li[class*="app-navigation-entry"]');
      if (!li || !nav.contains(li)) return;
      var slug = slugOf(li);
      writeOfficePath(slug);
      setTimeout(function () { writeOfficePath(slug); }, 0);
      setTimeout(function () { writeOfficePath(slug); }, 250);
      setTimeout(function () { writeOfficePath(slug); }, 1000);
    });
  }

  window.addEventListener("popstate", applyFromUrl);
  window.addEventListener("hashchange", function () {
    var section = requestedSection();
    if (section) setTimeout(function () { writeOfficePath(section); }, 0);
  });
  applyFromUrl();
  setInterval(function () {
    var section = requestedSection();
    if (section) writeOfficePath(section);
  }, 100);
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
  var draftKey = "";
  var editorWasOpen = false;
  var clearDraftTimer = null;

  function idempotencyKey() {
    if (!draftKey) {
      draftKey = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : "draft-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }
    return draftKey;
  }

  // Ask the meetcal app to create/get a room for this event draft (same origin).
  function ensureRoom(key, cb) {
    var token = (window.OC && window.OC.requestToken) || "";
    fetch("/apps/meetcal/room", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", requesttoken: token },
      body: JSON.stringify({ idempotencyKey: key }),
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

  function addLink(loc, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    ensureRoom(idempotencyKey(), function (url) {
      if (btn) { btn.disabled = false; btn.textContent = "Add Meet link"; }
      if (url) setReactive(loc, url);
    });
  }

  function decorate() {
    var loc = findLocationInput();
    if (!loc) {
      if (editorWasOpen && !clearDraftTimer) {
        // Vue can briefly replace the editor DOM. Keep the key through short
        // remounts, but discard it after the editor really closes so the next
        // event receives a different room.
        clearDraftTimer = setTimeout(function () {
          clearDraftTimer = null;
          if (!findLocationInput()) {
            editorWasOpen = false;
            draftKey = "";
          }
        }, 2500);
      }
      return;
    }
    editorWasOpen = true;
    if (clearDraftTimer) {
      clearTimeout(clearDraftTimer);
      clearDraftTimer = null;
    }
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
