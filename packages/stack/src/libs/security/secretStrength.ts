/**
 * Predictable sanity checks for configured secrets (SESSION_SECRET,
 * SETUP_TOKEN, OTP_ENCRYPTION_KEY). They catch placeholders and obviously
 * non-random values; they are not an entropy estimate.
 *
 * Generated values must never trip them, which shapes the marker rules
 * (random base64 contains every short letter sequence sooner or later, in
 * random case):
 * - Markers of 7+ letters ("replace", "example", "placeholder",
 *   "change me", "not secure") match anywhere, but only as written by a
 *   person: each word lower, UPPER or Capitalized ("change-me", "CHANGE_ME",
 *   "ChangeMe"), and not glued into a longer same-case run of letters. A
 *   random "rEpLaCe" doesn't match.
 * - Shorter markers ("secret", "todo", "your", "xxx") only count in values made of
 *   words: every part between "-", "_", "." or spaces is a word (lower,
 *   UPPER or Capitalized) or a number ("todo-generate-a-real-one",
 *   "TODO_SET_ME_123"). Random base64, base64url and hex values practically
 *   never have that shape.
 *
 * Measured: 0 rejections in 10 million samples each of
 * randomBytes(48|32|24).toString("base64"|"base64url") and
 * randomBytes(32) hex (tests/security/secrets.test.ts has a seeded subset
 * and fixed regression cases).
 */

/** Markers as word lists; words may be joined by nothing, "-", "_" or a space. */
const ANYWHERE_MARKERS = [["change", "me"], ["replace"], ["example"], ["placeholder"], ["not", "secure"]];
const SHORT_MARKER_WORDS = new Set(["secret", "todo", "your"]);

const ANYWHERE_PATTERNS = ANYWHERE_MARKERS.map(words => ({
    marker: words.join("-"),
    pattern: new RegExp(words.map(word => `(?:${word}|${word.toUpperCase()}|${word[0].toUpperCase()}${word.slice(1)})`).join("[-_ ]?"), "g"),
}));

export const SECRET_GENERATION_HINT = "Generate one with: openssl rand -base64 48";

/** Distinct characters a value of this length needs: 10, or a quarter of the length for short values. */
function requiredVariety(length: number): number {
    return Math.min(10, Math.ceil(length / 4));
}

const isLower = (char: string | undefined) => char !== undefined && char >= "a" && char <= "z";
const isUpper = (char: string | undefined) => char !== undefined && char >= "A" && char <= "Z";

/** The match isn't part of a longer same-case letter run (e.g. "replace" in "pleasereplaceme" is, "Replace" in "PleaseReplaceMe" isn't). */
function standsAlone(value: string, start: number, match: string): boolean {
    const before = value[start - 1];
    const after = value[start + match.length];
    // "Secret" may follow a lowercase letter (camelCase), "secret" may not; likewise on the right.
    const leftOk = isUpper(match[0]) ? !isUpper(before) : !isLower(before);
    const rightOk = isUpper(match[match.length - 1]) ? !isUpper(after) : !isLower(after);
    return leftOk && rightOk;
}

function placeholderMarker(value: string): string | undefined {
    for (const {marker, pattern} of ANYWHERE_PATTERNS) {
        for (const match of value.matchAll(pattern)) {
            if (standsAlone(value, match.index, match[0])) {
                return marker;
            }
        }
    }

    const parts = value.split(/[-_.\s]+/).filter(Boolean);
    // Each part a person-written word (lower, UPPER, Capitalized) or a number; random parts mix case
    const madeOfWords = parts.length > 0 && parts.every(part => /^(?:[a-z]+|[A-Z]+|[A-Z][a-z]+|\d+)$/.test(part));
    if (madeOfWords) {
        const word = parts.map(part => part.toLowerCase()).find(part => SHORT_MARKER_WORDS.has(part) || /^x{3,}$/.test(part));
        if (word !== undefined) {
            return /^x+$/.test(word) ? "xxx" : word;
        }
    }

    return undefined;
}

/**
 * Why `value` is not acceptable as a secret, or null. The problem reads as
 * a sentence continuation, e.g. `SESSION_SECRET ${problem}`.
 */
export function secretWeakness(value: string, minLength: number): string | null {
    const marker = placeholderMarker(value);
    if (marker !== undefined) {
        return `looks like a placeholder (contains "${marker}")`;
    }

    if (value.length < minLength) {
        return `must be at least ${minLength} characters (got ${value.length})`;
    }

    const distinct = new Set(value).size;
    if (distinct < requiredVariety(value.length)) {
        return `is not random enough (only ${distinct} distinct character${distinct === 1 ? "" : "s"})`;
    }

    return null;
}

/** Low-variety check for decoded key material: random 32-byte keys have ~30 distinct bytes. */
export function keyBytesWeakness(key: Uint8Array): string | null {
    const distinct = new Set(key).size;
    return distinct < Math.ceil(key.length / 2) ? `is not random enough (only ${distinct} distinct bytes)` : null;
}
