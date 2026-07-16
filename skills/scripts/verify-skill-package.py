#!/usr/bin/env python3

from __future__ import annotations

import argparse
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


ARCHIVE_ROOT = "preflight-scout"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
REQUIRED_FILES = {
    f"{ARCHIVE_ROOT}/LICENSE",
    f"{ARCHIVE_ROOT}/SKILL.md",
    f"{ARCHIVE_ROOT}/agents/openai.yaml",
    f"{ARCHIVE_ROOT}/references/cli-installation.md",
}


def fail(message: str) -> None:
    print(f"Invalid skill package: {message}", file=sys.stderr)
    raise SystemExit(1)


def verify_archive(archive_path: Path, validator: Path) -> None:
    if not archive_path.is_file():
        fail(f"missing archive: {archive_path}")

    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if not names:
            fail("archive is empty")
        if len(names) != len(set(names)):
            fail("archive contains duplicate paths")
        if names != sorted(names):
            fail("archive entries are not sorted")

        for entry in entries:
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts:
                fail(f"unsafe path: {entry.filename}")
            if not path.parts or path.parts[0] != ARCHIVE_ROOT:
                fail(f"entry is outside the top-level {ARCHIVE_ROOT}/ directory: {entry.filename}")
            if entry.date_time != FIXED_TIMESTAMP:
                fail(f"non-deterministic timestamp on {entry.filename}")
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                fail(f"archive contains a symlink: {entry.filename}")
            if path.name == ".DS_Store":
                fail("archive contains .DS_Store")

        missing = REQUIRED_FILES - set(names)
        if missing:
            fail(f"archive is missing: {', '.join(sorted(missing))}")

        with tempfile.TemporaryDirectory(prefix="preflight-scout-skill-verify-") as temp_dir:
            archive.extractall(temp_dir)
            result = subprocess.run(
                [sys.executable, str(validator), str(Path(temp_dir) / ARCHIVE_ROOT)],
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode != 0:
                detail = result.stderr.strip() or result.stdout.strip()
                fail(f"packaged skill failed validation: {detail}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify a packaged Agent Skill ZIP")
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--validator",
        type=Path,
        default=Path(__file__).with_name("validate-skill.py"),
    )
    args = parser.parse_args()
    verify_archive(args.archive.resolve(), args.validator.resolve())
    print(f"Valid skill package: {args.archive.resolve()}")


if __name__ == "__main__":
    main()
