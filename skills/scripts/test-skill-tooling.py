#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CANONICAL_SKILL = REPO_ROOT / "skills" / "preflight-scout"
VALIDATOR = REPO_ROOT / "skills" / "scripts" / "validate-skill.py"
PACKAGER = REPO_ROOT / "skills" / "scripts" / "package-skill.sh"
ARCHIVE_BUILDER = REPO_ROOT / "skills" / "scripts" / "build-skill-archive.py"


class SkillToolingTests(unittest.TestCase):
    def run_validator(self, skill_root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), str(skill_root)],
            text=True,
            capture_output=True,
            check=False,
        )

    def copy_skill(self, parent: Path) -> Path:
        destination = parent / "preflight-scout"
        shutil.copytree(CANONICAL_SKILL, destination)
        return destination

    def test_canonical_skill_is_valid(self) -> None:
        result = self.run_validator(CANONICAL_SKILL)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cross_client_description_limit_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            skill = self.copy_skill(Path(temp_dir))
            skill_md = skill / "SKILL.md"
            text = skill_md.read_text(encoding="utf-8")
            start = text.index('description: "') + len('description: "')
            end = text.index('"', start)
            skill_md.write_text(text[:start] + ("x" * 201) + text[end:], encoding="utf-8")
            result = self.run_validator(skill)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("200-character", result.stderr)

    def test_default_prompt_is_checked_as_a_parsed_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            skill = self.copy_skill(Path(temp_dir))
            metadata = skill / "agents" / "openai.yaml"
            text = metadata.read_text(encoding="utf-8")
            lines = [
                '  default_prompt: "Assess release readiness with evidence."' if line.strip().startswith("default_prompt:") else line
                for line in text.splitlines()
            ]
            lines.append("# $preflight-scout in a comment must not satisfy validation")
            metadata.write_text("\n".join(lines) + "\n", encoding="utf-8")
            result = self.run_validator(skill)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must mention $preflight-scout", result.stderr)

    def test_policy_boolean_type_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            skill = self.copy_skill(Path(temp_dir))
            metadata = skill / "agents" / "openai.yaml"
            text = metadata.read_text(encoding="utf-8").replace(
                "allow_implicit_invocation: true",
                'allow_implicit_invocation: "true"',
            )
            metadata.write_text(text, encoding="utf-8")
            result = self.run_validator(skill)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must be a boolean", result.stderr)

    def test_required_installation_reference_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            skill = self.copy_skill(Path(temp_dir))
            (skill / "references" / "cli-installation.md").unlink()
            result = self.run_validator(skill)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not exist", result.stderr)

    def test_skill_forbids_printing_binary_evidence(self) -> None:
        skill_text = (CANONICAL_SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Do not print binary evidence", skill_text)
        self.assertIn("trace.zip", skill_text)

    def test_package_is_deterministic_and_self_validating(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            first = Path(temp_dir) / "first.zip"
            second = Path(temp_dir) / "second.zip"
            for output in (first, second):
                result = subprocess.run(
                    [str(PACKAGER), str(output)],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                hashlib.sha256(first.read_bytes()).digest(),
                hashlib.sha256(second.read_bytes()).digest(),
            )

    def test_packager_allows_safe_output_outside_legacy_location_boundaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            workspace = temp_root / "workspace"
            fake_home = temp_root / "home"
            fake_temp = temp_root / "configured-temp"
            output = temp_root / "external-output" / "skill.zip"
            for directory in (workspace, fake_home, fake_temp):
                directory.mkdir()
            env = {
                **os.environ,
                "HOME": str(fake_home),
                "USERPROFILE": str(fake_home),
                "TMPDIR": str(fake_temp),
                "TMP": str(fake_temp),
                "TEMP": str(fake_temp),
            }

            result = subprocess.run(
                [str(PACKAGER), str(output)],
                cwd=workspace,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())

    def test_archive_builder_allows_macos_system_temp_alias(self) -> None:
        if sys.platform != "darwin" or not Path("/var").is_symlink() or Path("/var").resolve() != Path("/private/var"):
            self.skipTest("macOS /var system alias is not available")

        with tempfile.TemporaryDirectory(dir="/var/tmp") as temp_dir:
            output = Path(temp_dir) / "skill.zip"
            env = os.environ.copy()
            env.pop("TMPDIR", None)

            result = subprocess.run(
                [sys.executable, str(ARCHIVE_BUILDER), str(CANONICAL_SKILL), str(REPO_ROOT / "LICENSE"), str(output)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())

    def test_archive_builder_rejects_nested_symlink_below_macos_system_temp_alias(self) -> None:
        if sys.platform != "darwin" or not Path("/var").is_symlink() or Path("/var").resolve() != Path("/private/var"):
            self.skipTest("macOS /var system alias is not available")

        with tempfile.TemporaryDirectory(dir="/var/tmp") as temp_dir:
            temp_root = Path(temp_dir)
            redirected_parent = temp_root / "redirected-parent"
            redirected_parent.mkdir()
            safe_parent = temp_root / "safe-parent"
            safe_parent.mkdir()
            (safe_parent / "redirect").symlink_to(redirected_parent, target_is_directory=True)
            output = safe_parent / "redirect" / "nested" / "skill.zip"
            env = os.environ.copy()
            env.pop("TMPDIR", None)

            result = subprocess.run(
                [sys.executable, str(ARCHIVE_BUILDER), str(CANONICAL_SKILL), str(REPO_ROOT / "LICENSE"), str(output)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertFalse((redirected_parent / "nested" / "skill.zip").exists())

    def test_archive_builder_rejects_skill_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            skill = self.copy_skill(temp_root)
            sentinel = temp_root / "outside-sentinel.txt"
            sentinel.write_text("must never enter the skill archive", encoding="utf-8")
            (skill / "references" / "outside-sentinel.txt").symlink_to(sentinel)
            output = temp_root / "skill.zip"

            result = subprocess.run(
                [sys.executable, str(ARCHIVE_BUILDER), str(skill), str(REPO_ROOT / "LICENSE"), str(output)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertFalse(output.exists())

    def test_archive_builder_does_not_follow_output_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            sentinel = temp_root / "outside-sentinel.txt"
            sentinel.write_text("must not be overwritten", encoding="utf-8")
            output = temp_root / "skill.zip"
            output.symlink_to(sentinel)

            result = subprocess.run(
                [sys.executable, str(ARCHIVE_BUILDER), str(CANONICAL_SKILL), str(REPO_ROOT / "LICENSE"), str(output)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "must not be overwritten")
            self.assertTrue(output.is_symlink())

    def test_archive_builder_does_not_follow_output_parent_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            redirected_parent = temp_root / "redirected-parent"
            redirected_parent.mkdir()
            output_parent = temp_root / "output-parent"
            output_parent.symlink_to(redirected_parent, target_is_directory=True)
            output = output_parent / "skill.zip"

            result = subprocess.run(
                [sys.executable, str(ARCHIVE_BUILDER), str(CANONICAL_SKILL), str(REPO_ROOT / "LICENSE"), str(output)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertFalse((redirected_parent / "skill.zip").exists())

    def test_archive_builder_does_not_follow_nested_output_ancestor_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            redirected_parent = temp_root / "redirected-parent"
            redirected_parent.mkdir()
            safe_parent = temp_root / "safe-parent"
            safe_parent.mkdir()
            (safe_parent / "redirect").symlink_to(redirected_parent, target_is_directory=True)
            output = safe_parent / "redirect" / "nested" / "skill.zip"

            result = subprocess.run(
                [sys.executable, str(ARCHIVE_BUILDER), str(CANONICAL_SKILL), str(REPO_ROOT / "LICENSE"), str(output)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertFalse((redirected_parent / "nested" / "skill.zip").exists())

    def test_packager_wrapper_preserves_symlink_ancestor_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            redirected_parent = temp_root / "redirected-parent"
            redirected_parent.mkdir()
            output_parent = temp_root / "output-parent"
            output_parent.symlink_to(redirected_parent, target_is_directory=True)
            output = output_parent / "skill.zip"

            result = subprocess.run(
                [str(PACKAGER), str(output)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertFalse((redirected_parent / "skill.zip").exists())


if __name__ == "__main__":
    unittest.main()
