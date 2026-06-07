// Классификация ошибок для безопасной обработки async-событий bridge.
// Источник проблемы: chokidar-обработчики в PeerStorage.ts кидали unhandledrejection
// на DecryptionError одного документа и теряли остальные события из inotify-очереди.
// (См. задачу 2026-06-07-002.)

export type ErrorClass = "decryption" | "transient" | "unexpected";

const DECRYPTION_PATTERNS = [
    /decryption/i,
    /\bdecrypt(ion|ing)?\s+(failed|trial)/i,
    /HKDF/i,
    /Unsupported encryption format/i,
    /Corrupted document/i,
    /All decryption trials failed/i,
    /Unknown encryption version/i,
];

const TRANSIENT_PATTERNS = [
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /EHOSTUNREACH/i,
    /ENETUNREACH/i,
    /EAI_AGAIN/i,
    /socket hang up/i,
    /fetch failed/i,
    /network request failed/i,
    /timed?\s*out/i,
    /connection (reset|closed|refused|aborted)/i,
    /BodyTimeoutError/i,
    /HeadersTimeoutError/i,
    /Service Unavailable/i,
    /\b50[234]\b/,
    /\b409\b.*[Cc]onflict/,
];

const FATAL_TYPE_PATTERNS = [
    /^TypeError$/,
    /^ReferenceError$/,
    /^SyntaxError$/,
    /^RangeError$/,
];

function messageOf(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

export function classifyError(err: unknown): ErrorClass {
    const name = err instanceof Error ? err.name : "";
    const msg = messageOf(err);
    if (DECRYPTION_PATTERNS.some((p) => p.test(msg))) return "decryption";
    if (FATAL_TYPE_PATTERNS.some((p) => p.test(name))) return "unexpected";
    if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return "transient";
    return "unexpected";
}

export function isTransient(err: unknown): boolean {
    return classifyError(err) === "transient";
}

export function isDecryptionError(err: unknown): boolean {
    return classifyError(err) === "decryption";
}

export function describeError(err: unknown): string {
    return messageOf(err);
}
