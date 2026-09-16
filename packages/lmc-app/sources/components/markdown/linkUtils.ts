const HTTP_URL_PATTERN = /^https?:\/\//i;

export function isHttpMarkdownLink(url: string): boolean {
    return HTTP_URL_PATTERN.test(url.trim());
}

/**
 * A file the transcript points at.
 *
 * Agents name their output in prose — "written to packages/app/x.ts" — and the
 * path was dead text, so reading it meant asking where the file was and then
 * copying the answer. The path is resolved on the device the session runs on,
 * against that session's working directory, so a relative one is passed along
 * as written.
 */
export interface FileReference {
    path: string;
    /** From a `file.ts:42` suffix; the position is not part of the name. */
    line: number | null;
}

/** Everything a path may contain: no whitespace, no CJK sentence punctuation. */
const PATH_CHARACTER = '[^\\s<>"\'`|*?，。；：！？、（）【】「」『』]';
const CANDIDATE = new RegExp(`${PATH_CHARACTER}*\\/${PATH_CHARACTER}*`, 'g');
const POSITION_SUFFIX = /:(\d+)(?::\d+)?$/;
// An extension starts with a letter, so a version (v1.2.3) is not a filename.
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,11}$/;
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TRAILING_PUNCTUATION = '.,;:!?)]}>\'"';

/**
 * Reads a link target as a file, or returns null when it is anything else.
 *
 * Deliberately strict about naming a file: a target without an extension is a
 * heading anchor, a directory, or prose, and opening those fails in a way the
 * reader cannot act on.
 */
export function parseFileReference(target: string): FileReference | null {
    let path = target.trim();
    if (!path) return null;
    if (/^file:\/\//i.test(path)) path = path.slice('file://'.length);
    else if (OTHER_SCHEME.test(path)) return null;

    let line: number | null = null;
    const position = path.match(POSITION_SUFFIX);
    if (position) {
        line = Number(position[1]);
        path = path.slice(0, position.index);
    }
    if (!path || /\s/.test(path)) return null;

    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!FILE_EXTENSION.test(name)) return null;
    return { path, line };
}

/** Drops the sentence's punctuation, keeping a `:42` that belongs to the path. */
function trimTrailingPunctuation(token: string): string {
    let end = token.length;
    while (end > 0 && TRAILING_PUNCTUATION.includes(token[end - 1])) end -= 1;
    return token.slice(0, end);
}

/**
 * Finds the paths written into a run of plain prose.
 *
 * Stricter than `parseFileReference` by one rule: the path must have a
 * directory in it. Prose is full of words that end in something extension-
 * shaped — node.js, README.md, v2.1 — and linking those on sight would send
 * readers to files that do not exist. A path someone actually typed to be
 * followed almost always says where it is.
 */
export function findFileReferences(text: string): { index: number; length: number; reference: FileReference }[] {
    const found: { index: number; length: number; reference: FileReference }[] = [];
    CANDIDATE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CANDIDATE.exec(text)) !== null) {
        if (!match[0]) { CANDIDATE.lastIndex += 1; continue; }
        const token = trimTrailingPunctuation(match[0]);
        if (!token.includes('/')) continue;
        const reference = parseFileReference(token);
        if (reference) found.push({ index: match.index, length: token.length, reference });
    }
    return found;
}
