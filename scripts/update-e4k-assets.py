"""Extract selected mobile images after the GitHub finder selects a loader."""

import argparse
import hashlib
import json
import re
import shutil
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

ASSET_FOLDERS = ("Buildings", "BuildingSkins", "ConstructionItems")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def selected_asset(name):
    # Never use ZIP extraction paths directly: reject absolute/traversing paths.
    parts = PurePosixPath(name).parts
    return (bool(parts) and parts[0] in ASSET_FOLDERS and
            not name.startswith("/") and "\\" not in name and
            all(part not in (".", "..") and ":" not in part for part in parts) and
            name.lower().endswith(".png"))


def asset_base(config):
    loader = str(config.get("loaderVersion", ""))
    if not re.fullmatch(r"\d{7,10}", loader):
        raise ValueError("Invalid finder loaderVersion")
    parsed = urlparse(config.get("versionsUrl", ""))
    if (parsed.scheme != "https" or parsed.hostname not in
            ("media-s3.goodgamestudios.com", "media.goodgamestudios.com") or
            parsed.path not in (f"/loader/{loader}/versions.json",
                                f"/loader-preClient/{loader}/versions.json") or
            parsed.query or parsed.fragment):
        raise ValueError("Unexpected finder versionsUrl")
    return config["versionsUrl"].rsplit("/", 1)[0] + "/itemAssets/"


def download_package(url, target):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ggempire-data-cache/1.0"})
            with urllib.request.urlopen(request, timeout=180) as response, target.open("wb") as output:
                shutil.copyfileobj(response, output)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def cached_assets_valid(manifest, config, output):
    if (manifest.get("schemaVersion") != 1 or
            manifest.get("loaderVersion") != str(config["loaderVersion"]) or
            manifest.get("itemVersion") != str(config["itemVersion"]) or
            manifest.get("folders") != list(ASSET_FOLDERS) or
            not manifest.get("assets")):
        return False
    for entry in manifest["assets"]:
        relative = entry.get("file", "")
        parts = PurePosixPath(relative).parts
        if (len(parts) < 4 or parts[0] != str(config["loaderVersion"]) or
                not re.fullmatch(r"package_[012]", parts[1]) or
                not selected_asset("/".join(parts[2:]))):
            return False
        file = output.joinpath(*parts)
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != entry.get("sha256"):
            return False
    return True


def update_assets(config_path, output, download=download_package):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    base = asset_base(config)
    loader = str(config["loaderVersion"])
    manifest_path = output / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    if cached_assets_valid(previous, config, output):
        print(f"E4K assets already verified: {loader} / {config['itemVersion']}")
        return previous

    # Finish all downloads and validations before publishing any files.
    assets = []
    packages = []
    with tempfile.TemporaryDirectory(prefix="e4k-item-assets-") as temporary:
        staging = Path(temporary)
        for number in range(3):
            url = f"{base}package_{number}_x768.ggs"
            archive = staging / f"package_{number}.ggs"
            print(f"Downloading {url}", flush=True)
            download(url, archive)
            packages.append(url)
            seen = set()
            with zipfile.ZipFile(archive) as package:
                for entry in package.infolist():
                    if entry.is_dir() or not selected_asset(entry.filename):
                        continue
                    if entry.filename in seen:
                        raise ValueError(f"Duplicate asset within package {number}: {entry.filename}")
                    seen.add(entry.filename)
                    image = package.read(entry)  # zipfile verifies each extracted file's CRC.
                    if not image.startswith(PNG_SIGNATURE):
                        raise ValueError(f"Invalid PNG: {entry.filename}")
                    relative = f"{loader}/package_{number}/{entry.filename}"
                    target = staging / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(image)
                    assets.append({"path": entry.filename, "file": relative,
                                   "package": number, "bytes": len(image),
                                   "sha256": hashlib.sha256(image).hexdigest()})
            archive.unlink()
        if not assets:
            raise ValueError("No selected E4K images found; preserving previous manifest")
        assets.sort(key=lambda item: (item["path"], item["package"]))
        manifest = {"schemaVersion": 1, "loaderVersion": loader,
                    "itemVersion": str(config["itemVersion"]), "resolution": "x768",
                    "folders": list(ASSET_FOLDERS), "packages": packages,
                    "count": len(assets), "bytes": sum(item["bytes"] for item in assets),
                    "assets": assets}
        output.mkdir(parents=True, exist_ok=True)
        for item in assets:
            target = output / item["file"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(staging / item["file"], target)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Stored {manifest['count']} images ({manifest['bytes']} bytes) for loader {loader}")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config/e4k-loader.json"))
    parser.add_argument("--output", type=Path, default=Path("public/assets/e4k"))
    args = parser.parse_args()
    update_assets(args.config, args.output)
