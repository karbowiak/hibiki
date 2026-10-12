#!/usr/bin/env python3
"""Offline boundary regressions for AppImage packaging validation."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("validator", Path(__file__).with_name("check-appimage.py"))
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.image = self.root / "Hibiki_0.5.5_amd64.AppImage"
        self.image.write_bytes(b"installer bytes")
        self.companion = Path(str(self.image) + ".zsync")
        self.fields = {
            "zsync": "0.6.2", "Filename": self.image.name,
            "Length": str(self.image.stat().st_size), "Blocksize": "2048",
            "Hash-Lengths": "1,2,3", "URL": self.image.name,
            "SHA-1": hashlib.sha1(self.image.read_bytes()).hexdigest(),
        }
        self.metadata = self.root / "metadata.xml"
        template = (Path(__file__).parent.parent / "src-tauri/linux/app.hibiki.client.metainfo.xml.in").read_text()
        self.xml = template.replace("@VERSION@", "0.5.5").replace("@DATE@", "2026-10-12").replace("@RELEASE_TYPE@", "stable")
        self.metadata.write_text(self.xml)

    def tearDown(self):
        self.directory.cleanup()

    def write_zsync(self, path=None, fields=None, blocks=b"block table"):
        (path or self.companion).write_bytes(("\n".join(f"{key}: {value}" for key, value in (fields or self.fields).items()) + "\n\n").encode() + blocks)

    def test_valid_metadata_and_exact_launchable(self):
        with patch.object(validator.subprocess, "run") as run:
            validator.check_metainfo(self.metadata, "Hibiki.desktop", "0.5.5")
            self.assertEqual(run.call_args.args[0][:3], ["appstreamcli", "validate", "--no-net"])
            with self.assertRaises(ValueError):
                validator.check_metainfo(self.metadata, "hibiki.desktop", "0.5.5")

    def test_metadata_wrong_version_license_screenshot_and_entities(self):
        for xml in [self.xml.replace('version="0.5.5"', 'version="0.5.4"'), self.xml.replace("<project_license>MIT", "<project_license>GPL"), self.xml.replace("raw.githubusercontent.com", "example.com"), "<!DOCTYPE component>" + self.xml]:
            self.metadata.write_text(xml)
            with patch.object(validator.subprocess, "run"), self.assertRaises(ValueError):
                validator.check_metainfo(self.metadata, "Hibiki.desktop", "0.5.5")

    def test_relocated_relative_links_only(self):
        icon = self.root / "icon.png"
        icon.write_bytes(b"icon")
        link = self.root / ".DirIcon"
        link.symlink_to("icon.png")
        self.assertEqual(validator.local_file(self.root, link), icon.resolve())
        link.unlink(); link.symlink_to(icon)
        with self.assertRaises(ValueError): validator.local_file(self.root, link)
        link.unlink(); link.symlink_to("../outside.png")
        with self.assertRaises(ValueError): validator.local_file(self.root, link)

    def test_actual_checksum_table_required(self):
        self.write_zsync()
        def regenerate(command, **kwargs):
            self.write_zsync(Path(command[command.index("-o") + 1]))
        with patch.object(validator.subprocess, "run", side_effect=regenerate):
            validator.check_zsync(self.image, self.companion, "0.5.5")
            self.write_zsync(blocks=b"corrupted block table")
            with self.assertRaisesRegex(ValueError, "block checksums"):
                validator.check_zsync(self.image, self.companion, "0.5.5")

    def test_wrong_digest_url_length_and_blocksize(self):
        for key, value in [("SHA-1", "bad"), ("URL", "https://example.com/installer"), ("Length", "1"), ("Blocksize", "513"), ("URL", "https://github.com/karbowiak/hibiki/releases/download/v0.5.4/" + self.image.name)]:
            self.write_zsync(fields={**self.fields, key: value})
            with self.assertRaises(ValueError): validator.check_zsync(self.image, self.companion, "0.5.5")

    def test_duplicate_and_unbounded_header_rejected(self):
        self.companion.write_bytes(b"URL: image\nURL: other\n\nblocks")
        with self.assertRaises(ValueError): validator.zsync_parts(self.companion)
        self.companion.write_bytes(b"x" * 16385 + b"\n\n")
        with self.assertRaises(ValueError): validator.zsync_parts(self.companion)


if __name__ == "__main__":
    unittest.main()
