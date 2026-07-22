#!/usr/bin/env python3
"""Static contract for the sidecar-rendered first-paint shell."""

import pathlib
import re
import sys


infra = pathlib.Path(sys.argv[1]) if len(sys.argv) == 2 else None
if infra is None:
    raise SystemExit(f"Usage: {sys.argv[0]} <patched-infra-dir>")

repo = pathlib.Path(__file__).resolve().parents[1]
header = (repo / "overlays/portal-header/opensuite-header.js").read_text()
configs = {
    "portal": infra / "helmfile/apps/bureaublad/values.yaml.gotmpl",
    "docs": infra / "helmfile/apps/docs/values.yaml.gotmpl",
    "grist": infra / "helmfile/apps/grist/values.yaml.gotmpl",
    "nextcloud": infra / "helmfile/apps/nextcloud/values.yaml.gotmpl",
    "messages": infra / "helmfile/apps/messages/charts/messages/templates/header-configmap.yaml",
}

head_contracts = (
    "sub_filter '</head>'",
    ':root{--ko-header-height:48px}',
    'background:#0b1f33',
    '<style nonce="$ko_nonce">',
    '<script nonce="$ko_nonce">',
    '<script nonce="$ko_nonce" defer src="/opensuite-header.js">',
)
body_contracts = (
    "sub_filter '</body>'",
    '<nav id="ko-portal-header" data-shell="critical"',
    '<span>Open Suite</span>',
    'sub_filter_once on;',
)
for app, path in configs.items():
    rendered_source = path.read_text()
    for contract in head_contracts + body_contracts:
        if contract not in rendered_source:
            raise AssertionError(f"{app} is missing first-paint contract: {contract}")
    if rendered_source.index("sub_filter '</head>'") > rendered_source.index("sub_filter '</body>'"):
        raise AssertionError(f"{app} does not initiate the canonical asset before the shell node")

    # Render the two nginx substitutions over representative upstream HTML.
    # This catches malformed replacement order/markup independently of the
    # static source checks above while retaining the real nonce interpolation.
    head_match = re.search(r"sub_filter '</head>' '(.*)</head>';", rendered_source)
    body_match = re.search(r"sub_filter '</body>' '(.*)</body>';", rendered_source)
    if not head_match or not body_match:
        raise AssertionError(f"{app} has unparseable nginx substitutions")
    response = "<html><head><title>App</title></head><body><main>Native</main></body></html>"
    rendered_head = head_match.group(1).replace("$ko_nonce", "nonce123").replace('\\"', '"')
    rendered_body = body_match.group(1).replace('\\"', '"')
    response = response.replace("</head>", rendered_head + "</head>", 1)
    response = response.replace("</body>", rendered_body + "</body>", 1)
    if response.count('id="ko-portal-header"') != 1:
        raise AssertionError(f"{app} rendered duplicate or missing shell nodes")
    if response.count('nonce="nonce123"') != 3:
        raise AssertionError(f"{app} did not render one nonce on style and both scripts")
    if response.index("--ko-header-height:48px") > response.index("<body>"):
        raise AssertionError(f"{app} rendered critical geometry outside head")

for contract in (
    "mount();\n  if (!document.body || !document.getElementById(HEADER_ID))",
    "var bar = existing || document.createElement(\"nav\")",
    "if (document.body) {\n          shellObserver.disconnect();\n          mount();",
    'bar.removeAttribute("data-shell")',
    'document.documentElement.classList.remove("ko-shell-pending")',
    'new URLSearchParams(window.location.search).get("redirect_url")',
    'encodeURIComponent(ncReturnTo)',
    'html.ko-on-nextcloud #header:not(.header-guest)',
    'height:calc(var(--body-height) - var(',
):
    if contract not in header:
        raise AssertionError(f"canonical asset is missing contract: {contract}")

if 'encodeURIComponent(window.location.origin + "/apps/files/files")' in header:
    raise AssertionError("Nextcloud native OIDC recovery still hard-falls back to Files")
if 'existing.remove()' in header:
    raise AssertionError("canonical asset still replaces the stable shell node")
for path in configs.values():
    if "sub_filter_once off;" in path.read_text():
        raise AssertionError(f"{path} can inject duplicate shell markup")

print("first-paint shell, nonce, hydration, geometry, and Calendar return contracts verified")
