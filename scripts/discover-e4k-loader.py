import argparse
import io
import json
import re
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests
import xmltodict


APP_LOOKUP_URL = "https://itunes.apple.com/lookup?id=585661281&country=de"
LOADER_BASES = (
    "https://media-s3.goodgamestudios.com/loader",
    "https://media.goodgamestudios.com/loader",
)
DEV_MINOR_LOOKAHEAD = 3
DEV_PATCH_LIMIT = 1000
SEARCH_BATCH_SIZE = 25


def get_app_store_loader():
    response = requests.get(APP_LOOKUP_URL, timeout=30)
    response.raise_for_status()
    app_store_version = response.json()["results"][0]["version"]
    major, minor, patch = app_store_version.split(".")
    return app_store_version, f"{major}{minor}{patch.zfill(3)}"


def fetch_versions(loader):
    last_error = None
    for base in LOADER_BASES:
        url = f"{base}/{loader}/versions.json"
        try:
            response = requests.get(url, timeout=5)
            response.raise_for_status()
            return {
                "loader": str(loader),
                "versions": response.json(),
                "loaderBase": base,
                "versionsUrl": url,
            }
        except Exception as error:
            last_error = error
    raise last_error


def parse_loader(loader):
    match = re.match(r"^(\d)(\d{3})(\d{3})$", str(loader))
    if not match:
        return None
    return tuple(int(value) for value in match.groups())


def format_loader(major, minor, patch):
    return f"{major}{minor:03d}{patch:03d}"


def build_candidates(api_loader):
    parsed = parse_loader(api_loader)
    if not parsed:
        raise ValueError(f"Unexpected loader version: {api_loader}")

    major, minor, current_patch = parsed
    candidates = set()
    for minor_offset in range(1, DEV_MINOR_LOOKAHEAD + 1):
        for patch in range(DEV_PATCH_LIMIT):
            candidates.add(int(format_loader(major, minor + minor_offset, patch)))
    for patch in range(current_patch + 1, DEV_PATCH_LIMIT):
        candidates.add(int(format_loader(major, minor, patch)))
    return sorted(candidates, reverse=True)


def parse_item_version(version):
    return [(-1 if part == "RC" else int(part))
            for part in re.findall(r"\d+|RC", str(version).upper())]


def compare_item_versions(left, right):
    left_parts = parse_item_version(left)
    right_parts = parse_item_version(right)
    length = max(len(left_parts), len(right_parts))
    left_parts.extend([0] * (length - len(left_parts)))
    right_parts.extend([0] * (length - len(right_parts)))
    return (left_parts > right_parts) - (left_parts < right_parts)


def download_items(candidate):
    item_version = candidate["versions"]["CastleItemXMLVersion"]
    normalized = item_version.replace(".", "_")
    bases = (candidate["loaderBase"],) + tuple(
        base for base in LOADER_BASES if base != candidate["loaderBase"]
    )
    last_error = None
    for base in bases:
        url = f"{base}/{candidate['loader']}/itemsXML/items_{normalized}.ggs"
        try:
            response = requests.get(url, timeout=120)
            response.raise_for_status()
            return response.content, url
        except Exception as error:
            last_error = error
    raise last_error


def get_item_release_date(candidate):
    archive, items_url = download_items(candidate)
    with zipfile.ZipFile(io.BytesIO(archive)) as zip_file:
        names = zip_file.namelist()
        if not names:
            raise RuntimeError("Archive is empty")
        xml_text = zip_file.read(names[0]).decode("utf-8")
    parsed = xmltodict.parse(xml_text)
    raw_date = parsed["root"]["versionInfo"]["date"]["@value"]
    return datetime.strptime(raw_date, "%d/%m/%Y %H:%M:%S"), items_url


def find_latest_loader(api_loader):
    best = fetch_versions(api_loader)
    matching = [best]
    candidates = build_candidates(api_loader)
    print(f"Checking {len(candidates)} loader candidates...")

    for offset in range(0, len(candidates), SEARCH_BATCH_SIZE):
        batch = candidates[offset:offset + SEARCH_BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=SEARCH_BATCH_SIZE) as pool:
            futures = {pool.submit(fetch_versions, loader): loader for loader in batch}
            for future in as_completed(futures):
                try:
                    candidate = future.result()
                except Exception:
                    continue

                candidate_item = candidate["versions"].get("CastleItemXMLVersion", "")
                best_item = best["versions"].get("CastleItemXMLVersion", "")
                comparison = compare_item_versions(candidate_item, best_item)
                if comparison > 0:
                    best = candidate
                    matching = [candidate]
                elif comparison == 0:
                    matching.append(candidate)

    if len(matching) > 1:
        item_version = best["versions"]["CastleItemXMLVersion"]
        print(f"Checking release dates for {len(matching)} copies of items {item_version}...")
        dated = []
        with ThreadPoolExecutor(max_workers=min(SEARCH_BATCH_SIZE, len(matching))) as pool:
            futures = {pool.submit(get_item_release_date, item): item for item in matching}
            for future in as_completed(futures):
                candidate = futures[future]
                try:
                    candidate["releaseDate"], candidate["itemsUrl"] = future.result()
                    dated.append(candidate)
                except Exception as error:
                    print(f"Could not read loader {candidate['loader']} release date: {error}")
        if dated:
            best = max(dated, key=lambda item: (item["releaseDate"], int(item["loader"])))

    return best


def write_result(output_path, app_store_version, api_loader, best):
    item_version = best["versions"]["CastleItemXMLVersion"]
    previous = {}
    if output_path.exists():
        previous = json.loads(output_path.read_text(encoding="utf-8"))

    if (str(previous.get("loaderVersion")) == best["loader"] and
            str(previous.get("itemVersion")) == str(item_version)):
        print(f"No new loader found; keeping {best['loader']} / {item_version}.")
        return False

    result = {
        "schemaVersion": 1,
        "loaderVersion": best["loader"],
        "itemVersion": item_version,
        "appStoreVersion": app_store_version,
        "appStoreLoaderVersion": api_loader,
        "versionsUrl": best["versionsUrl"],
        "discoveredAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if best.get("releaseDate"):
        result["releaseDate"] = best["releaseDate"].isoformat()
    if best.get("itemsUrl"):
        result["itemsUrl"] = best["itemsUrl"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Selected new loader: {best['loader']} / {item_version}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Discover the latest hidden E4K loader")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    app_store_version, api_loader = get_app_store_loader()
    print(f"App Store version: {app_store_version} (loader {api_loader})")
    best = find_latest_loader(api_loader)
    write_result(args.output, app_store_version, api_loader, best)


if __name__ == "__main__":
    main()
