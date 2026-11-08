import { IImageSource } from '../models/interfaces';
import { AspectLayoutView, LayoutTile } from './AspectLayoutView';

interface JustifiedRow {
  tiles: LayoutTile[];
  height: number;
  /** False for the last row when it is not full; its images keep the target height */
  justified: boolean;
}

/**
 * JustifiedView
 * Rows of equal height that exactly fill the width, with each image uncropped at its own width
 * (the layout used by Immich, Google Photos and Flickr). With captions on, each row grows by the
 * caption line under its images; the row height is the image height.
 *
 * Tunable from CSS: --gallery-justified-row-height (target row height) and --gallery-justified-gap.
 */
export class JustifiedView extends AspectLayoutView {
  protected readonly layoutClass = 'gallery-justified-layout';
  protected readonly tileClass = 'gallery-justified-tile';
  protected readonly layoutVariables = { rowHeight: '--gallery-justified-row-height', gap: '--gallery-justified-gap' };

  private static readonly ROW_HEIGHT = 220;
  private static readonly GAP = 4;
  /**
   * Largest target row height as a fraction of the width. A row height chosen for a wide pane
   * (say 240px) would put one photo per row on a phone, so narrow galleries scale it down.
   */
  private static readonly MAX_ROW_HEIGHT_FRACTION = 0.4;

  private rows: HTMLElement[] = [];
  /** Pages in rows mode, from the last layout */
  private rowPageCount = 1;
  /**
   * Rows mode: the first image of the page being shown. Page breaks move when the width or an
   * image's ratio changes, so the page that holds this image stays the current page.
   * Null until the page is first laid out, and after the reader picks a page.
   */
  private anchor: IImageSource | null = null;
  /** Page and page count the pagination bar was drawn for; null before the bar is first drawn */
  private barKey: string | null = null;
  /** Shown in place of the rows while the page's images are being measured */
  private loadingEl: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    super('justified', container);
  }

  /** Pages hold a number of rows rather than of images; the rows are only known once laid out */
  private get pagesByRows(): boolean {
    return this.paginationEnabled && this.rowsPerPage !== undefined;
  }

  /**
   * Images are only measured as their page is opened, so the page count isn't known up front.
   * It is left out of the bar, rather than shown only once the last page is reached.
   */
  protected get pageStatusText(): string {
    return this.pagesByRows ? `Page ${this.currentPage}` : super.pageStatusText;
  }

  protected get totalPages(): number {
    return this.pagesByRows ? this.rowPageCount : super.totalPages;
  }

  /**
   * Rows mode lays out every image and shows the rows of the current page, so a tile is made for
   * each. Tiles off the page stay out of the DOM, so only the current page's images load; a page
   * change re-renders, which drops the old page's tiles, as in the other paged views.
   */
  protected getPageImages(): IImageSource[] {
    return this.pagesByRows ? this._images : super.getPageImages();
  }

  render(): void {
    this.rows = [];
    this.rowPageCount = 1;
    this.anchor = null;
    this.barKey = null;
    this.loadingEl = null;
    super.render();
  }

  protected renderPaginationControls(parent: HTMLElement): void {
    this.barKey = this.currentBarKey();
    super.renderPaginationControls(parent);
  }

  private currentBarKey(): string {
    return `${this.currentPage}/${this.totalPages}`;
  }

  /** Redraw the pagination bar, under the rows, when the page or the page count changed */
  private refreshPaginationBar(): void {
    if (this.barKey === null || !this.root || this.barKey === this.currentBarKey()) return;
    this.container.querySelector(':scope > .gallery-pagination')?.remove();
    this.renderPaginationControls(this.container);
    const bar = this.container.querySelector(':scope > .gallery-pagination');
    if (bar) this.root.after(bar);
  }

  protected layout(width: number): void {
    // Rows need a width to fill; until the gallery is visible the tiles stay unplaced
    if (width <= 0) {
      // Rows mode keeps tiles out of the DOM unless their page is shown, so nothing loads unseen
      if (this.pagesByRows) { this.rows = []; this.loadingEl = null; this.root?.replaceChildren(); }
      return;
    }

    const targetHeight = JustifiedView.targetRowHeight(
      this.readCssNumber('--gallery-justified-row-height', JustifiedView.ROW_HEIGHT), width);
    const gap = this.readCssNumber('--gallery-justified-gap', JustifiedView.GAP);
    const allRows = JustifiedView.buildRows(this.tiles, width, targetHeight, gap);
    let rows = allRows;
    if (this.pagesByRows) {
      const perPage = this.rowsPerPage!;
      const page = this.resolveCurrentPage(allRows);

      // Where a page starts depends on the shape of every image before it, and where its last row
      // ends on the image after it (a row closes by looking at the next image). So wait until those
      // are measured rather than showing rows that then jump
      const upToPage = allRows.slice(0, page * perPage + 1).flatMap((row, r) => r < page * perPage ? row.tiles : row.tiles.slice(0, 1));
      if (upToPage.some(tile => !this.isRatioKnown(tile.image))) {
        this.measureTiles(upToPage);
        this.showLoading();
        this.refreshPaginationBar();
        return;
      }

      rows = allRows.slice((page - 1) * perPage, page * perPage);
      this.anchor = rows[0]?.tiles[0]?.image ?? null;
      this.loadingEl?.remove();
      this.loadingEl = null;
    }

    this.rows = this.syncContainers(this.rows, rows.length, 'gallery-justified-row');
    rows.forEach((row, r) => {
      const rowEl = this.rows[r];
      rowEl.style.setProperty('--gallery-row-height', `${row.height}px`);
      for (const tile of row.tiles) {
        // Justified rows split the width in proportion to the ratios (flex-basis 0, grow by ratio);
        // a short last row keeps each image at its width for the target height.
        tile.el.style.setProperty('--gallery-tile-grow', row.justified ? String(tile.ratio) : '0');
        tile.el.style.setProperty('--gallery-tile-basis', row.justified ? '0px' : `${tile.ratio * row.height}px`);
      }
      this.syncChildren(rowEl, row.tiles);
    });
    if (this.pagesByRows) {
      const shown = new Set(rows.flatMap(row => row.tiles));
      for (const tile of this.tiles) if (!shown.has(tile)) tile.el.remove();
      this.refreshPaginationBar();
    }
  }

  /**
   * Set the page count and the current page from all the rows, and return the page. Tiles on
   * other pages stay out of the DOM; they are still laid out, so the page count follows their shapes.
   */
  private resolveCurrentPage(allRows: JustifiedRow[]): number {
    const perPage = this.rowsPerPage!;
    this.rowPageCount = Math.max(1, Math.ceil(allRows.length / perPage));

    let page = this.currentPage;
    if (this.anchor) {
      const anchored = allRows.findIndex(row => row.tiles.some(tile => tile.image === this.anchor));
      if (anchored >= 0) page = Math.floor(anchored / perPage) + 1;
    }
    this.currentPage = Math.min(Math.max(1, page), this.rowPageCount);
    return this.currentPage;
  }

  /** Replace the page's rows with a note, while the images they depend on are measured */
  private showLoading(): void {
    if (!this.root) return;
    this.loadingEl ??= this.createElement(this.root, 'div', {
      cls: 'gallery-justified-loading',
      text: 'Loading photos…',
      attr: { 'role': 'status' }
    });
    this.rows = [];
    this.root.replaceChildren(this.loadingEl);
  }

  /** The configured row height, capped on narrow galleries so a row still holds a few images */
  static targetRowHeight(rowHeight: number, width: number): number {
    return Math.min(rowHeight, width * JustifiedView.MAX_ROW_HEIGHT_FRACTION);
  }

  /**
   * Split tiles into rows. A row is closed once adding the next tile would shrink it below the
   * target height; the tile goes into whichever row (this one or the next) keeps the height nearer
   * the target. An image too wide to fit the width at the target height (a panorama) gets a row
   * of its own, and the row before it is left unstretched, like the last row.
   */
  static buildRows(tiles: LayoutTile[], width: number, targetHeight: number, gap: number): JustifiedRow[] {
    const fitHeight = (count: number, ratioSum: number) => (width - gap * (count - 1)) / ratioSum;
    // A row that may not fill the width: justified only if it already fills it at the target height
    const openRow = (rowTiles: LayoutTile[], ratioSum: number): JustifiedRow => {
      const height = fitHeight(rowTiles.length, ratioSum);
      return height <= targetHeight
        ? { tiles: rowTiles, height, justified: true }
        : { tiles: rowTiles, height: targetHeight, justified: false };
    };

    const rows: JustifiedRow[] = [];
    let current: LayoutTile[] = [];
    let ratioSum = 0;

    for (const tile of tiles) {
      if (tile.ratio * targetHeight >= width) {
        if (current.length > 0) rows.push(openRow(current, ratioSum));
        rows.push({ tiles: [tile], height: width / tile.ratio, justified: true });
        current = [];
        ratioSum = 0;
        continue;
      }

      const heightWith = fitHeight(current.length + 1, ratioSum + tile.ratio);
      if (current.length > 0 && heightWith < targetHeight) {
        const heightWithout = fitHeight(current.length, ratioSum);
        if (heightWithout - targetHeight <= targetHeight - heightWith) {
          rows.push({ tiles: current, height: heightWithout, justified: true });
          current = [tile];
          ratioSum = tile.ratio;
        } else {
          rows.push({ tiles: [...current, tile], height: heightWith, justified: true });
          current = [];
          ratioSum = 0;
        }
        continue;
      }
      current.push(tile);
      ratioSum += tile.ratio;
    }

    if (current.length > 0) rows.push(openRow(current, ratioSum));
    return rows;
  }
}
