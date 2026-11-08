import { MasonryView } from '../../src/views/MasonryView';
import { JustifiedView } from '../../src/views/JustifiedView';
import { LayoutTile } from '../../src/views/AspectLayoutView';
import { ViewFactory } from '../../src/views/ViewFactory';
import { ImageSource } from '../../src/models/ImageSource';
import { normalizeViewType, resolveViewType, usesThumbnailImages } from '../../src/models/viewTypes';
import { extractImmichDimensions } from '../../src/resolvers/ImmichSourceResolver';

/** Layout roots report this width; jsdom has no layout, so clientWidth is otherwise 0 */
let layoutWidth = 0;
const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return /gallery-(masonry|justified)-layout/.test(this.className) ? layoutWidth : 0;
        }
    });
});

afterAll(() => {
    if (clientWidthDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
});

beforeEach(() => {
    document.body.innerHTML = '';
    layoutWidth = 0;
});

function createContainer(): HTMLElement {
    const el = document.createElement('div') as HTMLElement & { empty?: () => void };
    el.empty = () => { while (el.firstChild) el.removeChild(el.firstChild); };
    document.body.appendChild(el);
    return el;
}

/** A local image with known dimensions */
function sizedImage(name: string, width: number, height: number): ImageSource {
    const image = new ImageSource(`photos/${name}.jpg`, 'local', name, `app://${name}.jpg`);
    image.dimensions = { width, height };
    return image;
}

const tileNames = (parent: Element) =>
    Array.from(parent.querySelectorAll('.gallery-tile img')).map(el => el.getAttribute('alt'));

describe('view types', () => {
    test('grid is an alias for masonry', () => {
        expect(normalizeViewType('grid')).toBe('masonry');
        expect(normalizeViewType('justified')).toBe('justified');
        expect(normalizeViewType('slideshow')).toBeUndefined();
        expect(resolveViewType({ type: 'grid' })).toBe('masonry');
        expect(resolveViewType(undefined)).toBe('thumbnail');
    });

    test('tile views use thumbnails, carousel and embed do not', () => {
        expect(['thumbnail', 'masonry', 'justified', 'grid'].every(usesThumbnailImages)).toBe(true);
        expect(['carousel', 'embed', undefined].some(usesThumbnailImages)).toBe(false);
    });

    test('ViewFactory creates masonry for grid and supports justified', () => {
        const factory = new ViewFactory();
        expect(factory.createView('grid', createContainer())).toBeInstanceOf(MasonryView);
        expect(factory.createView('justified', createContainer())).toBeInstanceOf(JustifiedView);
    });
});

describe('MasonryView', () => {
    test('places each tile in the shortest column, keeping reading order across the top', () => {
        // 700px content (padding is 0 without the stylesheet) fits 3 columns of >= 220px with 8px gaps
        layoutWidth = 700;
        const view = new MasonryView(createContainer());
        view.setOptions({ showCaptions: false });
        view.update([
            sizedImage('tall', 1000, 3000),
            sizedImage('wide1', 3000, 1000),
            sizedImage('wide2', 3000, 1000),
            sizedImage('wide3', 3000, 1000),
            sizedImage('wide4', 3000, 1000)
        ]);

        const columns = Array.from(view.container.querySelectorAll('.gallery-masonry-column'));
        expect(columns).toHaveLength(3);
        // The first row goes left to right; then the two short columns fill up before the tall one
        expect(columns.map(tileNames)).toEqual([['tall'], ['wide1', 'wide3'], ['wide2', 'wide4']]);
    });

    test('uses a single column when the width is unknown', () => {
        const view = new MasonryView(createContainer());
        view.update([sizedImage('a', 100, 100), sizedImage('b', 100, 100)]);

        const columns = view.container.querySelectorAll('.gallery-masonry-column');
        expect(columns).toHaveLength(1);
        expect(tileNames(columns[0])).toEqual(['a', 'b']);
    });

    test('sizes each tile from its ratio before the image loads', () => {
        const view = new MasonryView(createContainer());
        view.update([sizedImage('portrait', 600, 900), new ImageSource('photos/unknown.jpg', 'local', 'unknown', 'app://u.jpg')]);

        const tiles = Array.from(view.container.querySelectorAll<HTMLElement>('.gallery-tile'));
        expect(Number(tiles[0].style.getPropertyValue('--gallery-tile-ratio'))).toBeCloseTo(600 / 900);
        // Unknown size: a 3:2 placeholder until it loads
        expect(Number(tiles[1].style.getPropertyValue('--gallery-tile-ratio'))).toBeCloseTo(1.5);
    });
});

describe('JustifiedView', () => {
    const tile = (ratio: number, name = String(ratio)): LayoutTile =>
        ({ ratio, el: document.createElement('div'), image: { displayName: name } } as unknown as LayoutTile);

    test('full rows fill the width exactly at a height near the target', () => {
        const tiles = [1.5, 1.5, 0.75, 1.5, 1.5, 1, 1.5, 1.5].map(r => tile(r));
        const rows = JustifiedView.buildRows(tiles, 1000, 220, 4);

        for (const row of rows.filter(r => r.justified)) {
            const width = row.tiles.reduce((sum, t) => sum + t.ratio * row.height, 0) + 4 * (row.tiles.length - 1);
            expect(width).toBeCloseTo(1000);
            expect(row.height).toBeGreaterThan(220 * 0.6);
            expect(row.height).toBeLessThan(220 * 1.6);
        }
        expect(rows.flatMap(r => r.tiles)).toEqual(tiles);
    });

    test('a short last row keeps the target height instead of stretching', () => {
        const rows = JustifiedView.buildRows([tile(1.5), tile(1.5), tile(1.5), tile(1.5), tile(1)], 1000, 220, 4);
        const last = rows[rows.length - 1];
        expect(last.justified).toBe(false);
        expect(last.height).toBe(220);
    });

    test('a panorama too wide for the target height gets a row of its own', () => {
        const rows = JustifiedView.buildRows([tile(1.5, 'a'), tile(10, 'pano'), tile(1.5, 'b')], 1000, 220, 4);
        expect(rows.map(r => r.tiles.length)).toEqual([1, 1, 1]);
        expect(rows[1].height).toBeCloseTo(100);
        // The image before the panorama is not stretched to the full width
        expect(rows[0]).toMatchObject({ justified: false, height: 220 });
    });

    test('scales the target row height down on narrow galleries', () => {
        expect(JustifiedView.targetRowHeight(240, 1000)).toBe(240);
        expect(JustifiedView.targetRowHeight(240, 330)).toBeCloseTo(132);

        // A 330px phone-width gallery of 3:2 photos at rowHeight 240 packs two per row, not one
        const tiles = Array.from({ length: 6 }, (_, i) => tile(1.5, String(i)));
        const rows = JustifiedView.buildRows(tiles, 330, JustifiedView.targetRowHeight(240, 330), 4);
        expect(rows.every(r => r.tiles.length >= 2)).toBe(true);
    });

    test('renders rows and relays out once an image turns out to have another ratio', () => {
        layoutWidth = 1000;
        const raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(0); return 1; });
        try {
            const view = new JustifiedView(createContainer());
            const unknown = Array.from({ length: 6 }, (_, i) => new ImageSource(`photos/${i}.jpg`, 'local', `img${i}`, `app://${i}.jpg`));
            view.update(unknown);

            // Six assumed 3:2 images: three fill a 1000px row at ~220px, then three more
            const rowCounts = () => Array.from(view.container.querySelectorAll('.gallery-justified-row')).map(r => r.children.length);
            expect(rowCounts()).toEqual([3, 3]);

            // The first image is actually a tall portrait, so the first row takes one more image
            const img = view.container.querySelector('img')!;
            Object.defineProperty(img, 'naturalWidth', { value: 500, configurable: true });
            Object.defineProperty(img, 'naturalHeight', { value: 1000, configurable: true });
            img.dispatchEvent(new Event('load'));

            expect(rowCounts()).toEqual([4, 2]);
            const firstTile = view.container.querySelector<HTMLElement>('.gallery-tile')!;
            expect(firstTile.style.getPropertyValue('--gallery-tile-grow')).toBe('0.5');
        } finally {
            raf.mockRestore();
        }
    });

    test('leaves tiles unplaced until the gallery has a width', () => {
        const view = new JustifiedView(createContainer());
        view.update([sizedImage('a', 300, 200)]);

        expect(view.container.querySelectorAll('.gallery-justified-row')).toHaveLength(0);
        expect(view.container.querySelectorAll('.gallery-tile')).toHaveLength(1);
    });
});

describe('JustifiedView rowsPerPage', () => {
    // Width 1000, 3:2 images: 3 per row, so 5 rows hold 15 images
    const images = () => Array.from({ length: 15 }, (_, i) => sizedImage(`img${i}`, 300, 200));
    const rowCounts = (view: JustifiedView) =>
        Array.from(view.container.querySelectorAll('.gallery-justified-row')).map(r => r.children.length);
    const status = (view: JustifiedView) => view.container.querySelector('.gallery-pagination-status')?.textContent;
    const next = (view: JustifiedView) => view.container.querySelector<HTMLButtonElement>('.gallery-pagination-next')!.click();

    function pagedView(rowsPerPage: number | null = 2) {
        layoutWidth = 1000;
        const view = new JustifiedView(createContainer());
        view.setOptions({ pagination: true, itemsPerPage: 4, rowsPerPage: rowsPerPage ?? undefined });
        view.update(images());
        return view;
    }

    // Frames run when the test says so; the view lays out on the next frame after a page change or resize
    let frames: FrameRequestCallback[];
    let raf: jest.SpyInstance;
    const runFrames = () => { while (frames.length) frames.shift()!(0); };
    beforeEach(() => { frames = []; raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => frames.push(cb)); });
    afterEach(() => raf.mockRestore());
    const nextPage = (view: JustifiedView) => { next(view); runFrames(); };

    test('shows the set number of rows per page, whatever the images per page', () => {
        const view = pagedView();
        expect(rowCounts(view)).toEqual([3, 3]);
        expect(view.container.querySelectorAll('.gallery-tile')).toHaveLength(6);
        expect(status(view)).toBe('Page 1');
    });

    test('next page shows the following rows, and the last page may be short', () => {
        const view = pagedView();
        nextPage(view);
        expect(tileNames(view.container)).toEqual(['img6', 'img7', 'img8', 'img9', 'img10', 'img11']);
        expect(status(view)).toBe('Page 2');
        nextPage(view);
        expect(tileNames(view.container)).toEqual(['img12', 'img13', 'img14']);
        expect(view.container.querySelector<HTMLButtonElement>('.gallery-pagination-next')!.disabled).toBe(true);
    });

    test('stays on the page holding the same first image when the width changes', () => {
        const view = pagedView();
        nextPage(view);
        expect(tileNames(view.container)[0]).toBe('img6');

        // Narrower: 2 per row, so pages hold 4 images and the page break moves
        layoutWidth = 600;
        (view as unknown as { scheduleLayout(force: boolean): void }).scheduleLayout(true);
        runFrames();
        expect(rowCounts(view)).toEqual([2, 2]);
        expect(tileNames(view.container)).toEqual(['img4', 'img5', 'img6', 'img7']);
        expect(status(view)).toBe('Page 2');
    });

    test('without rowsPerPage, pages hold itemsPerPage images', () => {
        const view = pagedView(null);
        expect(view.container.querySelectorAll('.gallery-tile')).toHaveLength(4);
    });

    describe('images of unknown size', () => {
        // Stands in for the browser loading an image: reports the size for its URL on a later tick
        const sizes: Record<string, [number, number]> = {};
        const requested: string[] = [];
        let realImage: typeof Image;
        beforeEach(() => {
            realImage = window.Image;
            class FakeImage {
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                naturalWidth = 0;
                naturalHeight = 0;
                set src(url: string) {
                    requested.push(url);
                    setTimeout(() => {
                        const size = sizes[url];
                        if (!size) return this.onerror?.();
                        [this.naturalWidth, this.naturalHeight] = size;
                        this.onload?.();
                    }, 0);
                }
            }
            window.Image = FakeImage as unknown as typeof Image;
            requested.length = 0;
        });
        afterEach(() => { window.Image = realImage; });

        // Let measurements finish and the layouts they schedule run
        const settle = async () => {
            for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 0)); runFrames(); }
        };
        const unknownImages = (n: number) => Array.from({ length: n }, (_, i) => {
            sizes[`app://u${i}.jpg`] = [300, 200];
            return new ImageSource(`photos/u${i}.jpg`, 'local', `u${i}`, `app://u${i}.jpg`);
        });

        function unknownView(n: number) {
            layoutWidth = 1000;
            const view = new JustifiedView(createContainer());
            view.setOptions({ pagination: true, rowsPerPage: 2 });
            view.update(unknownImages(n));
            return view;
        }

        test('shows a note, not rows, until the images on the page are measured', async () => {
            const view = unknownView(15);
            expect(view.container.querySelector('.gallery-justified-loading')).not.toBeNull();
            expect(view.container.querySelectorAll('.gallery-tile')).toHaveLength(0);

            await settle();
            expect(view.container.querySelector('.gallery-justified-loading')).toBeNull();
            expect(rowCounts(view)).toEqual([3, 3]);
        });

        test('measures only what the page needs, and never shows the page count', async () => {
            const view = unknownView(15);
            expect(status(view)).toBe('Page 1');
            await settle();
            // 2 rows of the assumed 3:2 shape need 6 images, and the next one decides where the 2nd row ends;
            // nothing beyond that is loaded, but Next is there
            expect(requested).toHaveLength(7);
            expect(status(view)).toBe('Page 1');
            expect(view.container.querySelector<HTMLButtonElement>('.gallery-pagination-next')!.disabled).toBe(false);

            nextPage(view);
            await settle();
            expect(requested).toHaveLength(13);
            expect(status(view)).toBe('Page 2');

            nextPage(view);
            await settle();
            expect(requested).toHaveLength(15);
            expect(status(view)).toBe('Page 3');
            expect(view.container.querySelector<HTMLButtonElement>('.gallery-pagination-next')!.disabled).toBe(true);
        });

        test('keeps the height of the page it left while the next page loads', async () => {
            const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
            Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
                configurable: true,
                get(this: HTMLElement) { return /gallery-justified-layout/.test(this.className) ? 480 : 0; }
            });
            try {
                const view = unknownView(15);
                await settle();
                const root = () => view.container.querySelector<HTMLElement>('.gallery-justified-layout')!;
                expect(root().style.minHeight).toBe('');

                next(view);
                expect(view.container.querySelector('.gallery-justified-loading')).not.toBeNull();
                expect(root().style.minHeight).toBe('480px');

                runFrames();
                await settle();
                expect(view.container.querySelector('.gallery-justified-loading')).toBeNull();
                expect(root().style.minHeight).toBe('');
            } finally {
                if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
                else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
            }
        });

        test('a later page waits for every image before it', async () => {
            const view = unknownView(15);
            await settle();
            nextPage(view);
            nextPage(view);
            await settle();
            expect(tileNames(view.container)).toEqual(['u12', 'u13', 'u14']);
        });

        test('uses the measured shapes: portraits fit more to a row', async () => {
            layoutWidth = 1000;
            const view = new JustifiedView(createContainer());
            view.setOptions({ pagination: true, rowsPerPage: 1 });
            const imgs = Array.from({ length: 8 }, (_, i) => {
                sizes[`app://p${i}.jpg`] = [200, 300];
                return new ImageSource(`photos/p${i}.jpg`, 'local', `p${i}`, `app://p${i}.jpg`);
            });
            view.update(imgs);
            await settle();
            // Seven 2:3 portraits fill a 1000px row at ~209px, near the 220px target; assumed 3:2 shapes would give three
            expect(rowCounts(view)).toEqual([7]);
        });

        test('an image that fails to load does not stop the page showing', async () => {
            layoutWidth = 1000;
            const view = new JustifiedView(createContainer());
            view.setOptions({ pagination: true, rowsPerPage: 1 });
            view.update([new ImageSource('photos/x.jpg', 'local', 'x', 'app://missing.jpg')]);
            await settle();
            expect(view.container.querySelector('.gallery-justified-loading')).toBeNull();
            expect(view.container.querySelectorAll('.gallery-tile')).toHaveLength(1);
        });
    });

    test('does not put tiles in the DOM until the gallery has a width', () => {
        const view = new JustifiedView(createContainer());
        view.setOptions({ pagination: true, rowsPerPage: 2 });
        view.update(images());
        expect(view.container.querySelectorAll('.gallery-tile')).toHaveLength(0);
    });
});

describe('extractImmichDimensions', () => {
    test('prefers the asset size, then EXIF', () => {
        expect(extractImmichDimensions({ id: 'a', width: 4000, height: 3000 })).toEqual({ width: 4000, height: 3000 });
        expect(extractImmichDimensions({ id: 'a', exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000 } })).toEqual({ width: 4000, height: 3000 });
        expect(extractImmichDimensions({ id: 'a' })).toBeUndefined();
    });

    test('swaps EXIF sizes for rotated orientations', () => {
        expect(extractImmichDimensions({ id: 'a', exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000, orientation: '6' } }))
            .toEqual({ width: 3000, height: 4000 });
    });
});
