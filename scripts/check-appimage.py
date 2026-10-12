#!/usr/bin/env python3
"""Validate relocated AppDir/AppStream metadata and AppImageUpdate companions."""
import argparse
from datetime import date
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

APP_ID = "app.hibiki.client"
MAX_APPIMAGE_BYTES = 512 * 1024 * 1024
UPDATE_INFORMATION = "gh-releases-zsync|karbowiak|hibiki|latest|Hibiki_*_amd64.AppImage.zsync"


def local_file(root: Path, path: Path) -> Path:
    """Require a readable file whose symlinks stay within this AppDir."""
    if path.is_symlink() and os.path.isabs(os.readlink(path)):
        raise ValueError(f"{path.name} has an absolute symlink target")
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
        raise ValueError(f"{path.name} is missing or points outside the AppDir")
    return resolved


def check_metainfo(path: Path, desktop_name: str, version: str | None = None) -> None:
    with path.open("rb") as stream:
        data = stream.read(64 * 1024 + 1)
    if len(data) > 64 * 1024 or b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("AppStream metadata is oversized or contains entities")
    component = ET.fromstring(data)
    if component.tag != "component" or component.get("type") != "desktop-application":
        raise ValueError("AppStream component must describe a desktop application")
    for field, expected in (("id", APP_ID), ("name", "Hibiki"), ("project_license", "MIT"), ("metadata_license", "MIT")):
        if component.findtext(field) != expected:
            raise ValueError(f"Incorrect AppStream {field}")
    launchable = component.find("launchable[@type='desktop-id']")
    if launchable is None or launchable.text != desktop_name:
        raise ValueError("AppStream launchable must match the packaged desktop filename")
    releases = component.findall("releases/release")
    if not releases:
        raise ValueError("AppStream release metadata is missing")
    for release in releases:
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[\w.-]+)?", release.get("version", "")):
            raise ValueError("Invalid AppStream release version")
        release_date = release.get("date", "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", release_date):
            raise ValueError("Invalid AppStream release date")
        date.fromisoformat(release_date)
    if version and releases[0].get("version") != version:
        raise ValueError("AppStream version differs from the AppImage version")
    screenshots = component.findall("screenshots/screenshot")
    if not screenshots or screenshots[0].get("type") != "default":
        raise ValueError("AppStream default screenshot is missing")
    for screenshot in screenshots:
        image = screenshot.find("image")
        if image is None or not re.fullmatch(r"https://raw\.githubusercontent\.com/karbowiak/hibiki/(?:main|v[\d.]+)/screenshots/[a-z]+\.png", image.text or ""):
            raise ValueError("AppStream screenshot must use an existing repository PNG URL")
    subprocess.run(["appstreamcli", "validate", "--no-net", str(path)], check=True, timeout=30)


def check_appdir(root: Path, version: str | None = None) -> None:
    app_run = local_file(root, root / "AppRun")
    if not os.access(app_run, os.X_OK):
        raise ValueError("AppRun is not executable")
    local_file(root, root / ".DirIcon")
    desktops = list(root.glob("*.desktop"))
    if len(desktops) != 1 or desktops[0].name != "Hibiki.desktop":
        raise ValueError("expected exactly Hibiki.desktop in the AppDir root")
    desktop = local_file(root, desktops[0])
    subprocess.run(["desktop-file-validate", str(desktop)], check=True, timeout=30)
    in_entry = False
    icon = None
    for line in desktop.read_text().splitlines():
        if line.startswith("["):
            in_entry = line == "[Desktop Entry]"
        elif in_entry and line.startswith("Icon="):
            icon = line.removeprefix("Icon=").strip()
    if not icon or Path(icon).name != icon or icon in (".", ".."):
        raise ValueError("desktop Icon must name an icon in the AppDir root")
    for suffix in (".png", ".svg", ".xpm"):
        path = root / f"{icon}{suffix}"
        if path.exists():
            local_file(root, path)
            break
    else:
        raise ValueError(f"desktop icon {icon} is missing from the AppDir root")
    check_metainfo(local_file(root, root / f"usr/share/metainfo/{APP_ID}.metainfo.xml"), desktop.name, version)


def zsync_parts(path: Path) -> tuple[dict[str, str], bytes]:
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("zsync companion is oversized")
    data = path.read_bytes()
    header, separator, blocks = data.partition(b"\n\n")
    if not separator or len(header) > 16 * 1024:
        raise ValueError("Invalid zsync header")
    fields = {}
    for line in header.decode("ascii").splitlines():
        name, colon, value = line.partition(":")
        if not colon or name in fields:
            raise ValueError("Duplicate or invalid zsync field")
        fields[name] = value.strip()
    return fields, blocks


def check_zsync(image: Path, companion: Path, version: str) -> None:
    fields, blocks = zsync_parts(companion)
    if fields.get("Filename") != image.name or fields.get("Length") != str(image.stat().st_size):
        raise ValueError("zsync filename or length differs from the AppImage")
    canonical_url = f"https://github.com/karbowiak/hibiki/releases/download/v{version}/{image.name}"
    if fields.get("URL") not in (image.name, canonical_url):
        raise ValueError("zsync URL must resolve to this release's AppImage")
    digest = hashlib.sha1()
    with image.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if fields.get("SHA-1") != digest.hexdigest():
        raise ValueError("zsync SHA-1 differs from the complete AppImage bytes")
    blocksize = fields.get("Blocksize", "")
    if not blocksize.isdigit() or not 512 <= int(blocksize) <= 1024 * 1024 or int(blocksize) & (int(blocksize) - 1):
        raise ValueError("Invalid zsync block size")
    # Verify every rolling/MD4 block checksum with the distribution's official
    # zsyncmake, not merely the header's digest. Timestamps/URL text can differ.
    with tempfile.TemporaryDirectory(prefix="hibiki-zsync-") as directory:
        expected = Path(directory) / "expected.zsync"
        subprocess.run(["zsyncmake", "-b", blocksize, "-u", canonical_url, "-o", str(expected), str(image)], check=True, stdout=subprocess.DEVNULL, timeout=120)
        expected_fields, expected_blocks = zsync_parts(expected)
        if fields.get("Hash-Lengths") != expected_fields.get("Hash-Lengths") or blocks != expected_blocks:
            raise ValueError("zsync block checksums differ from the AppImage bytes")


def check_appimage(path: Path, updates: bool = True, prepare_zsync: bool = False) -> None:
    path = path.resolve(strict=True)
    if path.stat().st_size > MAX_APPIMAGE_BYTES:
        raise ValueError("AppImage exceeds the installer size limit")
    match = re.fullmatch(r"Hibiki_(\d+\.\d+\.\d+)_(amd64|aarch64)\.AppImage", path.name)
    if not match or (updates and match.group(2) != "amd64"):
        raise ValueError("Unexpected Hibiki AppImage filename or updater architecture")
    version = match.group(1)
    if updates:
        result = subprocess.run([str(path), "--appimage-updateinformation"], check=True, capture_output=True, text=True, timeout=30)
        if result.stdout.strip() != UPDATE_INFORMATION:
            raise ValueError("AppImage update information is missing or uses another release channel")
        companion = Path(str(path) + ".zsync")
        if prepare_zsync:
            # appimagetool's working-directory sidecar location varies between
            # bundlers. Generate the companion beside the final signed bytes;
            # this never rewrites the AppImage or its Tauri signature.
            subprocess.run(["zsyncmake", "-u", path.name, "-o", str(companion), str(path)], check=True, stdout=subprocess.DEVNULL, timeout=120)
        check_zsync(path, companion, version)
    with tempfile.TemporaryDirectory(prefix="hibiki-appimage-") as directory:
        result = subprocess.run([str(path), "--appimage-extract"], cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
        if result.returncode:
            raise ValueError("AppImage extraction failed")
        check_appdir(Path(directory) / "squashfs-root", version)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimages", type=Path, nargs="+")
    parser.add_argument("--no-updates", action="store_true", help="Skip update checks for packaging diagnostics")
    parser.add_argument("--prepare-zsync", action="store_true", help="Generate a companion beside the final AppImage before validating")
    args = parser.parse_args()
    for path in args.appimages:
        try:
            check_appimage(path, not args.no_updates, args.prepare_zsync)
        except (OSError, ValueError, ET.ParseError, subprocess.SubprocessError) as error:
            parser.exit(1, f"{path.name}: {error}\n")
        checks = "AppDir and AppStream metadata OK (update checks skipped)" if args.no_updates else "AppDir, AppStream and update metadata OK"
        print(f"{path.name}: {checks}")


if __name__ == "__main__":
    main()
