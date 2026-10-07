# ggempire-data-cache

## E4K release channels

The App Store loader is published as live E4K under `public/data/e4k/`.
A newer loader found by discovery is published separately under `public/data/preclient/`.
This is a repository classification rule based on discovery provenance, not an official release-status flag in the XML.

Normalized item files include `releaseInfo`; raw XML-derived JSON remains unchanged.
The manifest exposes separate `e4k` and `preclient` entries, and version history uses separate `e4kItems` and `preclientItems` lists.
Finder releases previously stored in live history are migrated to Preclient history.
When the App Store catches up with discovery, no separate Preclient manifest entry is published.

Run `node scripts/update-data.mjs --only-e4k` to refresh these channels without updating Empire, languages or assets.

## Assets collected by the E4K finder

Running **Discover E4K test loader** also downloads the selected loader's three x768 `itemAssets/package_N_x768.ggs` ZIP packages and extracts every PNG in `Buildings`, `BuildingSkins` and `ConstructionItems`.
`Buildings/Deco` contains decorations; building skins and construction item icons also have their own folders, so all three are included.

The action commits the loader configuration and extracted images together under `public/assets/e4k/<loader>/package_N/`, preserving the original asset paths. Package folders prevent same-named images in different packages from overwriting each other.
`public/assets/e4k/manifest.json` identifies the selected loader, item version, original paths, repository paths, file sizes and SHA-256 hashes. Earlier loader folders remain available.

Extraction runs even when the finder selects the same loader, so the first run can populate its missing assets. Verified existing assets are reused; missing or altered local files trigger extraction again. Downloads and PNG/ZIP CRC validation finish before publishing files or updating the manifest.
Only this GitHub finder action collects the E4K images. The site's asset selection can be wired separately afterward.
