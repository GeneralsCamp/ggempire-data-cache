import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("e4k_assets", Path(__file__).with_name("update-e4k-assets.py"))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class FinderAssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"loaderVersion": "4143095", "itemVersion": "787.RC.01",
            "versionsUrl": "https://media-s3.goodgamestudios.com/loader/4143095/versions.json"}))
        self.output = self.root / "output"
        self.calls = []
        self.image_reads = []

    def archive_bytes(self, number):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as package:
            for folder in assets.ASSET_FOLDERS:
                package.writestr(f"{folder}/Example/Example.png", assets.PNG_SIGNATURE + bytes([number]))
            package.writestr("Units/Example.png", assets.PNG_SIGNATURE)
            package.writestr("ConstructionItems/Example.png", assets.PNG_SIGNATURE)
            package.writestr("Buildings/Example/animation.json", "{}")
            package.writestr("Buildings/../outside.png", assets.PNG_SIGNATURE)
        return stream.getvalue()

    def open_archive(self, url):
        self.calls.append(url)
        number = int(url.split("package_")[1][0])
        owner = self
        class TrackedZip(zipfile.ZipFile):
            def read(self, name, *args, **kwargs):
                owner.image_reads.append(name.filename if isinstance(name, zipfile.ZipInfo) else name)
                return super().read(name, *args, **kwargs)
        return TrackedZip(io.BytesIO(self.archive_bytes(number)))

    def test_selected_folders_and_duplicate_paths_are_preserved(self):
        result = assets.update_assets(self.config, self.output, self.open_archive)
        self.assertEqual(result["count"], 6)
        self.assertEqual(len(self.calls), 3)
        for item in result["assets"]:
            file = self.output / item["file"]
            self.assertEqual(file.read_bytes()[-1], item["package"])
            self.assertTrue(file.exists())
        self.assertFalse((self.output / "outside.png").exists())

    def test_repeat_run_reuses_files_and_repairs_missing_files(self):
        first = assets.update_assets(self.config, self.output, self.open_archive)
        self.calls.clear()
        self.assertEqual(assets.update_assets(self.config, self.output, self.open_archive), first)
        self.assertEqual(self.calls, [])
        (self.output / first["assets"][0]["file"]).unlink()
        assets.update_assets(self.config, self.output, self.open_archive)
        self.assertEqual(len(self.calls), 3)

    def test_failed_package_preserves_previous_files_and_manifest(self):
        first = assets.update_assets(self.config, self.output, self.open_archive)
        before = (self.output / "manifest.json").read_bytes()
        config = json.loads(self.config.read_text())
        config["itemVersion"] = "787.RC.02"
        self.config.write_text(json.dumps(config))
        def fail(url):
            if "package_1" in url:
                raise RuntimeError("Download failed")
            return self.open_archive(url)
        with self.assertRaisesRegex(RuntimeError, "Download failed"):
            assets.update_assets(self.config, self.output, fail)
        self.assertEqual((self.output / "manifest.json").read_bytes(), before)
        self.assertEqual((self.output / first["assets"][0]["file"]).read_bytes()[:8], assets.PNG_SIGNATURE)

    def test_crc_and_unexpected_source_are_rejected(self):
        def corrupt(url):
            content = self.archive_bytes(0).replace(assets.PNG_SIGNATURE, b"broken!!", 1)
            return zipfile.ZipFile(io.BytesIO(content))
        with self.assertRaises(zipfile.BadZipFile):
            assets.update_assets(self.config, self.output, corrupt)
        self.assertFalse((self.output / "manifest.json").exists())
        with self.assertRaises(ValueError):
            assets.asset_base({"loaderVersion": "4143095", "versionsUrl": "https://example.com/loader/4143095/versions.json"})

    def test_new_loader_reuses_images_without_downloading_their_contents(self):
        first = assets.update_assets(self.config, self.output, self.open_archive)
        self.image_reads.clear()
        config = json.loads(self.config.read_text())
        config["loaderVersion"] = "4143096"
        config["versionsUrl"] = "https://media-s3.goodgamestudios.com/loader/4143096/versions.json"
        self.config.write_text(json.dumps(config))
        second = assets.update_assets(self.config, self.output, self.open_archive)
        self.assertEqual(self.image_reads, [])
        self.assertEqual([x["file"] for x in first["assets"]], [x["file"] for x in second["assets"]])
        self.assertEqual(len(list((self.output / "files").glob("*.png"))), 3)

    def test_changed_png_downloads_only_that_entry(self):
        assets.update_assets(self.config, self.output, self.open_archive)
        self.image_reads.clear()
        config = json.loads(self.config.read_text())
        config["itemVersion"] = "787.RC.02"
        self.config.write_text(json.dumps(config))
        original = self.archive_bytes
        def changed(number):
            if number != 1:
                return original(number)
            content = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(original(number))) as old, zipfile.ZipFile(content, "w") as new:
                for entry in old.infolist():
                    image = old.read(entry)
                    if entry.filename == "Buildings/Example/Example.png":
                        image += b"changed"
                    new.writestr(entry.filename, image)
            return content.getvalue()
        self.archive_bytes = changed
        assets.update_assets(self.config, self.output, self.open_archive)
        self.assertEqual(self.image_reads, ["Buildings/Example/Example.png"])

    def test_remote_zip_reads_only_requested_ranges(self):
        content = self.archive_bytes(0)
        ranges = []
        def fetch(url, requested):
            ranges.append(requested)
            value = requested.removeprefix("bytes=")
            if value.startswith("-"):
                start, end = max(0, len(content) - int(value[1:])), len(content) - 1
            else:
                start, end = map(int, value.split("-"))
            return content[start:end + 1], f"bytes {start}-{end}/{len(content)}"
        with zipfile.ZipFile(assets.RemoteZip("https://example.com/package.ggs", fetch)) as package:
            self.assertEqual(package.read("Buildings/Example/Example.png"), assets.PNG_SIGNATURE + bytes([0]))
        self.assertTrue(all(value.startswith("bytes=") for value in ranges))


if __name__ == "__main__":
    unittest.main()
