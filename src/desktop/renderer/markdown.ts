/**
 * Minimal Markdown support for assistant messages.
 *
 * `parseMarkdown` is a pure function producing a small block/inline tree and
 * is unit tested without a DOM. `renderMarkdown` turns the tree into DOM
 * nodes using text nodes only, never `innerHTML`, so provider output cannot
 * inject markup. Links are rendered only for http(s) URLs and open through
 * the supplied callback (the default browser), never inside the app.
 *
 * Supported: paragraphs, ATX headings (#, ##, ###), fenced code blocks,
 * bullet and numbered lists, block quotes, GitHub-style pipe tables, inline
 * code, bold, italic, and links. Anything else renders as plain text, which
 * is the safe fallback for a streaming message that is only partly written.
 *
 * Bare http(s) URLs are linked, and file paths (in text or as a whole
 * inline code span) become `path` inlines that the caller can open. Path
 * detection is deliberately conservative so prose such as "and/or" or a date
 * stays text: a path must start with `/`, `./`, `../`, or `~/`, or end in a
 * file extension, and must have at least two segments. A trailing
 * `:line[:column]` is kept in the text and stripped when opening.
 *
 * Tables follow the GitHub Flavored Markdown shape: a header row, a
 * delimiter row (`---`, `:--`, `--:`, `:-:`) with the same number of cells,
 * then body rows until a blank line or a line without a pipe. Until the
 * delimiter row has fully streamed in, the header renders as a paragraph,
 * so a table "snaps" into place instead of flashing broken markup.
 */

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong"; readonly children: readonly Inline[] }
  | { readonly type: "em"; readonly children: readonly Inline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly Inline[] }
  /** A file or folder path; `code` keeps inline-code styling. */
  | { readonly type: "path"; readonly path: string; readonly code: boolean };

export type Block =
  | { readonly type: "paragraph"; readonly inlines: readonly Inline[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly inlines: readonly Inline[] }
  | { readonly type: "code"; readonly language?: string; readonly text: string }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly type: "quote"; readonly inlines: readonly Inline[] }
  | {
      readonly type: "table";
      /** One entry per column; `null` means no explicit alignment. */
      readonly align: readonly (TableAlign | null)[];
      /** Header cells, one inline list per column. */
      readonly header: readonly (readonly Inline[])[];
      /** Body rows, each normalized to exactly `align.length` cells. */
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

export type TableAlign = "left" | "center" | "right";

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
/** One delimiter cell: optional colons around one or more dashes. */
const DELIMITER_CELL = /^:?-+:?$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", inlines: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;

    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence !== null) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      // An unterminated fence (still streaming) runs to the end of the text.
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] as string)) {
        body.push(lines[index] as string);
        index += 1;
      }
      blocks.push({ type: "code", ...(fence[1] ? { language: fence[1] } : {}), text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading !== null) {
      flushParagraph();
      blocks.push({ type: "heading", level: (heading[1] as string).length as 1 | 2 | 3, inlines: parseInline(heading[2] as string) });
      continue;
    }

    // A table needs its delimiter row on the next line; checking ahead keeps
    // ordinary prose that merely contains a pipe as a paragraph.
    const align = line.includes("|") ? tableAlignment(lines[index + 1], splitRow(line).length) : undefined;
    if (align !== undefined) {
      flushParagraph();
      const header = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && (lines[index] as string).trim() !== "" && (lines[index] as string).includes("|")) {
        const cells = splitRow(lines[index] as string);
        // Normalize ragged rows: pad short ones, drop cells beyond the header.
        rows.push(align.map((_, column) => parseInline(cells[column] ?? "")));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item !== null && paragraph.length === 0) {
      const ordered = item[2] !== undefined;
      const items: Inline[][] = [];
      while (index < lines.length) {
        const current = (lines[index] as string).match(LIST_ITEM);
        if (current === null || (current[2] !== undefined) !== ordered) break;
        items.push(parseInline(current[3] as string));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] as string)) {
        quoted.push((lines[index] as string).replace(/^\s*>\s?/, ""));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "quote", inlines: parseInline(quoted.join("\n")) });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/**
 * Splits a table row into trimmed cell sources. Leading and trailing pipes
 * are optional, and `\|` is an escaped literal pipe (the GFM way to put a
 * pipe inside a cell, including inside inline code).
 */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (character === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Returns per-column alignment when `line` is a valid delimiter row for a
 * header of `columns` cells, otherwise `undefined`. GFM requires the counts
 * to match exactly; a mismatch (common mid-stream) is not a table yet.
 */
function tableAlignment(line: string | undefined, columns: number): (TableAlign | null)[] | undefined {
  if (line === undefined || !line.includes("-")) return undefined;
  const cells = splitRow(line);
  if (cells.length !== columns || !cells.every((cell) => DELIMITER_CELL.test(cell))) return undefined;
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

/** A path-shaped token: optional prefix, two or more segments, optional :line[:col]. */
const PATH_TOKEN = /^(?:~\/|\.{1,2}\/|\/)?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?/;
/** A bare URL; trailing punctuation is trimmed after matching. */
const URL_TOKEN = /^https?:\/\/[^\s<>"'`]+/;

/** True when `token` is confidently a file path rather than prose. */
export function isPathLike(token: string): boolean {
  const match = token.match(PATH_TOKEN);
  if (match === null || match[0] !== token) return false;
  const withoutLine = token.replace(/:\d+(?::\d+)?$/, "");
  const prefixed = /^(?:~\/|\.{1,2}\/|\/)/.test(withoutLine);
  const lastSegment = withoutLine.split("/").at(-1) ?? "";
  const hasExtension = /^[^.].*\.[A-Za-z0-9]{1,10}$/.test(lastSegment);
  return prefixed || hasExtension;
}

/** Drops sentence punctuation (and an unbalanced closing parenthesis) from a token's end. */
function trimTrailing(token: string): string {
  let result = token.replace(/[.,;:!?]+$/, "");
  while (result.endsWith(")") && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) {
    result = result.slice(0, -1).replace(/[.,;:!?]+$/, "");
  }
  return result;
}

/** Parses inline code, links, bold, and italic. Unmatched markers stay literal. */
export function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") {
      result.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);

    const code = rest.match(/^`([^`]+)`/);
    if (code !== null) {
      flush();
      const text = code[1] as string;
      result.push(isPathLike(text.trim()) ? { type: "path", path: text.trim(), code: true } : { type: "code", text });
      index += code[0].length;
      continue;
    }

    // Bare URLs and paths only start at a token boundary, so a slash inside
    // a word (or a URL already inside a markdown link) is not split.
    const atBoundary = buffer === "" || /[\s(\[{"']$/.test(buffer);
    if (atBoundary) {
      const url = rest.match(URL_TOKEN);
      if (url !== null) {
        const href = trimTrailing(url[0]);
        flush();
        result.push({ type: "link", href, children: [{ type: "text", text: href }] });
        index += href.length;
        continue;
      }
      const candidate = rest.match(PATH_TOKEN);
      if (candidate !== null) {
        const path = trimTrailing(candidate[0]);
        if (isPathLike(path)) {
          flush();
          result.push({ type: "path", path, code: false });
          index += path.length;
          continue;
        }
      }
    }

    const link = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
    if (link !== null) {
      flush();
      result.push({ type: "link", href: link[2] as string, children: parseInline(link[1] as string) });
      index += link[0].length;
      continue;
    }

    const strong = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/) ?? rest.match(/^__(?=\S)([\s\S]*?\S)__/);
    if (strong !== null) {
      flush();
      result.push({ type: "strong", children: parseInline(strong[1] as string) });
      index += strong[0].length;
      continue;
    }

    const em = rest.match(/^\*(?=\S)([^*]*?\S)\*/) ?? rest.match(/^_(?=\S)([^_]*?\S)_(?![A-Za-z0-9])/);
    if (em !== null && !/[A-Za-z0-9]$/.test(buffer)) {
      flush();
      result.push({ type: "em", children: parseInline(em[1] as string) });
      index += em[0].length;
      continue;
    }

    buffer += text[index];
    index += 1;
  }
  flush();
  return result;
}

/** Callbacks for clickable content; without `openPath`, paths render as plain text. */
export interface MarkdownActions {
  readonly openLink: (href: string) => void;
  readonly openPath?: (path: string) => void;
  /** Supplied by the transcript UI so parsing remains independent of SVG assets. */
  readonly copyControl?: (text: string, label: string) => HTMLElement;
}

export function renderMarkdown(source: string, actions: MarkdownActions | ((href: string) => void)): DocumentFragment {
  const resolved: MarkdownActions = typeof actions === "function" ? { openLink: actions } : actions;
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    fragment.append(renderBlock(block, resolved));
  }
  return fragment;
}

function renderBlock(block: Block, actions: MarkdownActions): HTMLElement {
  switch (block.type) {
    case "paragraph":
      return withInlines(document.createElement("p"), block.inlines, actions);
    case "heading":
      return withInlines(document.createElement(`h${block.level + 2}` as "h3"), block.inlines, actions);
    case "quote":
      return withInlines(document.createElement("blockquote"), block.inlines, actions);
    case "code": {
      const pre = document.createElement("pre");
      pre.className = "md-code";
      if (block.language !== undefined) pre.dataset["language"] = block.language;
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      const wrapper = document.createElement("div");
      wrapper.className = "copyable-code";
      const control = actions.copyControl?.(block.text, "Copy code");
      if (control === undefined) return pre;
      wrapper.append(control, pre);
      return wrapper;
    }
    case "list": {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        list.append(withInlines(document.createElement("li"), item, actions));
      }
      return list;
    }
    case "table": {
      // The wrapper scrolls horizontally so a wide table never widens the
      // transcript column; alignment uses classes, not inline styles.
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      const table = document.createElement("table");
      table.className = "md-table";
      const cell = (tag: "th" | "td", inlines: readonly Inline[], column: number) => {
        const element = withInlines(document.createElement(tag), inlines, actions);
        const align = block.align[column];
        if (align !== null && align !== undefined) element.className = `align-${align}`;
        return element;
      };
      const headRow = document.createElement("tr");
      block.header.forEach((inlines, column) => headRow.append(cell("th", inlines, column)));
      const head = document.createElement("thead");
      head.append(headRow);
      table.append(head);
      if (block.rows.length > 0) {
        const body = document.createElement("tbody");
        for (const row of block.rows) {
          const tr = document.createElement("tr");
          row.forEach((inlines, column) => tr.append(cell("td", inlines, column)));
          body.append(tr);
        }
        table.append(body);
      }
      wrap.append(table);
      return wrap;
    }
  }
}

function withInlines<T extends HTMLElement>(element: T, inlines: readonly Inline[], actions: MarkdownActions): T {
  for (const inline of inlines) {
    element.append(renderInline(inline, actions));
  }
  return element;
}

function renderInline(inline: Inline, actions: MarkdownActions): Node {
  switch (inline.type) {
    case "text":
      return document.createTextNode(inline.text);
    case "code": {
      const code = document.createElement("code");
      code.className = "md-inline-code";
      code.textContent = inline.text;
      return code;
    }
    case "strong":
      return withInlines(document.createElement("strong"), inline.children, actions);
    case "em":
      return withInlines(document.createElement("em"), inline.children, actions);
    case "link": {
      const anchor = document.createElement("a");
      anchor.href = inline.href;
      anchor.title = inline.href;
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        actions.openLink(inline.href);
      });
      return withInlines(anchor, inline.children, actions);
    }
    case "path": {
      const label = inline.code ? Object.assign(document.createElement("code"), { className: "md-inline-code", textContent: inline.path }) : document.createTextNode(inline.path);
      const openPath = actions.openPath;
      if (openPath === undefined) return label;
      const anchor = document.createElement("a");
      anchor.className = "md-path";
      anchor.href = "#";
      anchor.title = `Open ${inline.path}`;
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPath(inline.path);
      });
      anchor.append(label);
      return anchor;
    }
  }
}
