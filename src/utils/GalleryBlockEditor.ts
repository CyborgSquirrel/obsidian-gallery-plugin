import { parseYaml } from 'obsidian';
import type { ISourceConfig } from '../models/interfaces';
import { readViewOptions, ViewBlockOptions } from '../models/viewOptions';
import { GalleryYamlGenerator } from './GalleryYamlGenerator';

/** What the gallery builder needs to edit an existing code block */
export interface BuilderBlock {
    viewType: string;
    viewOptions: ViewBlockOptions;
    sources: Partial<ISourceConfig>[];
    /**
     * Whether writing the block back from the builder would change more than the settings the
     * builder shows: comments, keys it doesn't know, or the older `path:` syntax
     */
    handWritten: boolean;
}

/** Key order doesn't matter in YAML, so compare values without it */
function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

/** A `#` at the start of a line or after a space starts a YAML comment */
const hasComment = (source: string) => source.split('\n').some(line => /(^|\s)#/.test(line));

/**
 * Read a gallery code block into the builder's state, or null when it can't be read at all (not
 * YAML, or no sources). Never throws.
 */
export function readBlockForBuilder(source: string): BuilderBlock | null {
    try {
        const raw = parseYaml(source) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const block = raw as Record<string, unknown>;

        let handWritten = hasComment(source);
        let sources: Partial<ISourceConfig>[];
        if (Array.isArray(block.sources)) {
            sources = block.sources.filter((s): s is Partial<ISourceConfig> =>
                !!s && typeof s === 'object' && typeof (s as { type?: unknown }).type === 'string');
        } else {
            // The older syntax: a `path:` or a list of `urls:` at the top level
            handWritten = true;
            if (typeof block.path === 'string') {
                sources = [{ type: 'local', path: block.path, ...(typeof block.recursive === 'boolean' ? { recursive: block.recursive } : {}) }];
            } else if (Array.isArray(block.urls)) {
                sources = [{ type: 'external', urls: block.urls as never }];
            } else {
                return null;
            }
        }
        if (sources.length === 0) return null;

        const { type, options } = readViewOptions(block.view);
        const view = block.view;
        // Every key under view: must be one the builder shows
        const viewIsClean = typeof view !== 'object' || view === null
            || Object.keys(view).every(key => key === 'type' || key in options);
        const onlyKnownKeys = Object.keys(block).every(key => key === 'sources' || key === 'view');
        if (!viewIsClean || !onlyKnownKeys) handWritten = true;

        // What the builder would write for the sources must read back as the same sources
        if (!handWritten) {
            try {
                const written = parseYaml(GalleryYamlGenerator.generateBody(sources, type, options)) as { sources?: unknown };
                if (stable(written?.sources) !== stable(block.sources)) handWritten = true;
            } catch {
                handWritten = true;
            }
        }

        return { viewType: type, viewOptions: options, sources, handWritten };
    } catch {
        return null;
    }
}

/**
 * Put new YAML in place of a code block's contents. `lineStart` and `lineEnd` are the block's
 * fence lines (as reported for the rendered block); the old contents must still equal `oldSource`,
 * so a note that changed since the gallery rendered isn't overwritten. Returns the new note text,
 * or null when the block isn't where it was.
 */
export function replaceBlockContents(
    noteText: string,
    lineStart: number,
    lineEnd: number,
    oldSource: string,
    newBody: string
): string | null {
    const lines = noteText.split('\n');
    const fence = lines[lineStart];
    if (fence === undefined || !/^(`{3,}|~{3,})obs-gallery\s*$/.test(fence) || lineEnd <= lineStart) return null;
    if (!/^(`{3,}|~{3,})\s*$/.test(lines[lineEnd] ?? '')) return null;

    const current = lines.slice(lineStart + 1, lineEnd).join('\n');
    if (current.trim() !== oldSource.trim()) return null;

    const body = newBody.replace(/\n+$/, '').split('\n');
    return [...lines.slice(0, lineStart + 1), ...body, ...lines.slice(lineEnd)].join('\n');
}
