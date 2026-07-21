#!/usr/bin/env python3
"""Validate the Docs v5.2.1 startup and migration optimizations."""

import argparse
import re
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]
EXPECTED_PROBES = {
    "backend": {
        "template": "templates/backend-deployment.yaml",
        "startup_path": "/__heartbeat__",
        "readiness_path": "/__lbheartbeat__",
        "startup_period": "5",
        "startup_failures": "7",
        "startup_timeout": "5",
    },
    "frontend": {
        "template": "templates/frontend-deployment.yaml",
        "startup_path": "/",
        "readiness_path": "/",
        "startup_period": "1",
        "startup_failures": "30",
        "startup_timeout": "1",
    },
    "yProvider": {
        "template": "templates/yprovider-deployment.yaml",
        "startup_path": "/ping",
        "readiness_path": "/ping",
        "startup_period": "1",
        "startup_failures": "30",
        "startup_timeout": "1",
    },
}


def run(*command, cwd=None, input_text=None):
    result = subprocess.run(
        command,
        cwd=cwd,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode:
        raise RuntimeError(f"{' '.join(map(str, command))} failed:\n{result.stdout}")
    return result.stdout


def root_section(source, name):
    match = re.search(rf"(?ms)^{re.escape(name)}:\n(.*?)(?=^[A-Za-z][^\n]*:\s*$|\Z)", source)
    if not match:
        raise AssertionError(f"missing root values section: {name}")
    return match.group(1)


def yaml_block(source, name):
    lines = source.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != f"{name}:":
            continue
        indentation = len(line) - len(line.lstrip())
        result = []
        for candidate in lines[index + 1 :]:
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) <= indentation:
                break
            result.append(candidate)
        return "\n".join(result)
    raise AssertionError(f"missing rendered {name}")


def scalar(block, name):
    match = re.search(rf"(?m)^\s*{re.escape(name)}:\s*([^\s#]+)", block)
    if not match:
        raise AssertionError(f"missing {name} in:\n{block}")
    return match.group(1).strip('"')


def rendered_resource(source, *, kind, name_fragment):
    for document in re.split(r"(?m)^---\s*$", source):
        if re.search(rf"(?m)^kind:\s*{re.escape(kind)}\s*$", document) and re.search(
            rf"(?m)^\s*name:\s*[^\n]*{re.escape(name_fragment)}[^\n]*$", document
        ):
            return document
    raise AssertionError(f"missing rendered {kind} containing {name_fragment}")


def assert_probe(block, *, path, delay, period, timeout, failures):
    expected = {
        "path": path,
        "initialDelaySeconds": str(delay),
        "periodSeconds": str(period),
        "timeoutSeconds": str(timeout),
        "failureThreshold": str(failures),
        "successThreshold": "1",
    }
    actual = {key: scalar(block, key) for key in expected}
    if actual != expected:
        raise AssertionError(f"probe mismatch: expected {expected}, got {actual}")


def validate_values_source(infra):
    source = (infra / "helmfile/apps/docs/values.yaml.gotmpl").read_text()
    for component, expected in EXPECTED_PROBES.items():
        section = root_section(source, component)
        startup = yaml_block(section, "startupProbe")
        readiness = yaml_block(section, "readinessProbe")
        assert scalar(startup, "enabled") == "true"
        assert scalar(startup, "initialDelaySeconds") == "0"
        assert scalar(startup, "periodSeconds") == expected["startup_period"]
        assert scalar(startup, "timeoutSeconds") == expected["startup_timeout"]
        assert scalar(startup, "failureThreshold") == expected["startup_failures"]
        assert scalar(startup, "successThreshold") == "1"
        assert scalar(readiness, "initialDelaySeconds") == "0"
        assert scalar(readiness, "periodSeconds") == "1"
    backend = EXPECTED_PROBES["backend"]
    backend_budget = int(backend["startup_failures"]) * max(
        int(backend["startup_period"]), int(backend["startup_timeout"])
    )
    assert backend_budget == 35, f"backend startup failure budget is {backend_budget}s"


def validate_infra_dependencies(infra):
    source = (infra / "helmfile/apps/docs/helmfile-child.yaml.gotmpl").read_text()
    docs_at = source.index("  - name: docs\n")
    docs_release = source[docs_at:].split("\n  - name:", 1)[0]
    for dependency in ("docs-postgresql", "docs-cluster", "docs-redis", "docs-minio"):
        assert source.index(f"  - name: {dependency}\n") < docs_at
        assert dependency in docs_release, f"Docs release does not need {dependency}"


def validate_rendered_chart(infra, scratch):
    chart = infra / "helmfile/apps/docs/charts/docs"
    run("helm", "dependency", "build", str(chart))
    override = scratch / "docs-performance-values.yaml"
    values = {}
    for component, expected in EXPECTED_PROBES.items():
        values[component] = textwrap.dedent(
            f"""
              startupProbe:
                enabled: true
                initialDelaySeconds: 0
                periodSeconds: {expected['startup_period']}
                timeoutSeconds: {expected['startup_timeout']}
                failureThreshold: {expected['startup_failures']}
                successThreshold: 1
              readinessProbe:
                initialDelaySeconds: 0
                periodSeconds: 1
            """
        ).strip()
    values["backend"] += textwrap.dedent(
        """

          envVars:
            DB_HOST: docs-postgresql
            DB_PORT: "5432"
            DB_NAME: docs
            DB_USER: docs
            DB_PASSWORD: app-password
            DJANGO_SECRET_KEY: django-secret
            REDIS_URL: redis://docs-redis:6379
          migrateDbCredentials:
            DB_USER: postgres
            DB_PASSWORD: admin-password
          themeCustomization:
            enabled: true
            fileContent: '{}'
        """
    ).rstrip()
    override.write_text(
        "cluster:\n  ingress:\n    type: nginx\n" +
        "\n".join(f"{name}:\n{textwrap.indent(value, '  ')}\n" for name, value in values.items())
    )

    for component, expected in EXPECTED_PROBES.items():
        rendered = run(
            "helm", "template", "docs", str(chart), "-f", str(override),
            "--show-only", expected["template"],
        )
        assert_probe(
            yaml_block(rendered, "startupProbe"),
            path=expected["startup_path"], delay=0,
            period=expected["startup_period"],
            timeout=expected["startup_timeout"],
            failures=expected["startup_failures"],
        )
        assert_probe(
            yaml_block(rendered, "readinessProbe"),
            path=expected["readiness_path"], delay=0, period=1, timeout=5,
            failures=3,
        )
        # Existing liveness semantics stay intact; startupProbe only gates them
        # while the process is booting.
        assert_probe(
            yaml_block(rendered, "livenessProbe"),
            path=expected["startup_path"], delay=10, period=10, timeout=5,
            failures=3,
        )

    rendered_jobs = run(
        "helm", "template", "docs", str(chart), "-f", str(override),
        "--show-only", "templates/backend-job.yaml",
    )
    migrate_secret = rendered_resource(
        rendered_jobs, kind="Secret", name_fragment="backend-migrate"
    )
    migrate_job = rendered_resource(
        rendered_jobs, kind="Job", name_fragment="backend-migrate"
    )
    create_superuser_job = rendered_resource(
        rendered_jobs, kind="Job", name_fragment="backend-createsuperuser"
    )
    expected_hook_annotations = {
        "helm.sh/hook": "pre-install,pre-upgrade",
        "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
    }
    for resource in (migrate_secret, migrate_job):
        annotations = yaml_block(resource, "annotations")
        for name, value in expected_hook_annotations.items():
            assert scalar(annotations, name) == value
    assert scalar(yaml_block(migrate_secret, "annotations"), "helm.sh/hook-weight") == "-10"
    assert scalar(yaml_block(migrate_job, "annotations"), "helm.sh/hook-weight") == "0"
    assert re.search(r"(?m)^\s*serviceAccountName:\s*default\s*$", migrate_job)
    assert "theme-customization" not in migrate_job
    assert re.search(r"(?m)^\s*command:\s*\n\s*- /bin/sh\s*\n\s*- -ec\s*$", migrate_job)
    assert "python manage.py migrate --no-input" in migrate_job
    assert "python - << 'GRANTS'" in migrate_job
    secret_references = re.findall(
        r"(?m)^\s*secretKeyRef:\s*\n\s*name:\s*([^\s]+)", migrate_job
    )
    assert secret_references
    assert set(secret_references) == {"docs-backend-migrate"}
    for required_key in (
        "DB_PASSWORD", "DJANGO_SECRET_KEY", "REDIS_URL", "MIGRATE_DB_PASSWORD"
    ):
        assert re.search(rf"(?m)^\s*{required_key}:\s*", migrate_secret)
    assert "helm.sh/hook:" not in create_superuser_job
    assert re.search(r"(?m)^\s*serviceAccountName:\s*docs\s*$", create_superuser_job)


def validate_migration_grants(infra):
    source = (infra / "helmfile/apps/docs/charts/docs/values.yaml").read_text()
    migrate_at = source.index("python manage.py migrate --no-input")
    migrate_values = source[source.index("      - name: migrate", 0, migrate_at):migrate_at]
    assert "helm.sh/hook: pre-install,pre-upgrade" in migrate_values
    assert "helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded" in migrate_values
    assert re.search(r'(?m)^\s*- "-ec"\s*$', migrate_values)
    grants_at = source.index("python - << 'GRANTS'", migrate_at)
    assert migrate_at < grants_at
    assert "python manage.py shell" not in source[migrate_at:grants_at + 2000]
    assert "psql" not in source[migrate_at:grants_at + 2000]
    script = source[grants_at:].split("\n", 1)[1].split("            GRANTS", 1)[0]
    script = textwrap.dedent(script)
    compile(script, "docs-migration-grants", "exec")
    for required in (
        "import psycopg", "sql.Identifier(owner_role)",
        "GRANT ALL ON ALL TABLES", "GRANT ALL ON ALL SEQUENCES",
        "ALTER DEFAULT PRIVILEGES", "with psycopg.connect(",
    ):
        assert required in script, f"missing grant safeguard: {required}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--infra-source", required=True, type=Path,
        help="local mijn-bureau-infra clone containing the pinned UPSTREAM_REF",
    )
    arguments = parser.parse_args()
    for binary in ("git", "helm"):
        if not shutil.which(binary):
            raise SystemExit(f"required executable not found: {binary}")

    upstream_ref = (REPOSITORY / "UPSTREAM_REF").read_text().strip()
    with tempfile.TemporaryDirectory(prefix="docs-v5.2.1-performance-") as directory:
        scratch = Path(directory)
        infra = scratch / "infra"
        run("git", "clone", "--quiet", "--shared", str(arguments.infra_source), str(infra))
        run("git", "checkout", "--quiet", upstream_ref, cwd=infra)
        for patch in sorted((REPOSITORY / "patches/local").glob("*.patch")):
            run("git", "apply", "--3way", "--check", str(patch), cwd=infra)
            run("git", "apply", "--3way", str(patch), cwd=infra)

        validate_values_source(infra)
        validate_infra_dependencies(infra)
        validate_rendered_chart(infra, scratch)
        validate_migration_grants(infra)

    print("Docs v5.2.1 performance patches: PASS")


if __name__ == "__main__":
    main()
