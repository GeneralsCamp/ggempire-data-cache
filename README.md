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
