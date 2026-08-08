import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DLL_PATH = "public/data/empire/dll/ggs.dll.latest.js";
const DEFAULT_OUTPUT_DIR = "public/assets/itemassets";
const DEFAULT_ASSET_BASE_URL =
    "https://empire-html5.goodgamestudios.com/default/assets/itemassets/";

const REQUEST_TIMEOUT_MS = Number(process.env.ASSET_REQUEST_TIMEOUT_MS || 30000);
const RETRIES = Number(process.env.ASSET_RETRIES || 2);
const CONCURRENCY = Number(process.env.ASSET_CONCURRENCY || 6);
const USER_AGENT = "ggempire-data-cache/1.0";

function toSafeAssetPath(value) {
    const normalized = String(value || "").replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("..") ||
        !/^[A-Za-z0-9_./-]+$/.test(normalized)) {
        return null;
    }
    return normalized;
}

export function collectLatestAssets(dllText) {
    const latest = new Map();
    const pattern = /itemassets\/([A-Za-z0-9_./-]+)--(\d+)(?!\d)/g;

    for (const match of String(dllText).matchAll(pattern)) {
        const family = toSafeAssetPath(match[1]);
        if (!family) continue;

        const version = match[2];
        const current = latest.get(family);
        if (!current || BigInt(version) > BigInt(current.version)) {
            latest.set(family, { family, version });
        }
    }

    return [...latest.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function assetFileNames(versionedBase) {
    return [".webp", ".json", ".js"].map((extension) => `${versionedBase}${extension}`);
}

async function fileExists(filePath) {
    return existsSync(filePath);
}

async function writeTextIfChanged(filePath, content) {
    if (existsSync(filePath) && await readFile(filePath, "utf8") === content) {
        return false;
    }
    await writeFile(filePath, content, "utf8");
    return true;
}

async function fetchWithRetry(url, fetchImpl) {
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(url, {
                signal: controller.signal,
                headers: { "User-Agent": USER_AGENT }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
        } catch (error) {
            lastError = error;
            if (attempt < RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            }
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${url}: ${lastError?.message || "request failed"}`);
}

function validateAsset(extension, content) {
    if (extension === ".webp") {
        if (content.length < 12 || content.subarray(0, 4).toString() !== "RIFF" ||
            content.subarray(8, 12).toString() !== "WEBP") {
            throw new Error("not a WEBP image");
        }
    } else if (extension === ".json") {
        JSON.parse(content.toString("utf8"));
    } else {
        const text = content.toString("utf8").trim();
        if (!text || text.includes("\uFFFD") || text.includes("\0") || /^<!doctype html|^<html/i.test(text)) {
            throw new Error("not a non-empty JavaScript response");
        }
    }
}

async function findExistingFamilyFiles(targetDir, familyName) {
    if (!existsSync(targetDir)) return [];
    const prefix = `${familyName}--`;
    const versioned = new Set();
    for (const entry of await readdir(targetDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const match = entry.name.match(/^(.*--\d+)\.(webp|json|js)$/);
        if (match) versioned.add(match[1]);
    }
    return [...versioned];
}

async function downloadAndReplace(asset, options) {
    const { outputDir, assetBaseUrl, fetchImpl } = options;
    const segments = asset.family.split("/");
    const familyName = segments.pop();
    const targetDir = path.join(outputDir, ...segments);
    const versionedBase = `${familyName}--${asset.version}`;
    const finalFiles = assetFileNames(path.join(targetDir, versionedBase));

    if ((await Promise.all(finalFiles.map(fileExists))).every(Boolean)) {
        return "skipped";
    }

    await mkdir(targetDir, { recursive: true });
    const tempToken = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempFiles = finalFiles.map((filePath) => `${filePath}${tempToken}`);
    const extensions = [".webp", ".json", ".js"];

    try {
        const downloads = await Promise.allSettled(extensions.map(async (extension, index) => {
            const url = `${assetBaseUrl}${asset.family}--${asset.version}${extension}`;
            const content = await fetchWithRetry(url, fetchImpl);
            validateAsset(extension, content);
            await writeFile(tempFiles[index], content);
        }));
        const failedDownload = downloads.find((result) => result.status === "rejected");
        if (failedDownload) throw failedDownload.reason;

        const oldBases = await findExistingFamilyFiles(targetDir, familyName);
        await Promise.all(oldBases.flatMap((oldBase) =>
            assetFileNames(path.join(targetDir, oldBase)).map((filePath) => rm(filePath, { force: true }))
        ));
        await Promise.all(tempFiles.map((tempFile, index) => rename(tempFile, finalFiles[index])));
        return "updated";
    } catch (error) {
        await Promise.all(tempFiles.map((filePath) => rm(filePath, { force: true })));
        throw error;
    }
}

async function mapWithConcurrency(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            await worker(items[index]);
        }
    });
    await Promise.all(runners);
}

export async function updateAssets({
    dllPath = process.env.ASSET_DLL_PATH || DEFAULT_DLL_PATH,
    outputDir = process.env.ASSET_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    assetBaseUrl = process.env.ASSET_BASE_URL || DEFAULT_ASSET_BASE_URL,
    fetchImpl = fetch
} = {}) {
    const assets = collectLatestAssets(await readFile(dllPath, "utf8"));
    const summary = { total: assets.length, updated: 0, skipped: 0, failed: 0 };
    const readyAssets = new Set();
    console.log(`Asset families in DLL: ${assets.length}`);

    await mapWithConcurrency(assets, CONCURRENCY, async (asset) => {
        try {
            const outcome = await downloadAndReplace(asset, { outputDir, assetBaseUrl, fetchImpl });
            summary[outcome] += 1;
            readyAssets.add(`${asset.family}--${asset.version}`);
            console.log(`${outcome === "skipped" ? "Skip" : "Cached"}: ${asset.family}--${asset.version}`);
        } catch (error) {
            summary.failed += 1;
            console.error(`Asset failed (previous version kept): ${asset.family}--${asset.version} — ${error.message}`);
        }
    });

    const manifest = {
        version: 1,
        assets: assets
            .filter((asset) => readyAssets.has(`${asset.family}--${asset.version}`))
            .map((asset) => ({ path: `${asset.family}--${asset.version}` }))
    };
    const manifestPath = path.join(outputDir, "manifest.json");
    const manifestChanged = await writeTextIfChanged(
        manifestPath,
        JSON.stringify(manifest) + "\n"
    );
    if (manifestChanged) console.log(`Updated asset manifest: ${manifestPath}`);

    console.log(`Assets complete: ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.failed} failed.`);
    return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    updateAssets().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
