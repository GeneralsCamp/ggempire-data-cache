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

    def download(self, url, target):
        self.calls.append(url)
        number = int(url.split("package_")[1][0])
        with zipfile.ZipFile(target, "w") as package:
            for folder in assets.ASSET_FOLDERS:
                package.writestr(f"{folder}/Example/Example.png", assets.PNG_SIGNATURE + bytes([number]))
            package.writestr("Units/Example.png", assets.PNG_SIGNATURE)
            package.writestr("Buildings/Example/animation.json", "{}")
            package.writestr("Buildings/../outside.png", assets.PNG_SIGNATURE)

    def test_selected_folders_and_duplicate_paths_are_preserved(self):
        result = assets.update_assets(self.config, self.output, self.download)
        self.assertEqual(result["count"], 9)
        self.assertEqual(len(self.calls), 3)
        for item in result["assets"]:
            file = self.output / item["file"]
            self.assertEqual(file.read_bytes()[-1], item["package"])
            self.assertTrue(file.exists())
        self.assertFalse((self.output / "outside.png").exists())

    def test_repeat_run_reuses_files_and_repairs_missing_files(self):
        first = assets.update_assets(self.config, self.output, self.download)
        self.calls.clear()
        self.assertEqual(assets.update_assets(self.config, self.output, self.download), first)
        self.assertEqual(self.calls, [])
        (self.output / first["assets"][0]["file"]).unlink()
        assets.update_assets(self.config, self.output, self.download)
        self.assertEqual(len(self.calls), 3)

    def test_failed_package_preserves_previous_files_and_manifest(self):
        first = assets.update_assets(self.config, self.output, self.download)
        before = (self.output / "manifest.json").read_bytes()
        config = json.loads(self.config.read_text())
        config["itemVersion"] = "787.RC.02"
        self.config.write_text(json.dumps(config))
        def fail(url, target):
            if "package_1" in url:
                raise RuntimeError("Download failed")
            self.download(url, target)
        with self.assertRaisesRegex(RuntimeError, "Download failed"):
            assets.update_assets(self.config, self.output, fail)
        self.assertEqual((self.output / "manifest.json").read_bytes(), before)
        self.assertEqual((self.output / first["assets"][0]["file"]).read_bytes()[:8], assets.PNG_SIGNATURE)

    def test_crc_and_unexpected_source_are_rejected(self):
        def corrupt(url, target):
            self.download(url, target)
            content = target.read_bytes()
            target.write_bytes(content.replace(assets.PNG_SIGNATURE, b"broken!!", 1))
        with self.assertRaises(zipfile.BadZipFile):
            assets.update_assets(self.config, self.output, corrupt)
        self.assertFalse((self.output / "manifest.json").exists())
        with self.assertRaises(ValueError):
            assets.asset_base({"loaderVersion": "4143095", "versionsUrl": "https://example.com/loader/4143095/versions.json"})


if __name__ == "__main__":
    unittest.main()
