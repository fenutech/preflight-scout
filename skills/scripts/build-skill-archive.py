#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import stat
import sys
import uuid
import zipfile
from pathlib import Path


ARCHIVE_ROOT = "preflight-scout"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def zip_info(name: str, *, directory: bool, executable: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_TIMESTAMP)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    if directory:
        info.external_attr = (stat.S_IFDIR | 0o755) << 16 | 0x10
    else:
        mode = 0o755 if executable else 0o644
        info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def build_archive(skill_root: Path, license_path: Path, output: Path) -> None:
    skill_root = skill_root.absolute()
    license_path = license_path.absolute()
    output = output.absolute()

    if skill_root.is_symlink() or not skill_root.is_dir():
        raise ValueError(f"Skill root must be a regular directory, not a symlink: {skill_root}")
    if license_path.is_symlink() or not license_path.is_file():
        raise ValueError(f"License must be a regular file, not a symlink: {license_path}")
    if output.is_symlink():
        raise ValueError(f"Archive output cannot be a symlink: {output}")
    if output.exists() and not output.is_file():
        raise ValueError(f"Archive output must be a regular file: {output}")

    skill_root = skill_root.resolve()
    license_path = license_path.resolve()

    entries: dict[str, Path | None] = {f"{ARCHIVE_ROOT}/": None}
    for source in skill_root.rglob("*"):
        if source.is_symlink():
            raise ValueError(f"Skill archives cannot contain symlinks: {source.relative_to(skill_root)}")
        if source.name == ".DS_Store":
            continue
        relative = source.relative_to(skill_root).as_posix()
        archive_name = f"{ARCHIVE_ROOT}/{relative}"
        if source.is_dir():
            archive_name += "/"
            entries[archive_name] = None
        elif source.is_file():
            entries[archive_name] = source
        else:
            raise ValueError(f"Unsupported skill entry: {source}")

    entries[f"{ARCHIVE_ROOT}/LICENSE"] = license_path
    output = normalize_system_temp_alias(output)
    output_boundary = Path(output.anchor)
    ensure_safe_output_parent(output_boundary, output.parent)
    assert_safe_output_leaf(output)

    temporary = output.parent / f".{output.name}.preflight-scout-{os.getpid()}-{uuid.uuid4().hex}.tmp"
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for archive_name in sorted(entries):
                source = entries[archive_name]
                if source is None:
                    archive.writestr(zip_info(archive_name, directory=True), b"")
                    continue
                source_stats = source.lstat()
                if not stat.S_ISREG(source_stats.st_mode) or source_stats.st_nlink != 1:
                    raise ValueError(f"Skill archive source must be a single-link regular file: {source}")
                executable = bool(source_stats.st_mode & 0o111)
                archive.writestr(
                    zip_info(archive_name, directory=False, executable=executable),
                    source.read_bytes(),
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )

        ensure_safe_output_parent(output_boundary, output.parent)
        assert_safe_output_leaf(output)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def normalize_system_temp_alias(output: Path) -> Path:
    """Normalize only macOS's known lexical aliases for system temporary trees."""
    if sys.platform != "darwin":
        return output

    # macOS exposes these temporary trees through /tmp and /var while their
    # canonical locations live below /private. Resolve only these exact system
    # aliases. Resolving the complete output would follow user-created symlinks
    # below the temporary root and defeat the component-by-component check.
    aliases = (
        (Path("/tmp"), Path("/private/tmp"), Path("/tmp"), Path("/private/tmp")),
        (Path("/var/tmp"), Path("/private/var/tmp"), Path("/var"), Path("/private/var")),
        (Path("/var/folders"), Path("/private/var/folders"), Path("/var"), Path("/private/var")),
    )
    for lexical_root, canonical_root, alias, expected_target in aliases:
        try:
            relative = output.relative_to(lexical_root)
        except ValueError:
            continue
        if alias.is_symlink() and alias.resolve(strict=True) == expected_target:
            return canonical_root / relative
    return output


def ensure_safe_output_parent(boundary: Path, parent: Path) -> None:
    try:
        relative = parent.relative_to(boundary)
    except ValueError as error:
        raise ValueError(f"Archive output escapes its trusted boundary: {parent}") from error

    boundary_stats = boundary.lstat()
    if stat.S_ISLNK(boundary_stats.st_mode) or not stat.S_ISDIR(boundary_stats.st_mode):
        raise ValueError(f"Archive output boundary must be a regular directory, not a symlink: {boundary}")

    cursor = boundary
    for part in relative.parts:
        cursor = cursor / part
        try:
            cursor_stats = cursor.lstat()
        except FileNotFoundError:
            cursor.mkdir(mode=0o700)
            cursor_stats = cursor.lstat()
        if stat.S_ISLNK(cursor_stats.st_mode) or not stat.S_ISDIR(cursor_stats.st_mode):
            raise ValueError(f"Archive output path cannot traverse a symlink or non-directory: {cursor}")


def assert_safe_output_leaf(output: Path) -> None:
    try:
        output_stats = output.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(output_stats.st_mode):
        raise ValueError(f"Archive output cannot be a symlink: {output}")
    if not stat.S_ISREG(output_stats.st_mode):
        raise ValueError(f"Archive output must be a regular file: {output}")
    if output_stats.st_nlink != 1:
        raise ValueError(f"Archive output cannot be a hard-linked file: {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a deterministic Agent Skill ZIP")
    parser.add_argument("skill_root", type=Path)
    parser.add_argument("license", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_archive(args.skill_root, args.license, args.output)


if __name__ == "__main__":
    main()
