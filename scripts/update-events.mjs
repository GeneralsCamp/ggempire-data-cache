import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_PATH = "public/events/event-plans.json";
const REQUEST_TIMEOUT_MS = 30000;
const RETRIES = 2;
const RUNTIME_ID = typeof process !== "undefined" ? process.pid : "runtime";

const SOURCES = {
    empire: "https://communityhub.goodgamestudios.com/newshubempire/",
    e4k: "https://communityhub.goodgamestudios.com/newshube4k/"
};

const EVENT_ALIASES = {
    "berimond invasion": "Berimond",
    "berimond": "Berimond",
    "beyondthehorizon": "Beyond the Horizon",
    "bladecoast": "The Bladecoast",
    "bloodcrow": "Bloodcrow Invasion",
    "grand nobility contest": "LTPE",
    "grandtournament": "The Grand Tournament",
    "imperial patronage": "The Imperial Patronage",
    "ltpe": "LTPE",
    "nomadinvasion": "Nomad Invasion",
    "outerrealms": "Outer Realms",
    "patronage": "Imperial Patronage",
    "riftraid": "Rift Raid",
    "samuraiinvasion": "Samurai Invasion",
    "grand tournament": "The Grand Tournament",
    "waroftherealms": "War of the Realms"
};
const KNOWN_EVENT_TITLES = new Set(Object.values(EVENT_ALIASES).map((title) => title.toLowerCase()));

function decodeHtml(value) {
    return String(value || "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function htmlToText(html) {
    return decodeHtml(String(html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " "))
        .replace(/\s*\n\s*/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

function normalizeText(value) {
    return htmlToText(value).replace(/\s+/g, " ").trim();
}

function canonicalizeEventTitle(title) {
    const cleaned = normalizeText(title);
    return EVENT_ALIASES[cleaned.toLowerCase()] || cleaned;
}

function lineHasDateToken(line) {
    return /(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)/.test(line);
}

function extractDateGroups(rawText, title) {
    const lines = String(rawText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return null;
    const titleLower = String(title || "").toLowerCase();
    let removedTitle = false;
    const cleaned = lines.filter((line) => {
        if (!removedTitle && titleLower && normalizeText(line).toLowerCase() === titleLower) {
            removedTitle = true;
            return false;
        }
        return true;
    });
    const groups = [];
    let label = "";
    let dates = [];
    let hasLabel = false;
    const flush = () => {
        if (label || dates.length) groups.push({ label, dates });
        label = "";
        dates = [];
    };
    cleaned.forEach((line) => {
        if (lineHasDateToken(line)) {
            dates.push(line);
        } else {
            if (dates.length || label) flush();
            label = line;
            hasLabel = true;
        }
    });
    flush();
    const filtered = groups.filter((group) => group.dates.length);
    return hasLabel && filtered.length ? filtered : null;
}

function getAttribute(tag, name) {
    const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
    return match ? decodeHtml(match[2]) : "";
}

function extractCards(html) {
    const sourceStart = html.search(/upcoming\s+events/i);
    const source = sourceStart >= 0 ? html.slice(sourceStart) : html;
    const pattern = /<div\b(?=[^>]*\bclass\s*=\s*(["'])[^"']*\be-con(?:-full)?\b[^"']*\be-child\b[^"']*\1)[^>]*>/gi;
    const starts = [...source.matchAll(pattern)].map((match) => match.index);
    return starts.map((start, index) => source.slice(start, starts[index + 1] || source.length));
}

export function parseEventsFromHtml(html) {
    const events = [];
    for (const card of extractCards(String(html || ""))) {
        const paragraphs = [...card.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
            .map((match) => htmlToText(match[1]))
            .filter(Boolean);
        const imageTag = card.match(/<img\b[^>]*>/i)?.[0] || "";
        const imageUrl = getAttribute(imageTag, "data-orig-file") ||
            getAttribute(imageTag, "data-large-file") || getAttribute(imageTag, "src");
        const rawTitle = paragraphs[0] || getAttribute(imageTag, "data-image-title") || getAttribute(imageTag, "alt");
        const title = canonicalizeEventTitle(rawTitle);
        if (!KNOWN_EVENT_TITLES.has(title.toLowerCase())) continue;
        const rawDates = paragraphs.slice(1).find(lineHasDateToken) || "";
        const dateGroups = extractDateGroups(rawDates, title);
        const dates = dateGroups ? dateGroups.flatMap((group) => group.dates) :
            rawDates.split(/\r?\n/).map((line) => line.trim()).filter(lineHasDateToken);
        if (!dates.length && !imageUrl) continue;
        events.push({ title, dates, dateGroups, imageUrl });
    }

    const seen = new Set();
    return events.filter((event) => {
        const groupKey = (event.dateGroups || []).map((group) =>
            `${group.label || ""}:${group.dates.join("|")}`).join("||");
        const key = `${event.title}::${groupKey || event.dates.join(",")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function fetchTextWithRetry(url) {
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "ggempire-data-cache/1.0" } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timer);
        }
    }
    throw new Error(`${url}: ${lastError?.message || "request failed"}`);
}

async function writeAtomicallyIfChanged(filePath, content) {
    await mkdir(path.dirname(filePath), { recursive: true });
    if (existsSync(filePath) && await readFile(filePath, "utf8") === content) return false;
    const temporaryPath = `${filePath}.tmp-${RUNTIME_ID}-${Date.now()}`;
    try {
        await writeFile(temporaryPath, content, "utf8");
        await rename(temporaryPath, filePath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
    return true;
}

export async function updateEvents({ outputPath = OUTPUT_PATH, fetchText = fetchTextWithRetry } = {}) {
    try {
        const [empireHtml, e4kHtml] = await Promise.all([
            fetchText(SOURCES.empire),
            fetchText(SOURCES.e4k)
        ]);
        const empireEvents = parseEventsFromHtml(empireHtml);
        const e4kEvents = parseEventsFromHtml(e4kHtml);
        if (!empireEvents.length || !e4kEvents.length) {
            throw new Error(`Parser returned Empire: ${empireEvents.length}, E4K: ${e4kEvents.length} events.`);
        }
        const payload = {
            schemaVersion: 1,
            empire: { sourceUrl: SOURCES.empire, events: empireEvents },
            e4k: { sourceUrl: SOURCES.e4k, events: e4kEvents }
        };
        const changed = await writeAtomicallyIfChanged(outputPath, JSON.stringify(payload, null, 2) + "\n");
        console.log(changed ? `Updated event plans: ${outputPath}` : "No change: event plans");
        return { changed, empireEvents: empireEvents.length, e4kEvents: e4kEvents.length };
    } catch (error) {
        console.error(`Event update failed; previous event-plans.json was kept: ${error.message}`);
        return { changed: false, failed: true };
    }
}

if (typeof process !== "undefined" && process.argv?.[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
    updateEvents();
}
