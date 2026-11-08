import { parse } from 'yaml';
import { readBlockForBuilder, replaceBlockContents } from '../../src/utils/GalleryBlockEditor';
import { GalleryYamlGenerator } from '../../src/utils/GalleryYamlGenerator';
import type { ISourceConfig } from '../../src/models/interfaces';

// The shared obsidian mock has a simplified YAML parser; the real one reads blocks as Obsidian does
jest.mock('obsidian', () => ({
    ...jest.requireActual('obsidian'),
    parseYaml: (text: string) => require('yaml').parse(text)
}));

const body = (sources: Partial<ISourceConfig>[], view = 'masonry', options = {}) =>
    GalleryYamlGenerator.generateBody(sources, view, options);

describe('readBlockForBuilder', () => {
    const sources: Partial<ISourceConfig>[] = [
        { type: 'local', path: 'Photos/Trip', recursive: true, filenameFilter: 'IMG_2024', limit: 20, sort: { by: 'name', order: 'asc' } } as never,
        { type: 'local', path: 'Photos/Old', filters: { modifiedAfter: '2024-01-01', maxSizeKb: 5000 } } as never,
        { type: 'external', urls: ['https://example.com/a.jpg', { url: 'https://example.com/b.jpg', caption: 'Beach' }] } as never,
        { type: 'immich-share', url: 'https://immich.example.com/share/abc', password: 'secret' } as never,
        { type: 'immich', connection: 'home', filters: { isFavorite: true, albumIds: ['a1', 'a2'], assetType: 'IMAGE' }, limit: 50, sort: { by: 'date', order: 'desc' } } as never,
        { type: 'nextcloud', connection: 'cloud', path: '/Photos', recursive: false, filters: { mimeTypes: ['image/jpeg'], maxSizeKb: 900 } } as never,
        { type: 'nextcloud-share', url: 'https://cloud.example.com/s/xyz', filenameFilter: 'IMG_', filters: { mimeTypes: ['image/png'] } } as never
    ];

    test.each(sources.map(s => [s.type, s] as const))('reads back what the builder wrote for a %s source', (_type, source) => {
        const read = readBlockForBuilder(body([source], 'justified', { pagination: 'force', itemsPerPage: 12, gap: 6 }))!;

        expect(read.handWritten).toBe(false);
        expect(read.viewType).toBe('justified');
        expect(read.viewOptions).toEqual({ pagination: 'force', itemsPerPage: 12, gap: 6 });
        // Writing it out again gives the same YAML
        expect(parse(body(read.sources, read.viewType, read.viewOptions))).toEqual(parse(body([source], 'justified', { pagination: 'force', itemsPerPage: 12, gap: 6 })));
    });

    test('all source types together, in order', () => {
        const read = readBlockForBuilder(body(sources))!;
        expect(read.handWritten).toBe(false);
        expect(read.sources.map(s => s.type)).toEqual(sources.map(s => s.type));
    });

    test('a comment makes the block hand-written', () => {
        const read = readBlockForBuilder('# my trip\n' + body(sources.slice(0, 1)))!;
        expect(read.handWritten).toBe(true);
        expect(read.sources).toHaveLength(1);
    });

    test('a # inside a URL is not a comment', () => {
        const read = readBlockForBuilder(body([{ type: 'external', urls: ['https://example.com/a.jpg#top'] } as never]))!;
        expect(read.handWritten).toBe(false);
    });

    test('keys the builder does not know make it hand-written', () => {
        expect(readBlockForBuilder(body(sources.slice(0, 1)) + 'title: Trip\n')!.handWritten).toBe(true);
        expect(readBlockForBuilder(body(sources.slice(0, 1)) + '  mystery: 1\n')!.handWritten).toBe(true);
        expect(readBlockForBuilder('sources:\n  - type: local\n    path: P\n    mystery: 1\nview:\n  type: masonry\n')!.handWritten).toBe(true);
    });

    test('a view given as a plain name, or no view, is fine', () => {
        const named = readBlockForBuilder('sources:\n  - type: local\n    path: Photos\nview: justified\n')!;
        expect(named).toMatchObject({ viewType: 'justified', viewOptions: {}, handWritten: false });
        const none = readBlockForBuilder('sources:\n  - type: local\n    path: Photos\n')!;
        expect(none).toMatchObject({ viewType: 'thumbnail', handWritten: false });
    });

    test('the older path: syntax is read as a local source and counts as hand-written', () => {
        const read = readBlockForBuilder('path: Photos/Trip\nrecursive: false\nview: masonry\n')!;
        expect(read.handWritten).toBe(true);
        expect(read.sources).toEqual([{ type: 'local', path: 'Photos/Trip', recursive: false }]);
        expect(readBlockForBuilder('urls:\n  - https://example.com/a.jpg\n')!.sources[0].type).toBe('external');
    });

    test('a view option that does not apply to the view makes it hand-written', () => {
        expect(readBlockForBuilder('sources:\n  - type: local\n    path: P\nview:\n  type: masonry\n  rowHeight: 200\n')!.handWritten).toBe(true);
    });

    test('unreadable blocks give null', () => {
        expect(readBlockForBuilder('')).toBeNull();
        expect(readBlockForBuilder('just some text')).toBeNull();
        expect(readBlockForBuilder('sources: []\n')).toBeNull();
        expect(readBlockForBuilder('sources: [unclosed')).toBeNull();
    });
});

describe('replaceBlockContents', () => {
    const old = 'sources:\n  - type: local\n    path: A';
    const note = ['# Title', '', '```obs-gallery', old, '```', '', 'after'].join('\n');

    test('replaces only the block contents', () => {
        const next = replaceBlockContents(note, 2, 6, old, 'sources:\n  - type: local\n    path: B\n');
        expect(next).toBe(['# Title', '', '```obs-gallery', 'sources:', '  - type: local', '    path: B', '```', '', 'after'].join('\n'));
    });

    test('keeps the fence the block was written with', () => {
        const tilde = note.replace(/```/g, '~~~~');
        expect(replaceBlockContents(tilde, 2, 6, old, 'sources: x')).toContain('~~~~obs-gallery\nsources: x\n~~~~');
    });

    test('refuses when the block is no longer where it was, or has changed', () => {
        expect(replaceBlockContents(note, 3, 4, old, 'x')).toBeNull();
        expect(replaceBlockContents(note, 2, 6, 'something else', 'x')).toBeNull();
        expect(replaceBlockContents(note.replace('path: A', 'path: Z'), 2, 6, old, 'x')).toBeNull();
        expect(replaceBlockContents('', 2, 6, old, 'x')).toBeNull();
    });

    test('refuses blocks inside a list or callout', () => {
        const callout = ['> ```obs-gallery', '> ' + old.replace(/\n/g, '\n> '), '> ```'].join('\n');
        expect(replaceBlockContents(callout, 0, 4, old, 'x')).toBeNull();
    });
});
