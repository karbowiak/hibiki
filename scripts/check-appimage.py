#!/usr/bin/env python3
"""Check AppImage metadata after extraction, away from the build AppDir."""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile


def local_file(root: Path, path: Path) -> Path:
    """Require a readable file whose symlinks stay within this AppDir."""
    if path.is_symlink() and os.path.isabs(os.readlink(path)):
        raise ValueError(f"{path.name} has an absolute symlink target")
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise ValueError(f"{path.name} is missing or points outside the AppDir")
    return resolved


def check_appdir(root: Path) -> None:
    app_run = local_file(root, root / "AppRun")
    if not os.access(app_run, os.X_OK):
        raise ValueError("AppRun is not executable")
    local_file(root, root / ".DirIcon")

    desktops = list(root.glob("*.desktop"))
    if len(desktops) != 1:
        raise ValueError("expected exactly one desktop file in the AppDir root")
    desktop = local_file(root, desktops[0])
    subprocess.run(["desktop-file-validate", str(desktop)], check=True)

    # The root icon must match Icon= in the desktop entry (AppDir specification).
    in_entry = False
    icon = None
    for line in desktop.read_text().splitlines():
        if line.startswith("["):
            in_entry = line == "[Desktop Entry]"
        elif in_entry and line.startswith("Icon="):
            icon = line.removeprefix("Icon=").strip()
    if not icon or Path(icon).name != icon or icon in (".", ".."):
        raise ValueError("desktop Icon must name an icon in the AppDir root")
    icons = [root / f"{icon}{suffix}" for suffix in (".png", ".svg", ".xpm")]
    for path in icons:
        if path.exists():
            local_file(root, path)
            break
    else:
        raise ValueError(f"desktop icon {icon} is missing from the AppDir root")


def check_appimage(path: Path) -> None:
    path = path.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="hibiki-appimage-") as directory:
        result = subprocess.run(
            [str(path), "--appimage-extract"],
            cwd=directory,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        if result.returncode:
            raise ValueError(f"AppImage extraction failed:\n{result.stdout}")
        check_appdir(Path(directory) / "squashfs-root")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimages", type=Path, nargs="+")
    args = parser.parse_args()
    for path in args.appimages:
        try:
            check_appimage(path)
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            parser.exit(1, f"{path.name}: {error}\n")
        print(f"{path.name}: AppDir metadata OK")


if __name__ == "__main__":
    main()
