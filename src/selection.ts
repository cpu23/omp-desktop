import type { Terminal } from "@xterm/xterm";

/** xterm 6 has no public hook for ragged (text-bounded) selection painting.
 * Keep the renderer adapter here: selection coordinates/copying remain xterm's,
 * but trailing whitespace is excluded from both WebGL and DOM paint paths.
 * Recheck these private hooks when upgrading xterm or addon-webgl.
 */
type SelectionModel = {
  isCellSelected(terminal: unknown, x: number, y: number): boolean;
};
type RowFactory = { _isCellInSelection(x: number, y: number): boolean };
type Renderer = {
  renderRows(start: number, end: number): void;
  _model?: { selection: SelectionModel };
  _rowFactory?: RowFactory;
  _createSelectionElement?: (row: number, start: number, end: number, rows?: number) => HTMLElement;
};
type RenderService = {
  _renderer: { value: Renderer | undefined };
  setRenderer(renderer: Renderer): void;
};

export function trimSelectionHighlight(term: Terminal): void {
  const service = (term as unknown as { _core: { _renderService: RenderService } })._core._renderService;
  const patched = new WeakSet<Renderer>();
  function patch(renderer: Renderer): void {
    if (patched.has(renderer)) return;
    patched.add(renderer);
    const ends = new Map<number, number>();
    const cell = term.buffer.active.getNullCell();
    const textEnd = (row: number): number => {
      const cached = ends.get(row);
      if (cached !== undefined) return cached;
      const line = term.buffer.active.getLine(row);
      let end = 0;
      if (line) {
        for (let x = Math.min(term.cols, line.length) - 1; x >= 0; x--) {
          const current = line.getCell(x, cell);
          if (current && current.getChars().trim().length > 0) {
            // Include the continuation cell of wide glyphs; string length is
            // not a terminal column count (CJK, emoji and combining marks).
            end = x + current.getWidth();
            break;
          }
        }
      }
      ends.set(row, end);
      return end;
    };
    const renderRows = renderer.renderRows;
    renderer.renderRows = function (start, end) {
      ends.clear();
      renderRows.call(this, start, end);
    };
    if (renderer._model) {
      const model = renderer._model.selection;
      const selected = model.isCellSelected;
      model.isCellSelected = function (terminal, x, y) {
        return selected.call(this, terminal, x, y) && x < textEnd(y);
      };
    } else if (renderer._rowFactory && renderer._createSelectionElement) {
      const factory = renderer._rowFactory;
      const selected = factory._isCellInSelection;
      factory._isCellInSelection = function (x, y) {
        return selected.call(this, x, y) && x < textEnd(y);
      };
      const create = renderer._createSelectionElement;
      renderer._createSelectionElement = function (row, start, end, rows = 1) {
        // DOM's middle-selection rectangle spans multiple rows. Split it into
        // row rectangles so each can stop at its own text extent.
        const group = document.createElement("span");
        for (let y = row; y < row + rows; y++) {
          const right = Math.min(end, textEnd(term.buffer.active.viewportY + y));
          if (right > start) group.append(create.call(this, y, start, right, 1));
        }
        return group;
      };
    } else {
      throw new Error("Unsupported xterm selection renderer");
    }
  }
  const setRenderer = service.setRenderer;
  service.setRenderer = function (renderer) {
    patch(renderer);
    setRenderer.call(this, renderer);
  };
  if (service._renderer.value) patch(service._renderer.value);
}
