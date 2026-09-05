/*
 * The markdown renderer, and the only security-critical code in the client.
 *
 * Its whole safety argument is an ordering claim — escapeHtml runs over the entire source
 * before any rule can match — so it is worth being the one part of the client you can find
 * without scrolling. render.escaping.test.ts is what holds that claim up.
 *
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const MARKDOWN = `
/* ---- markdown ------------------------------------------------------------------------
 * A small hand-written subset. Docket ships no runtime dependencies, and a markdown
 * library is a lot of code to hand peer-supplied text to.
 *
 * The safety argument is the order of operations, and it is the only one: escapeHtml()
 * runs over the WHOLE source before any rule below sees it, so by the time a rule can
 * match, the text cannot contain a tag. Every tag in the output is one this file wrote.
 * render.escaping.test.ts holds that line.
 */
const SAFE_LINK = /^https?:\\/\\//i;
const DESC_PREVIEW_CHARS = 300;

/*
 * Emphasis follows CommonMark's flanking rule — no whitespace just inside the markers —
 * rather than "any two asterisks". Descriptions are full of prose that is not markup:
 * "rename *.js to *.ts" and "the _id and _rev fields" both used to come out italicised
 * with the text between them eaten.
 */
const emphasise = (text) =>
  text
    .replace(/\\*\\*(?=\\S)([^\\n]*?\\S)\\*\\*/g, "<strong>$1</strong>")
    .replace(/~~(?=\\S)([^\\n]*?\\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\\w])\\*(?=\\S)([^*\\n]*?\\S)\\*(?!\\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\\w])_(?=\\S)([^_\\n]*?\\S)_(?![\\w_])/g, "$1<em>$2</em>");

function mdInline(escaped) {
  // Anything already converted to HTML is parked here so a later rule cannot match inside
  // it — the bare-URL rule must not rewrite the href of a link the previous rule just made.
  const held = [];
  const hold = (html) => { held.push(html); return "\\u0000" + (held.length - 1) + "\\u0000"; };
  const link = (href, label) => hold(\`<a href="\${href}" target="_blank" rel="noopener noreferrer">\${label}</a>\`);

  let s = escaped.replace(/\`([^\`\\n]+)\`/g, (_, code) => hold(\`<code>\${code}</code>\`));
  // A link whose target is not http(s) keeps its literal text rather than becoming a
  // clickable anything — same rule sourceLinkHtml() applies to the stored source URL.
  // emphasise() is applied to the label here as well as to the body below, because a held
  // span is opaque to every later rule — "[**x**](https://…)" would otherwise keep its
  // asterisks forever.
  s = s.replace(/\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)/g, (whole, label, href) =>
    SAFE_LINK.test(href) ? link(href, label ? emphasise(label) : href) : whole);
  // The URL class excludes the marker character: a bare URL sitting against a held span
  // would otherwise swallow the marker into its own href and destroy both.
  s = s.replace(/(^|[\\s(>])(https?:\\/\\/[^\\s<)\\u0000]+)/g, (_, before, url) => before + link(url, url));
  s = emphasise(s);
  /*
   * Repeat until nothing expands. A held span can contain another marker — a code span
   * inside a link label, "[\`config.ts\`](https://…)", is the everyday case — and a single
   * pass left that inner marker sitting in the output as a raw NUL, with the filename gone.
   * The loop is bounded by the table: every pass must consume at least one marker.
   */
  for (let pass = 0; pass <= held.length && s.includes("\\u0000"); pass++) {
    s = s.replace(/\\u0000(\\d+)\\u0000/g, (whole, i) => held[Number(i)] ?? whole);
  }
  // Belt and braces: a marker that somehow survived must never reach innerHTML.
  return s.replace(/\\u0000/g, "");
}

function renderMarkdown(src) {
  if (!src) return "";
  // NUL is the placeholder marker above. A stored description containing one could
  // otherwise address the placeholder table; it is also not something anyone typed.
  const lines = escapeHtml(String(src).replace(/\\u0000/g, "")).split("\\n");
  const out = [];
  let para = [];
  let quote = [];
  let indented = [];
  let list = null;
  let fence = null;

  const flushPara = () => { if (para.length) { out.push("<p>" + mdInline(para.join("<br>")) + "</p>"); para = []; } };
  const flushQuote = () => { if (quote.length) { out.push("<blockquote>" + mdInline(quote.join("<br>")) + "</blockquote>"); quote = []; } };
  // Already escaped, and deliberately NOT run through mdInline: inside code, markers are text.
  const flushIndented = () => { if (indented.length) { out.push("<pre><code>" + indented.join("\\n") + "</code></pre>"); indented = []; } };
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  // Closes every open block except the one about to continue, so each branch names only itself.
  const only = (keep) => {
    if (keep !== "para") flushPara();
    if (keep !== "quote") flushQuote();
    if (keep !== "code") flushIndented();
    if (keep !== "list") closeList();
  };
  const openList = (kind) => { if (list !== kind) { closeList(); out.push("<" + kind + ">"); list = kind; } };

  for (const line of lines) {
    if (fence !== null) {
      if (/^\\s*\`\`\`/.test(line)) { out.push("<pre><code>" + fence.join("\\n") + "</code></pre>"); fence = null; }
      else fence.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\\s+(.*)$/);
    const bullet = line.match(/^\\s*[-*+]\\s+(.*)$/);
    const numbered = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    // "&gt;", not ">": block detection runs on text escapeHtml has already been through,
    // which is the whole safety argument — so the marker it looks for is the escaped one.
    const quoted = line.match(/^\\s*&gt;\\s?(.*)$/);

    if (/^\\s*\`\`\`/.test(line)) { only(null); fence = []; }
    else if (!line.trim()) { only(null); }
    else if (/^\\s*(---|\\*\\*\\*|___)\\s*$/.test(line)) { only(null); out.push("<hr>"); }
    else if (heading) {
      only(null);
      const level = heading[1].length + 2; // # is an h3: the page already owns h1 and h2
      out.push("<h" + level + ">" + mdInline(heading[2]) + "</h" + level + ">");
    }
    // Four-space indent is a code block, as in every markdown dialect — and the reason this
    // rule exists here: .card-desc used to be pre-wrap, so a pasted stack trace kept its
    // shape. Without it, "    at foo (bar.ts:12)" would collapse into a paragraph.
    else if (/^(?: {4}|\\t)/.test(line) && !list && !para.length && !quote.length) {
      only("code");
      indented.push(line.replace(/^(?: {4}|\\t)/, ""));
    }
    else if (bullet) { only("list"); openList("ul"); out.push("<li>" + mdInline(bullet[1]) + "</li>"); }
    else if (numbered) { only("list"); openList("ol"); out.push("<li>" + mdInline(numbered[1]) + "</li>"); }
    else if (quoted) { only("quote"); quote.push(quoted[1]); }
    else { only("para"); para.push(line); }
  }
  // An unclosed fence still renders as code — dropping the text would be worse than the
  // author seeing their unfinished block.
  if (fence !== null && fence.length) out.push("<pre><code>" + fence.join("\\n") + "</code></pre>");
  only(null);
  return out.join("");
}

/** Cuts markdown SOURCE (not rendered HTML) to a preview length without leaving a half-open block. */
function clampMarkdown(src, max) {
  const text = String(src || "");
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  // Prefer a line break, then a word break, so the preview never ends mid-word.
  const stop = Math.max(cut.lastIndexOf("\\n"), cut.lastIndexOf(" "));
  if (stop > max * 0.6) cut = cut.slice(0, stop);
  cut = cut.replace(/\\s+$/, "");
  // An odd number of fences means the cut landed inside a code block. Close it rather than
  // trimming back to before it: a description that OPENS with a fence longer than the
  // preview would trim back to nothing and show an empty card with a "Read more" under it.
  if ((cut.match(/\`\`\`/g) || []).length % 2 === 1) cut += "\\n\`\`\`";
  return { text: cut, truncated: true };
}

`;
