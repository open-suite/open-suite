#!/usr/bin/env python3
"""Static and rendered contracts for the shared-header sidecars."""

import pathlib
import re
import sys


infra = pathlib.Path(sys.argv[1]) if len(sys.argv) in (2, 3) else None
if infra is None:
    raise SystemExit(f"Usage: {sys.argv[0]} <patched-infra-dir> [nextcloud-rendered-yaml]")
nextcloud_rendered = pathlib.Path(sys.argv[2]) if len(sys.argv) == 3 else None

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

nextcloud_source = configs["nextcloud"].read_text()
for nextcloud_contract in (
    'html.ko-on-nextcloud #content,html.ko-on-nextcloud #content-vue',
    'html.ko-shell-pending:before{content:\"Open Suite\"',
    'html.ko-shell-pending:after{content:\"O\"',
):
    if nextcloud_contract not in nextcloud_source:
        raise AssertionError(f"nextcloud is missing first-paint contract: {nextcloud_contract}")

# Nextcloud's Service is deliberately fronted by the header sidecar. Keep the
# Kubernetes readiness owner on that same container and make its HTTP check traverse nginx
# to Nextcloud; checking only either listening port would recreate the HPA
# endpoint-publication race that this contract prevents.
nextcloud_sidecar = nextcloud_source.split("\nsidecars:\n", 1)[1].split("\nextraContainerPorts:\n", 1)[0]
for readiness_contract in (
    "name: opensuite-header",
    "readinessProbe:",
    "path: /status.php",
    "port: 8091",
    'value: "{{ .Values.global.hostname.nextcloud }}.{{ .Values.global.domain }}"',
):
    if readiness_contract not in nextcloud_sidecar:
        raise AssertionError(f"nextcloud sidecar is missing readiness contract: {readiness_contract}")

nextcloud_service = (infra / "helmfile/apps/nextcloud/charts/nextcloud/templates/service.yaml").read_text()
if "targetPort: {{ coalesce .Values.service.targetPortOverride .Values.containerPorts.http }}" not in nextcloud_service:
    raise AssertionError("nextcloud Service does not render its configured sidecar target")
if "targetPortOverride: 8091" not in nextcloud_source:
    raise AssertionError("nextcloud Service target does not align with sidecar readiness port 8091")

if nextcloud_rendered is not None:
    documents = nextcloud_rendered.read_text().split("\n---\n")
    service = next(
        document for document in documents
        if "# Source: nextcloud/templates/service.yaml" in document
    )
    deployment = next(
        document for document in documents
        if "# Source: nextcloud/templates/deployment.yaml" in document
    )
    if not re.search(r"ports:\s+- name: http\s+port: 8080\s+targetPort: 8091", service):
        raise AssertionError("rendered Nextcloud Service does not target sidecar port 8091")
    rendered_sidecar = deployment.split("name: opensuite-header", 1)[1].split("volumeMounts:", 1)[0]
    for readiness_contract in (
        "readinessProbe:",
        "path: /status.php",
        "port: 8091",
        "value: nextcloud.example.test",
    ):
        if readiness_contract not in rendered_sidecar:
            raise AssertionError(
                f"rendered Nextcloud sidecar is missing readiness contract: {readiness_contract}"
            )

for contract in (
    "mount();\n  if (!document.body || !document.getElementById(HEADER_ID))",
    "var bar = existing || document.createElement(\"nav\")",
    "if (document.body) {\n          shellObserver.disconnect();\n          mount();",
    'bar.removeAttribute("data-shell")',
    'document.documentElement.classList.remove("ko-shell-pending")',
    'new URLSearchParams(window.location.search).get("redirect_url")',
    'encodeURIComponent(ncReturnTo)',
    'html.ko-on-nextcloud #header:not(.header-guest)',
    'html.ko-on-nextcloud #content,html.ko-on-nextcloud #content-vue',
    'height:calc(var(--body-height) - var(',
    'item.querySelector(\'[aria-current="page"], .app-navigation-entry.active\')',
    'history[addHistory ? "pushState" : "replaceState"]',
    'e.preventDefault()',
    'new MutationObserver(synchronizeOfficeNavigation)',
):
    if contract not in header:
        raise AssertionError(f"canonical asset is missing contract: {contract}")

if 'encodeURIComponent(window.location.origin + "/apps/files/files")' in header:
    raise AssertionError("Nextcloud native OIDC recovery still hard-falls back to Files")
if 'existing.remove()' in header:
    raise AssertionError("canonical asset still replaces the stable shell node")
for office_poll in (
    'setTimeout(function () { writeOfficePath',
    'setInterval(watchClicks',
    'items[i].className.indexOf("active")',
):
    if office_poll in header:
        raise AssertionError(f"Office navigation still races the native app: {office_poll}")
for path in configs.values():
    if "sub_filter_once off;" in path.read_text():
        raise AssertionError(f"{path} can inject duplicate shell markup")

print("shared-header first paint and Nextcloud service/readiness alignment verified")
