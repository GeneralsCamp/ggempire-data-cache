import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const OUT_DIR = "public/data";
const MAX_ITEM_HISTORY = 8;

const FORCE_LOADER = "4135017";

const LANGUAGES = [
    "en",
    "ar",
    "es",
    "bg",
    "pt",
    "cs",
    "de",
    "da",
    "fi",
    "fr",
    "el",
    "hu",
    "it",
    "ja",
    "ko",
    "lt",
    "nl",
    "no",
    "pl",
    "ro",
    "ru",
    "sv",
    "sk",
    "tr"
];

const APP_LOOKUP_URL =
    "https://itunes.apple.com/lookup?id=585661281&country=de";

const EMPIRE_INDEX_URL =
    "https://empire-html5.goodgamestudios.com/default/index.html";

const EMPIRE_ITEMS_VERSION_URL =
    "https://empire-html5.goodgamestudios.com/default/items/ItemsVersion.properties";

const EMPIRE_ITEMS_BASE_URL =
    "https://empire-html5.goodgamestudios.com/default/items";

const LANGUAGE_VERSION_URL =
    "https://langserv.public.ggs-ep.com/12/fr/@metadata";

const LANGUAGE_BASE_URL =
    "https://langserv.public.ggs-ep.com";

function dataPath(relativePath) {
    return `/data/${relativePath.replaceAll("\\", "/")}`;
}

function outputPath(relativePath) {
    return path.join(OUT_DIR, relativePath);
}

function slug(value) {
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

async function ensureDir(dirPath) {
    await mkdir(dirPath, { recursive: true });
}

async function fetchText(url, timeout = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "ggempire-data-cache/1.0"
            }
        });

        if (!res.ok) {
            throw new Error(`Fetch failed ${res.status}: ${url}`);
        }

        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchBuffer(url, timeout = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "ggempire-data-cache/1.0"
            }
        });

        if (!res.ok) {
            throw new Error(`Fetch failed ${res.status}: ${url}`);
        }

        return Buffer.from(await res.arrayBuffer());
    } finally {
        clearTimeout(timer);
    }
}

async function readJsonIfExists(filePath, fallback) {
    if (!existsSync(filePath)) {
        return fallback;
    }

    try {
        const text = await readFile(filePath, "utf8");
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

async function writeTextIfChanged(filePath, content) {
    await ensureDir(path.dirname(filePath));

    if (existsSync(filePath)) {
        const oldContent = await readFile(filePath, "utf8");

        if (oldContent === content) {
            console.log(`No change: ${filePath}`);
            return false;
        }
    }

    await writeFile(filePath, content, "utf8");
    console.log(`Updated: ${filePath}`);
    return true;
}

async function copyIfMissingOrChanged(fromPath, toPath) {
    await ensureDir(path.dirname(toPath));

    if (existsSync(fromPath) && existsSync(toPath)) {
        const from = await readFile(fromPath);
        const to = await readFile(toPath);

        if (Buffer.compare(from, to) === 0) {
            console.log(`No change: ${toPath}`);
            return false;
        }
    }

    await copyFile(fromPath, toPath);
    console.log(`Copied: ${toPath}`);
    return true;
}

function ensureHistoryShape(history) {
    return {
        empireItems: Array.isArray(history.empireItems)
            ? history.empireItems
            : [],
        e4kItems: Array.isArray(history.e4kItems)
            ? history.e4kItems
            : []
    };
}

function addHistoryEntry(list, predicate, entry) {
    if (!list.some(predicate)) {
        list.push(entry);
    }
}

async function removeDataFile(dataUrlPath) {
    if (!dataUrlPath || typeof dataUrlPath !== "string") {
        return;
    }

    if (!dataUrlPath.startsWith("/data/")) {
        return;
    }

    const relativePath =
        dataUrlPath.replace(/^\/data\//, "");

    const filePath =
        outputPath(relativePath);

    if (!existsSync(filePath)) {
        return;
    }

    await rm(filePath, {
        force: true
    });

    console.log(`Removed old archived file: ${filePath}`);
}

async function pruneItemHistoryList(list, fileFields = []) {
    const sorted =
        [...list].sort((a, b) => {
            const aTime = new Date(a.addedAt || 0).getTime();
            const bTime = new Date(b.addedAt || 0).getTime();

            return aTime - bTime;
        });

    while (sorted.length > MAX_ITEM_HISTORY) {
        const oldEntry =
            sorted.shift();

        for (const field of fileFields) {
            const value =
                oldEntry?.[field];

            if (typeof value === "string") {
                await removeDataFile(value);
            }
        }
    }

    return sorted;
}

async function pruneOldItemVersions(history) {
    history.empireItems =
        await pruneItemHistoryList(
            history.empireItems,
            ["file"]
        );

    history.e4kItems =
        await pruneItemHistoryList(
            history.e4kItems,
            ["file", "rawFile"]
        );
}

function parseEmpireItemVersion(text) {
    const match = text.match(/CastleItemXMLVersion=([^\s]+)/);

    if (!match) {
        throw new Error("CastleItemXMLVersion not found in ItemsVersion.properties.");
    }

    return match[1];
}

function parseLangVersion(metadata) {
    const version = metadata?.["@metadata"]?.versionNo;

    if (!version) {
        throw new Error("Language versionNo not found in metadata.");
    }

    return String(version);
}

function parseE4kLoaderVersionFromAppStore(appstoreJson) {
    const version = appstoreJson?.results?.[0]?.version;

    if (!version) {
        throw new Error("Could not resolve E4K App Store version.");
    }

    const parts = String(version).split(".");

    if (parts.length < 2) {
        throw new Error(`Unexpected E4K App Store version format: ${version}`);
    }

    const major = parts[0];
    const minor = parts[1];
    const patch = (parts[2] || "0").padStart(3, "0");

    return {
        appStoreVersion: String(version),
        loaderVersion: `${major}${minor}${patch}`
    };
}

function getHtmlAttribute(tag, attrName) {
    const pattern = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, "i");
    const match = tag.match(pattern);
    return match?.[1] || null;
}

function findDllPathInIndexHtml(indexHtml) {
    const linkTags = indexHtml.match(/<link\b[^>]*>/gi) || [];

    for (const tag of linkTags) {
        const id = getHtmlAttribute(tag, "id");
        const rel = getHtmlAttribute(tag, "rel");
        const href = getHtmlAttribute(tag, "href");

        if (
            id?.toLowerCase() === "dll" &&
            rel?.toLowerCase() === "preload" &&
            href
        ) {
            return href;
        }
    }

    const directMatch = indexHtml.match(
        /(?:href|src)=["']([^"']*ggs\.dll\.[a-f0-9]{10,}\.js)["']/i
    );

    if (directMatch?.[1]) {
        return directMatch[1];
    }

    const looseMatch = indexHtml.match(
        /([^"'`\s<>]*ggs\.dll\.[a-f0-9]{10,}\.js)/i
    );

    if (looseMatch?.[1]) {
        return looseMatch[1];
    }

    return null;
}

async function resolveEmpireDllInfo() {
    console.log(`Reading Empire index: ${EMPIRE_INDEX_URL}`);

    const indexHtml = await fetchText(EMPIRE_INDEX_URL, 30000);
    const dllPath = findDllPathInIndexHtml(indexHtml);

    if (!dllPath) {
        throw new Error("DLL preload link not found in Empire index.html.");
    }

    const versionMatch =
        dllPath.match(/\.([a-f0-9]{10,})\.js$/i);

    if (!versionMatch?.[1]) {
        throw new Error(`Could not extract DLL version from path: ${dllPath}`);
    }

    const dllVersion = versionMatch[1];

    const dllUrl =
        new URL(dllPath, EMPIRE_INDEX_URL).toString();

    console.log(`Resolved Empire DLL version: ${dllVersion}`);
    console.log(`Resolved Empire DLL URL: ${dllUrl}`);

    return {
        version: dllVersion,
        versionUrl: EMPIRE_INDEX_URL,
        dllUrl,
        source: "empire-index-preload"
    };
}

async function unpackE4kArchive(zipBuffer) {
    const zip = await JSZip.loadAsync(zipBuffer);
    const firstFile = Object.values(zip.files).find((file) => !file.dir);

    if (!firstFile) {
        throw new Error("The E4K archive did not contain any files.");
    }

    return await firstFile.async("text");
}

function parseE4kXmlToJson(xmlText) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        textNodeName: "value",
        trimValues: true,
        parseAttributeValue: false,
        parseTagValue: false
    });

    const parsed = parser.parse(xmlText);

    if (!parsed?.root) {
        throw new Error("The E4K XML root element is missing.");
    }

    return parsed.root;
}

function normalizeXmlLikeJson(value) {
    if (Array.isArray(value)) {
        return value.map((entry) =>
            normalizeXmlLikeJson(entry)
        );
    }

    if (!value || typeof value !== "object") {
        return value;
    }

    const entries = Object.entries(value);

    if (entries.length === 1 && Array.isArray(entries[0][1])) {
        return entries[0][1].map((entry) =>
            normalizeXmlLikeJson(entry)
        );
    }

    const normalized = {};

    for (const [key, childValue] of entries) {
        normalized[key] =
            normalizeXmlLikeJson(childValue);
    }

    return normalized;
}

function normalizeE4kData(data) {
    return normalizeXmlLikeJson(data);
}

async function updateEmpireItems({ history, manifest }) {
    console.log("");
    console.log("=== Empire items ===");

    const versionText = await fetchText(EMPIRE_ITEMS_VERSION_URL);
    const itemVersion = parseEmpireItemVersion(versionText);

    const versionRel =
        "empire/ItemsVersion.properties";

    await writeTextIfChanged(
        outputPath(versionRel),
        versionText
    );

    const archiveRel =
        `empire/items/items_${slug(itemVersion)}.json`;

    const latestRel =
        "empire/items_latest.json";

    const archivePath =
        outputPath(archiveRel);

    const latestPath =
        outputPath(latestRel);

    const itemsUrl =
        `${EMPIRE_ITEMS_BASE_URL}/items_v${itemVersion}.json`;

    const shouldDownload =
        !existsSync(archivePath) ||
        !existsSync(latestPath);

    if (shouldDownload) {
        console.log(`Downloading Empire items ${itemVersion}`);

        const itemsText =
            await fetchText(itemsUrl, 60000);

        JSON.parse(itemsText);

        await writeTextIfChanged(
            archivePath,
            itemsText
        );

        await writeTextIfChanged(
            latestPath,
            itemsText
        );
    } else {
        console.log(`Empire items ${itemVersion} already cached.`);

        await copyIfMissingOrChanged(
            archivePath,
            latestPath
        );
    }

    addHistoryEntry(
        history.empireItems,
        (entry) => String(entry.version) === String(itemVersion),
        {
            version: itemVersion,
            addedAt: new Date().toISOString(),
            sourceUrl: itemsUrl,
            file: dataPath(archiveRel),
            latestFile: dataPath(latestRel)
        }
    );

    manifest.empire = {
        itemVersion,
        itemVersionUrl: dataPath(versionRel),
        itemsUrl: dataPath(latestRel),
        archivedItemsUrl: dataPath(archiveRel),
        originalItemsUrl: itemsUrl
    };
}

async function updateLanguages({ manifest }) {
    console.log("");
    console.log("=== Languages ===");

    const metadataText =
        await fetchText(LANGUAGE_VERSION_URL);

    const metadata =
        JSON.parse(metadataText);

    const langVersion =
        parseLangVersion(metadata);

    const metadataRel =
        "lang/metadata.json";

    await writeTextIfChanged(
        outputPath(metadataRel),
        JSON.stringify(metadata, null, 2) + "\n"
    );

    const files = {};
    const failed = [];

    for (const langCode of LANGUAGES) {
        const latestRel =
            `lang/${langCode}.json`;

        const latestPath =
            outputPath(latestRel);

        files[langCode] =
            dataPath(latestRel);

        const langUrl =
            `${LANGUAGE_BASE_URL}/12@${langVersion}/${langCode}/*`;

        try {
            console.log(`Downloading language ${langCode} ${langVersion}`);

            const langText =
                await fetchText(langUrl, 30000);

            JSON.parse(langText);

            await writeTextIfChanged(
                latestPath,
                langText
            );
        } catch (error) {
            failed.push({
                langCode,
                message: error.message
            });

            console.warn(`Language failed: ${langCode} - ${error.message}`);

            if (!existsSync(latestPath)) {
                throw new Error(
                    `Language ${langCode} failed and no previous latest file exists.`
                );
            }
        }
    }

    manifest.language = {
        version: langVersion,
        metadataUrl: dataPath(metadataRel),
        available: files,
        failed
    };
}

async function updateE4k({ history, manifest }) {
    console.log("");
    console.log("=== E4K ===");

    const appstoreText =
        await fetchText(APP_LOOKUP_URL);

    const appstoreJson =
        JSON.parse(appstoreText);

    const appstoreRel =
        "e4k/appstore.json";

    await writeTextIfChanged(
        outputPath(appstoreRel),
        JSON.stringify(appstoreJson, null, 2) + "\n"
    );

    const {
        appStoreVersion,
        loaderVersion: apiLoaderVersion
    } = parseE4kLoaderVersionFromAppStore(appstoreJson);

    const loaderVersion =
        FORCE_LOADER || apiLoaderVersion;
        
    console.log(
        FORCE_LOADER
            ? `Using forced E4K loader: ${loaderVersion}`
            : `Using AppStore loader: ${loaderVersion}`
    );

    const versionsUrl =
        `https://media.goodgamestudios.com/loader/empirefourkingdoms/${loaderVersion}/versions.json`;

    const versionsText =
        await fetchText(versionsUrl);

    const versionsJson =
        JSON.parse(versionsText);

    const itemVersion =
        versionsJson?.CastleItemXMLVersion;

    if (!itemVersion) {
        throw new Error("CastleItemXMLVersion missing from E4K versions.json.");
    }

    const versionsRel =
        "e4k/versions.json";

    await writeTextIfChanged(
        outputPath(versionsRel),
        JSON.stringify(versionsJson, null, 2) + "\n"
    );

    const normalizedItemVersion =
        String(itemVersion).replaceAll(".", "_");

    const ggsUrl =
        `https://media.goodgamestudios.com/loader/empirefourkingdoms/${loaderVersion}/itemsXML/items_${normalizedItemVersion}.ggs`;

    const archiveRel =
        `e4k/items/items_${slug(loaderVersion)}_${slug(itemVersion)}.json`;

    const rawArchiveRel =
        `e4k/items/raw/items_${slug(loaderVersion)}_${slug(itemVersion)}.raw.json`;

    const latestRel =
        "e4k/items_latest.json";

    const rawLatestRel =
        "e4k/items_latest.raw.json";

    const archivePath =
        outputPath(archiveRel);

    const rawArchivePath =
        outputPath(rawArchiveRel);

    const latestPath =
        outputPath(latestRel);

    const rawLatestPath =
        outputPath(rawLatestRel);

    const shouldDownload =
        !existsSync(rawArchivePath) ||
        !existsSync(archivePath) ||
        !existsSync(latestPath);

    if (shouldDownload) {
        console.log(`Downloading E4K items ${loaderVersion} / ${itemVersion}`);

        const zipBuffer =
            await fetchBuffer(ggsUrl, 90000);

        const xmlText =
            await unpackE4kArchive(zipBuffer);

        const parsedRaw =
            parseE4kXmlToJson(xmlText);

        const normalized =
            normalizeE4kData(parsedRaw);

        const rawJsonText =
            JSON.stringify(parsedRaw);

        const normalizedJsonText =
            JSON.stringify(normalized);

        await writeTextIfChanged(
            rawArchivePath,
            rawJsonText
        );

        await writeTextIfChanged(
            rawLatestPath,
            rawJsonText
        );

        await writeTextIfChanged(
            archivePath,
            normalizedJsonText
        );

        await writeTextIfChanged(
            latestPath,
            normalizedJsonText
        );
    } else {
        console.log(`E4K items ${loaderVersion} / ${itemVersion} already cached.`);

        const sourcePathForNormalization =
            existsSync(rawArchivePath)
                ? rawArchivePath
                : archivePath;

        const existingText =
            await readFile(sourcePathForNormalization, "utf8");

        const existingJson =
            JSON.parse(existingText);

        const normalized =
            normalizeE4kData(existingJson);

        const normalizedJsonText =
            JSON.stringify(normalized);

        await writeTextIfChanged(
            archivePath,
            normalizedJsonText
        );

        await writeTextIfChanged(
            latestPath,
            normalizedJsonText
        );

        if (existsSync(rawArchivePath)) {
            await copyIfMissingOrChanged(
                rawArchivePath,
                rawLatestPath
            );
        }
    }

    addHistoryEntry(
        history.e4kItems,
        (entry) =>
            String(entry.appVersion) === String(loaderVersion) &&
            String(entry.itemVersion) === String(itemVersion),
        {
            appVersion: loaderVersion,
            appStoreVersion,
            itemVersion,
            addedAt: new Date().toISOString(),
            versionsSourceUrl: versionsUrl,
            sourceUrl: ggsUrl,
            file: dataPath(archiveRel),
            rawFile: dataPath(rawArchiveRel),
            latestFile: dataPath(latestRel),
            rawLatestFile: dataPath(rawLatestRel)
        }
    );

    manifest.e4k = {
        appVersion: loaderVersion,
        appStoreVersion,
        itemVersion,
        appstoreUrl: dataPath(appstoreRel),
        versionsUrl: dataPath(versionsRel),
        itemsUrl: dataPath(latestRel),
        rawItemsUrl: dataPath(rawLatestRel),
        archivedItemsUrl: dataPath(archiveRel),
        archivedRawItemsUrl: dataPath(rawArchiveRel),
        originalVersionsUrl: versionsUrl,
        originalItemsUrl: ggsUrl
    };
}

async function updateEmpireDll({ manifest }) {
    console.log("");
    console.log("=== Empire DLL ===");

    const info =
        await resolveEmpireDllInfo();

    const versionRel =
        "empire/dll/version.json";

    const latestRel =
        "empire/dll/ggs.dll.latest.js";

    const latestPath =
        outputPath(latestRel);

    console.log(`Downloading Empire DLL ${info.version}`);

    const dllText =
        await fetchText(info.dllUrl, 60000);

    await writeTextIfChanged(
        latestPath,
        dllText
    );

    const versionInfo = {
        version: info.version,
        source: info.source,
        versionUrl: info.versionUrl,
        dllUrl: info.dllUrl,
        latestFile: dataPath(latestRel),
        checkedAt: new Date().toISOString()
    };

    await writeTextIfChanged(
        outputPath(versionRel),
        JSON.stringify(versionInfo, null, 2) + "\n"
    );

    manifest.empireDll = {
        available: true,
        version: info.version,
        source: info.source,
        versionUrl: dataPath(versionRel),
        dllUrl: dataPath(latestRel),
        originalIndexUrl: info.versionUrl,
        originalDllUrl: info.dllUrl
    };
}

async function main() {
    await ensureDir(OUT_DIR);

    const historyPath =
        outputPath("version-history.json");

    const history =
        ensureHistoryShape(
            await readJsonIfExists(historyPath, {})
        );

    const manifest = {
        updatedAt: new Date().toISOString(),
        generatedBy: "GitHub Actions",
        languages: LANGUAGES
    };

    await updateEmpireItems({
        history,
        manifest
    });

    await updateLanguages({
        manifest
    });

    await updateE4k({
        history,
        manifest
    });

    await updateEmpireDll({
        manifest
    });

    await pruneOldItemVersions(history);

    await writeTextIfChanged(
        outputPath("manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n"
    );

    await writeTextIfChanged(
        historyPath,
        JSON.stringify(history, null, 2) + "\n"
    );

    console.log("");
    console.log("Done.");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
