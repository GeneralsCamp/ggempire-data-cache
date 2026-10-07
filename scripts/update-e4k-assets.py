"""Extract selected mobile images after the GitHub finder selects a loader."""

import argparse
import hashlib
import io
import json
import re
import time
import urllib.request
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

ASSET_FOLDERS = ("Buildings", "BuildingSkins", "Units", "Equipment")
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


def fetch_range(url, requested_range):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={
                "User-Agent": "ggempire-data-cache/1.0", "Range": requested_range,
                "Accept-Encoding": "identity"})
            with urllib.request.urlopen(request, timeout=90) as response:
                content_range = response.headers.get("Content-Range", "")
                if response.status != 206 or not content_range:
                    raise RuntimeError("The asset server must support byte ranges")
                return response.read(), content_range
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


class RemoteZip(io.RawIOBase):
    """Seekable ZIP source: download the directory and requested entries only."""
    def __init__(self, url, fetch=fetch_range):
        self.url, self.fetch, self.position = url, fetch, 0
        tail, header = fetch(url, "bytes=-65557")
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", header)
        if not match or len(tail) != int(match[2]) - int(match[1]) + 1:
            raise ValueError("Invalid ZIP tail byte range")
        self.length = int(match[3])
        self.cached_start, self.cached = int(match[1]), tail

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset if whence == 0 else (self.position if whence == 1 else self.length) + offset
        if position < 0:
            raise ValueError("Negative ZIP seek")
        self.position = position
        return position

    def read(self, size=-1):
        size = min(self.length - self.position, size if size >= 0 else self.length)
        if size <= 0:
            return b""
        if size > 16 * 1024 * 1024:
            raise ValueError("Unexpectedly large ZIP read")
        start, end = self.position, self.position + size
        if self.cached_start <= start and end <= self.cached_start + len(self.cached):
            data = self.cached[start - self.cached_start:end - self.cached_start]
        else:
            data, header = self.fetch(self.url, f"bytes={start}-{end - 1}")
            if header != f"bytes {start}-{end - 1}/{self.length}" or len(data) != size:
                raise ValueError("Invalid ZIP entry byte range")
        self.position = end
        return data


def open_remote_archive(url):
    return zipfile.ZipFile(RemoteZip(url))


def safe_image_file(relative):
    if re.fullmatch(r"files/[a-f0-9]{64}\.png", relative):
        return True
    parts = PurePosixPath(relative).parts
    return (len(parts) >= 4 and re.fullmatch(r"\d{7,10}", parts[0]) and
            re.fullmatch(r"package_[012]", parts[1]) and
            selected_asset("/".join(parts[2:])))


def reusable_images(output, previous):
    manifests = [previous]
    images = {}
    checked = {}
    for manifest in manifests:
        for entry in manifest.get("assets", []):
            relative = entry.get("file", "")
            if not safe_image_file(relative):
                continue
            if relative not in checked:
                file = output / relative
                image = file.read_bytes() if file.is_file() else b""
                digest = hashlib.sha256(image).hexdigest()
                checked[relative] = (image, digest)
            image, digest = checked[relative]
            if not image.startswith(PNG_SIGNATURE) or digest != entry.get("sha256"):
                continue
            key = (entry["path"], zlib.crc32(image), len(image))
            images[key] = {**entry, "crc32": key[1]}
    return images


def cached_assets_valid(manifest, config, output):
    if (manifest.get("schemaVersion") != 2 or
            manifest.get("loaderVersion") != str(config["loaderVersion"]) or
            manifest.get("itemVersion") != str(config["itemVersion"]) or
            manifest.get("folders") != list(ASSET_FOLDERS) or
            not manifest.get("assets")):
        return False
    for entry in manifest["assets"]:
        relative = entry.get("file", "")
        if not safe_image_file(relative):
            return False
        file = output / relative
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != entry.get("sha256"):
            return False
    return True


def update_assets(config_path, output, open_archive=open_remote_archive):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    base = asset_base(config)
    loader = str(config["loaderVersion"])
    manifest_path = output / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    if cached_assets_valid(previous, config, output):
        print(f"E4K assets already verified: {loader} / {config['itemVersion']}")
        return previous

    reuse = reusable_images(output, previous)
    assets, packages, pending = [], [], {}
    downloaded, reused = 0, 0
    for number in range(3):
        url = f"{base}package_{number}_x768.ggs"
        print(f"Reading ZIP directory: {url}", flush=True)
        packages.append(url)
        seen = set()
        with open_archive(url) as package:
            for entry in package.infolist():
                if entry.is_dir() or not selected_asset(entry.filename):
                    continue
                if entry.filename in seen:
                    raise ValueError(f"Duplicate asset within package {number}: {entry.filename}")
                seen.add(entry.filename)
                existing = reuse.get((entry.filename, entry.CRC, entry.file_size))
                if existing:
                    relative, digest = existing["file"], existing["sha256"]
                    reused += 1
                else:
                    image = package.read(entry)  # zipfile validates the downloaded PNG's CRC.
                    if not image.startswith(PNG_SIGNATURE):
                        raise ValueError(f"Invalid PNG: {entry.filename}")
                    digest = hashlib.sha256(image).hexdigest()
                    relative = f"files/{digest}.png"
                    pending[relative] = image
                    reuse[(entry.filename, entry.CRC, entry.file_size)] = {
                        "file": relative, "sha256": digest}
                    downloaded += 1
                assets.append({"path": entry.filename, "file": relative,
                               "package": number, "bytes": entry.file_size,
                               "crc32": entry.CRC, "sha256": digest})
    if not assets:
        raise ValueError("No selected E4K images found; preserving previous manifest")
    assets.sort(key=lambda item: (item["path"], item["package"]))
    manifest = {"schemaVersion": 2, "loaderVersion": loader,
                "itemVersion": str(config["itemVersion"]), "resolution": "x768",
                "folders": list(ASSET_FOLDERS), "packages": packages,
                "count": len(assets), "bytes": sum(item["bytes"] for item in assets),
                "assets": assets}
    # No repository changes until all three directories and needed PNGs validate.
    for relative, image in pending.items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or target.read_bytes() != image:
            target.write_bytes(image)
    output.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest, indent=2) + "\n"
    manifest_path.write_text(text, encoding="utf-8")
    print(f"Indexed {len(assets)} images; downloaded {downloaded}, reused {reused}.")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config/e4k-loader.json"))
    parser.add_argument("--output", type=Path, default=Path("public/assets/e4k"))
    args = parser.parse_args()
    update_assets(args.config, args.output)
