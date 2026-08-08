import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectLatestAssets, updateAssets } from "./update-assets.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "gg-assets-test-"));
const dllPath = path.join(root, "dll.js");
const outputDir = path.join(root, "assets");
const base = "https://assets.test/itemassets/";
const webp = Buffer.from("RIFF\x04\0\0\0WEBPVP8 ");
const files = new Map();
let requests = 0;
const fetchMock = async (url) => {
    requests += 1;
    const body = files.get(url);
    return new Response(body ?? "missing", { status: body ? 200 : 404 });
};
const setFamily = (family, version, js = "window.asset = true;") => {
    files.set(`${base}${family}--${version}.webp`, webp);
    files.set(`${base}${family}--${version}.json`, "{\"frames\":[]}");
    files.set(`${base}${family}--${version}.js`, js);
};
const run = async (dll) => {
    await writeFile(dllPath, dll);
    return updateAssets({ dllPath, outputDir, assetBaseUrl: base, fetchImpl: fetchMock });
};

assert.deepEqual(collectLatestAssets("itemassets/A/Foo--100 itemassets/A/Foo--200"), [{ family: "A/Foo", version: "200" }]);
setFamily("A/Foo", "100");
assert.equal((await run("itemassets/A/Foo--100")).updated, 1, "first download");
assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")), {
    version: 1,
    assets: [{ path: "A/Foo--100" }]
}, "asset manifest contains only complete asset families");
const afterFirst = requests;
assert.equal((await run("itemassets/A/Foo--100")).skipped, 1, "unchanged version is skipped");
assert.equal(requests, afterFirst, "skip does not request files");
setFamily("A/Foo", "200");
assert.equal((await run("itemassets/A/Foo--100 itemassets/A/Foo--200")).updated, 1, "newest DLL version replaces old");
await assert.rejects(readFile(path.join(outputDir, "A", "Foo--100.webp")));
files.set(`${base}A/Foo--300.webp`, webp);
files.set(`${base}A/Foo--300.json`, "{}");
assert.equal((await run("itemassets/A/Foo--300")).failed, 1, "invalid companion fails family");
assert.equal((await readFile(path.join(outputDir, "A", "Foo--200.js"), "utf8")).trim(), "window.asset = true;", "old family survives failed update");
console.log("Asset updater tests passed.");
