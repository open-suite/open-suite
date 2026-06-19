/*
 * Keep Office portal header — the single, shared top navigation.
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

  // host = "meet.keepoffice.ritzademo.com" -> base = "keepoffice.ritzademo.com"
  var host = window.location.hostname;
  var base = host.indexOf(".") === -1 ? host : host.slice(host.indexOf(".") + 1);
  var origin = function (sub) { return window.location.protocol + "//" + sub + "." + base; };

  // Office dropdown deep-links into Nextcloud (the "ocs"/office service).
  var OFFICE_CHILDREN = [
    { label: "Office", path: "/apps/office/" },
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
      // Push the page down so the fixed header never covers app chrome.
      "html.ko-has-header{margin-top:" + HEADER_HEIGHT + "px !important;}",
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
    document.documentElement.classList.add("ko-has-header");

    var bar = document.createElement("nav");
    bar.id = HEADER_ID;

    var brand = document.createElement("a");
    brand.className = "ko-brand";
    brand.href = origin("bridge");
    brand.innerHTML = '<span class="ko-mark">K</span><span>Keep Office</span>';
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
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  setInterval(mount, 1500);
})();
