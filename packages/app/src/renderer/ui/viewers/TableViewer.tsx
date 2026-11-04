import { type UIEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { decodeText, delimiterFor, parseDelimited } from '../../files/decode.ts';
import { loading, MB, readHead } from '../../files/read.ts';
import { Banner, BINARY, keptView, Message, readFailure, useKeptView, type ViewProps } from './common.tsx';
import { columnOffsets, columnWidths, columnWindow, rowsNotice, rowWindow, truncationNotice } from './views.ts';

/** A cell's padding on its two sides (styles.css, `.viewer-table .cell`): a dimension of the stylesheet, not a setting. */
const CELL_PAD_PX = 16;

interface Table { header: string[]; rows: string[][]; widths: number[]; offsets: Float64Array; numPx: number; banner: string[] }

/** The text's width in the view's font (bold for the header), by a canvas: no layout. */
function measurer(el: HTMLElement, bold: boolean): (text: string) => number {
  const s = getComputedStyle(el), ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${bold ? 600 : s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  return (text) => ctx.measureText(text).width;
}

/**
 * A CSV or TSV table (plan 4a, D4): its first tableViewMaxMb read (readHead), decoded (Windows-1252 too, Review Focus
 * 4), parsed on at most tableMaxRows rows (parseDelimited, the delimiter of a .tsv a tab), the first row as its header.
 * Only the rows and the columns in view, and tableMarginPx around it, are drawn: rows of tableRowPx, columns as wide
 * as their longest value up to tableColumnMaxPx, numbered rows; the header and the numbers stay in view as it scrolls.
 * Its scroll is kept by its hash.
 */
export function TableViewer(props: ViewProps) {
  const { file, params } = props;
  const box = useRef<HTMLDivElement>(null);
  const [table, setTable] = useState<Table | { message: string } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0, w: 0, h: 0 });
  const kept = useKeptView(props.views, file.hash);

  useEffect(() => {
    const stop = new AbortController();
    void loading((async () => {
      try {
        const maxMb = params.tableViewMaxMb;
        const { bytes, truncated } = await readHead(file, maxMb * MB, stop.signal);
        const d = decodeText(bytes, truncated);
        if ('binary' in d) { setTable({ message: BINARY }); return; }
        const t = parseDelimited(d.text, params.tableMaxRows, delimiterFor(file.name));
        // A head read ends in the middle of a row, most likely: that row is left out, unless the rows' ceiling came first.
        const rows = truncated && !t.truncated && t.rows.length > 1 ? t.rows.slice(0, -1) : t.rows;
        if (stop.signal.aborted) return;
        if (rows.length === 0) { setTable({ message: 'Tableau vide.' }); return; }
        const el = box.current!, data = rows.slice(1), measure = measurer(el, false);
        const body = columnWidths(data, measure, params.tableColumnMaxPx, CELL_PAD_PX);
        const head = columnWidths([rows[0]], measurer(el, true), params.tableColumnMaxPx, CELL_PAD_PX);
        const widths = Array.from({ length: Math.max(body.length, head.length) }, (_, c) => Math.max(body[c] ?? 0, head[c] ?? 0));
        setTable({
          header: rows[0], rows: data, widths, offsets: columnOffsets(widths),
          numPx: Math.ceil(measure(String(data.length))) + CELL_PAD_PX,
          banner: [...(truncated ? [truncationNotice(maxMb)] : []), ...(t.truncated ? [rowsNotice(params.tableMaxRows)] : [])],
        });
      } catch (e) {
        if (!stop.signal.aborted) setTable({ message: readFailure(file.name, e) });
      }
    })());
    return () => stop.abort();
  }, []);

  // The view's size, then the scroll it was left at, once the table is there; in full screen, the keys scroll it.
  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setScroll({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const grid = table !== null && !('message' in table) ? table : null, ready = grid !== null;
  useLayoutEffect(() => {
    if (!ready) return;
    const el = box.current!, k = keptView(props.views, file.hash);
    if (k) { el.scrollTop = k.top ?? 0; el.scrollLeft = k.left ?? 0; }
    setScroll({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
    if (props.mode === 'full') el.focus({ preventScroll: true });
  }, [ready]);

  const scrolled = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    kept.current = { top: el.scrollTop, left: el.scrollLeft };
    setScroll({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth, h: el.clientHeight });
  };
  return (
    <div className="viewer viewer-table">
      {grid && <Banner lines={grid.banner} />}
      <div ref={box} className="table-scroll" tabIndex={ready ? 0 : -1} style={{ lineHeight: `${params.tableRowPx}px` }} onScroll={scrolled}>
        {grid
          ? <Grid table={grid} scroll={scroll} rowPx={params.tableRowPx} margin={params.tableMarginPx} />
          : <Message text={table !== null && 'message' in table ? table.message : 'Lecture…'} />}
      </div>
    </div>
  );
}

/** The rows and the columns of `table` in view, and `margin` around it; the header and the row numbers stay in view. */
function Grid(props: { table: Table; scroll: { top: number; left: number; w: number; h: number }; rowPx: number; margin: number }) {
  const { table, scroll, rowPx, margin } = props;
  const rows = rowWindow(scroll.top, scroll.h, rowPx, table.rows.length, margin);
  // The data columns start after the row numbers, which cover the view's left.
  const cols = columnWindow(table.offsets, scroll.left - table.numPx, scroll.w, margin);
  const width = table.numPx + table.offsets[table.offsets.length - 1];
  /** The columns in view, after a gap as wide as those before them. */
  const cells = (row: string[]) => [
    <span key="gap" className="gap" style={{ width: table.offsets[cols.first] }} />,
    ...Array.from({ length: cols.last - cols.first }, (_, i) => {
      const c = cols.first + i;
      return <span key={c} className="cell" style={{ width: table.widths[c] }}>{row[c] ?? ''}</span>;
    }),
  ];
  const lines = [];
  for (let r = rows.first; r < rows.last; r++) {
    lines.push(
      <div key={r} className={r % 2 === 1 ? 'tr odd' : 'tr'} style={{ top: (r + 1) * rowPx, height: rowPx, width }}>
        <span className="num" style={{ width: table.numPx }}>{r + 1}</span>
        {cells(table.rows[r])}
      </div>,
    );
  }
  return (
    <div className="sizer" style={{ width, height: (table.rows.length + 1) * rowPx }}>
      <div className="thead" style={{ height: rowPx, width }}>
        <span className="num" style={{ width: table.numPx }} />
        {cells(table.header)}
      </div>
      {lines}
    </div>
  );
}
