/**
 * Markdown for the Office's conversation view.
 *
 * ── Provenance ────────────────────────────────────────────────────────────────────────────
 * This is Docket Core's src/web/client/app/markdown.ts, copied rather than imported, plus the
 * `escapeHtml` it takes from Core's util.ts. It is a copy for a mechanical reason, not a
 * stylistic one: Crew is a separate npm package whose tsconfig has `rootDir: "src"`, and the
 * browser is served compiled modules out of dist/office/client/ by a route that only matches
 * a bare module name — so a relative import reaching up into the other package cannot compile
 * and could not be fetched if it did. Vendoring the file is the only way to reuse the renderer
 * without adding a dependency or a build step, both of which Crew forbids.
 *
 * Keep it in sync with Core's copy. render.escaping.test.ts holds the safety line on this
 * copy independently, so a drift that weakened it would fail here first.
 *
 * ── The safety argument ───────────────────────────────────────────────────────────────────
 * It is the order of operations, and it is the only one: escapeHtml() runs over the WHOLE
 * source before any rule below sees it, so by the time a rule can match, the text cannot
 * contain a tag. Every tag in the output is one this file wrote. That matters more here than
 * in Core: these bodies are written by *models*, not by the person reading them.
 */

/**
 * THE escaper for the whole Office page — render.ts re-exports this one rather than keeping a
 * second copy. It lives here because markdown.ts is the leaf: it imports nothing, so every
 * other client module can reach it without a cycle.
 *
 * The ampersand must be replaced FIRST, or every other entity below becomes forgeable.
 */
export function escapeHtml(value: unknown): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (c) => replacements[c]);
}

const SAFE_LINK = /^https?:\/\//i;

/*
 * Emphasis follows CommonMark's flanking rule — no whitespace just inside the markers —
 * rather than "any two asterisks". Agent output is full of prose that is not markup:
 * "rename *.js to *.ts" and "the _id and _rev fields" both used to come out italicised
 * with the text between them eaten.
 */
const emphasise = (text: string): string =>
  text
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1<em>$2</em>");

function mdInline(escaped: string): string {
  // Anything already converted to HTML is parked here so a later rule cannot match inside
  // it — the bare-URL rule must not rewrite the href of a link the previous rule just made.
  const held: string[] = [];
  const hold = (html: string): string => {
    held.push(html);
    return "\u0000" + (held.length - 1) + "\u0000";
  };
  const link = (href: string, label: string): string =>
    hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);

  let s = escaped.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  // A link whose target is not http(s) keeps its literal text rather than becoming a
  // clickable anything. emphasise() is applied to the label here as well as to the body
  // below, because a held span is opaque to every later rule.
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, href) =>
    SAFE_LINK.test(href) ? link(href, label ? emphasise(label) : href) : whole,
  );
  // The URL class excludes the marker character: a bare URL sitting against a held span
  // would otherwise swallow the marker into its own href and destroy both.
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<)\u0000]+)/g, (_, before, url) => before + link(url, url));
  s = emphasise(s);
  /*
   * Repeat until nothing expands. A held span can contain another marker — a code span
   * inside a link label, "[`config.ts`](https://…)", is the everyday case — and a single
   * pass left that inner marker sitting in the output as a raw NUL, with the filename gone.
   * The loop is bounded by the table: every pass must consume at least one marker.
   */
  for (let pass = 0; pass <= held.length && s.includes("\u0000"); pass++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (whole, i) => held[Number(i)] ?? whole);
  }
  // Belt and braces: a marker that somehow survived must never reach innerHTML.
  return s.replace(/\u0000/g, "");
}

export function renderMarkdown(src: string | null | undefined): string {
  if (!src) return "";
  // NUL is the placeholder marker above. A body containing one could otherwise address the
  // placeholder table; it is also not something any runtime means to emit.
  const lines = escapeHtml(String(src).replace(/\u0000/g, "")).split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let indented: string[] = [];
  let list: "ul" | "ol" | null = null;
  let fence: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push("<p>" + mdInline(para.join("<br>")) + "</p>");
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push("<blockquote>" + mdInline(quote.join("<br>")) + "</blockquote>");
      quote = [];
    }
  };
  // Already escaped, and deliberately NOT run through mdInline: inside code, markers are text.
  const flushIndented = () => {
    if (indented.length) {
      out.push("<pre><code>" + indented.join("\n") + "</code></pre>");
      indented = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push("</" + list + ">");
      list = null;
    }
  };
  // Closes every open block except the one about to continue, so each branch names only itself.
  const only = (keep: "para" | "quote" | "code" | "list" | null): void => {
    if (keep !== "para") flushPara();
    if (keep !== "quote") flushQuote();
    if (keep !== "code") flushIndented();
    if (keep !== "list") closeList();
  };
  const openList = (kind: "ul" | "ol"): void => {
    if (list !== kind) {
      closeList();
      out.push("<" + kind + ">");
      list = kind;
    }
  };

  for (const line of lines) {
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push("<pre><code>" + fence.join("\n") + "</code></pre>");
        fence = null;
      } else fence.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    // "&gt;", not ">": block detection runs on text escapeHtml has already been through,
    // which is the whole safety argument — so the marker it looks for is the escaped one.
    const quoted = line.match(/^\s*&gt;\s?(.*)$/);

    if (/^\s*```/.test(line)) {
      only(null);
      fence = [];
    } else if (!line.trim()) {
      only(null);
    } else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      only(null);
      out.push("<hr>");
    } else if (heading) {
      only(null);
      // The page already owns h1 and h2, and a message block sits under an h2, so the
      // smallest heading a model can write starts at h4 here rather than Core's h3.
      const level = Math.min(6, heading[1].length + 3);
      out.push("<h" + level + ">" + mdInline(heading[2]) + "</h" + level + ">");
    } else if (/^(?: {4}|\t)/.test(line) && !list && !para.length && !quote.length) {
      only("code");
      indented.push(line.replace(/^(?: {4}|\t)/, ""));
    } else if (bullet) {
      only("list");
      openList("ul");
      out.push("<li>" + mdInline(bullet[1]) + "</li>");
    } else if (numbered) {
      only("list");
      openList("ol");
      out.push("<li>" + mdInline(numbered[1]) + "</li>");
    } else if (quoted) {
      only("quote");
      quote.push(quoted[1]);
    } else {
      only("para");
      para.push(line);
    }
  }
  // An unclosed fence still renders as code — dropping the text would be worse than the
  // reader seeing an unfinished block.
  if (fence !== null && fence.length) out.push("<pre><code>" + fence.join("\n") + "</code></pre>");
  only(null);
  return out.join("");
}
