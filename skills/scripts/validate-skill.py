#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


class ValidationError(ValueError):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def parse_scalar(value: str, *, source: str, line_number: int) -> str | bool | None:
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as error:
            fail(f"{source}:{line_number}: invalid double-quoted scalar: {error.msg}")
        if not isinstance(parsed, str):
            fail(f"{source}:{line_number}: quoted scalar must be a string")
        return parsed

    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            fail(f"{source}:{line_number}: invalid single-quoted scalar")
        return value[1:-1].replace("''", "'")

    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "~"}:
        return None
    if value[:1] in {"[", "{", "|", ">", "&", "*", "!"}:
        fail(f"{source}:{line_number}: unsupported YAML scalar")
    if " #" in value:
        fail(f"{source}:{line_number}: inline comments are not supported; use a separate comment line")
    return value


def parse_yaml_mapping(text: str, *, source: str) -> dict[str, Any]:
    """Parse the deliberately small YAML mapping subset used by Agent Skills.

    Keeping this parser local makes validation dependency-free while still validating
    parsed values and types instead of searching raw YAML text.
    """

    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-2, root)]
    saw_value = False

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if "\t" in raw_line:
            fail(f"{source}:{line_number}: tabs are not allowed in YAML indentation")

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if indent % 2:
            fail(f"{source}:{line_number}: indentation must use two-space levels")

        content = raw_line[indent:]
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):(.*)", content)
        if not match:
            fail(f"{source}:{line_number}: expected a YAML mapping entry")
        key, raw_value = match.groups()

        while indent <= stack[-1][0]:
            stack.pop()
        parent_indent, parent = stack[-1]
        if indent != parent_indent + 2:
            fail(f"{source}:{line_number}: invalid mapping indentation")
        if key in parent:
            fail(f"{source}:{line_number}: duplicate key {key!r}")

        value = raw_value.strip()
        if value:
            parent[key] = parse_scalar(value, source=source, line_number=line_number)
        else:
            child: dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
        saw_value = True

    if not saw_value:
        fail(f"{source}: YAML mapping is empty")
    return root


def require_mapping(value: Any, *, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{field} must be a mapping")
    return value


def require_string(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{field} must be a non-empty string")
    return value


def parse_frontmatter(skill_md: Path) -> tuple[dict[str, Any], str]:
    lines = skill_md.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        fail("SKILL.md must start with YAML frontmatter")

    try:
        closing = lines.index("---", 1)
    except ValueError:
        fail("SKILL.md frontmatter is not closed")

    fields = parse_yaml_mapping(
        "\n".join(lines[1:closing]),
        source=str(skill_md),
    )
    body = "\n".join(lines[closing + 1 :]).strip()
    if not body:
        fail("SKILL.md body is empty")
    return fields, body


def validate_openai_metadata(openai_yaml: Path, *, skill_name: str) -> None:
    if not openai_yaml.is_file():
        fail("missing agents/openai.yaml")

    metadata = parse_yaml_mapping(
        openai_yaml.read_text(encoding="utf-8"),
        source=str(openai_yaml),
    )
    unexpected_top_level = set(metadata) - {"interface", "policy"}
    if unexpected_top_level:
        fail(f"agents/openai.yaml has unsupported fields: {', '.join(sorted(unexpected_top_level))}")

    interface = require_mapping(metadata.get("interface"), field="interface")
    allowed_interface = {
        "display_name",
        "short_description",
        "icon_small",
        "icon_large",
        "brand_color",
        "default_prompt",
    }
    unexpected_interface = set(interface) - allowed_interface
    if unexpected_interface:
        fail(f"interface has unsupported fields: {', '.join(sorted(unexpected_interface))}")

    display_name = require_string(interface.get("display_name"), field="interface.display_name")
    short_description = require_string(interface.get("short_description"), field="interface.short_description")
    default_prompt = require_string(interface.get("default_prompt"), field="interface.default_prompt")
    if len(display_name) > 64:
        fail("interface.display_name exceeds 64 characters")
    if not 25 <= len(short_description) <= 64:
        fail("interface.short_description must contain 25 to 64 characters")
    invocation = re.compile(rf"(?<![A-Za-z0-9_-])\${re.escape(skill_name)}(?![A-Za-z0-9_-])")
    if not invocation.search(default_prompt):
        fail(f"interface.default_prompt must mention ${skill_name}")

    for icon_field in ("icon_small", "icon_large"):
        if icon_field in interface:
            icon_path = require_string(interface[icon_field], field=f"interface.{icon_field}")
            if not icon_path.startswith("./assets/"):
                fail(f"interface.{icon_field} must point inside ./assets/")
    if "brand_color" in interface:
        brand_color = require_string(interface["brand_color"], field="interface.brand_color")
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", brand_color):
            fail("interface.brand_color must be a six-digit hex color")

    if "policy" in metadata:
        policy = require_mapping(metadata["policy"], field="policy")
        unexpected_policy = set(policy) - {"allow_implicit_invocation"}
        if unexpected_policy:
            fail(f"policy has unsupported fields: {', '.join(sorted(unexpected_policy))}")
        allow_implicit = policy.get("allow_implicit_invocation")
        if not isinstance(allow_implicit, bool):
            fail("policy.allow_implicit_invocation must be a boolean")


def validate_local_links(skill_root: Path, body: str) -> None:
    linked_paths: set[Path] = set()
    for raw_target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", body):
        target = raw_target.split("#", 1)[0]
        if not target or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
            continue
        if target.startswith("/"):
            fail(f"SKILL.md contains an absolute local link: {raw_target}")
        linked = (skill_root / target).resolve()
        try:
            linked.relative_to(skill_root.resolve())
        except ValueError:
            fail(f"SKILL.md link escapes the skill directory: {raw_target}")
        if not linked.is_file():
            fail(f"SKILL.md link does not exist: {raw_target}")
        linked_paths.add(linked)

    required_reference = (skill_root / "references" / "cli-installation.md").resolve()
    if required_reference not in linked_paths:
        fail("SKILL.md must link to references/cli-installation.md")


def validate_cli_compatibility_version(skill_root: Path, body: str) -> None:
    semver = (
        r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
        r"(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
        r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
        r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    )
    pattern = re.compile(
        r"preflight-scout update-check --skill-version "
        rf"({semver})(?![0-9A-Za-z.+-])"
    )
    skill_versions = set(pattern.findall(body))
    reference = (skill_root / "references" / "cli-installation.md").read_text(encoding="utf-8")
    reference_versions = set(pattern.findall(reference))
    if len(skill_versions) != 1:
        fail("SKILL.md must declare exactly one CLI compatibility version")
    if reference_versions != skill_versions:
        fail("SKILL.md and cli-installation.md must use the same CLI compatibility version")


def validate_skill(skill_root: Path) -> None:
    skill_root = skill_root.resolve()
    skill_md = skill_root / "SKILL.md"
    if not skill_md.is_file():
        fail(f"missing {skill_md}")

    fields, body = parse_frontmatter(skill_md)
    unexpected = set(fields) - {"name", "description"}
    if unexpected:
        fail(f"unexpected frontmatter fields: {', '.join(sorted(unexpected))}")

    name = require_string(fields.get("name"), field="name")
    description = require_string(fields.get("description"), field="description")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        fail("name must use lowercase hyphen-case")
    if len(name) > 64:
        fail("name exceeds 64 characters")
    if len(description) > 200:
        fail("description exceeds the 200-character cross-client limit")
    if "<" in description or ">" in description:
        fail("description cannot contain angle brackets")
    if skill_root.name != name:
        fail(f"directory name {skill_root.name!r} does not match skill name {name!r}")

    for path in skill_root.rglob("*"):
        if path.is_symlink():
            fail(f"skill packages cannot contain symlinks: {path.relative_to(skill_root)}")
        if path.name == ".DS_Store":
            fail("skill contains .DS_Store")

    validate_openai_metadata(skill_root / "agents" / "openai.yaml", skill_name=name)
    validate_local_links(skill_root, body)
    validate_cli_compatibility_version(skill_root, body)


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: validate-skill.py <skill-directory>", file=sys.stderr)
        raise SystemExit(2)

    skill_root = Path(sys.argv[1])
    try:
        validate_skill(skill_root)
    except ValidationError as error:
        print(f"Invalid skill: {error}", file=sys.stderr)
        raise SystemExit(1) from error

    print(f"Valid skill: {skill_root.resolve()}")


if __name__ == "__main__":
    main()
