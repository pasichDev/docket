/*
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the Office page's
 * stylesheet, and the same two rules apply as in Docket Core's src/web/client/styles.ts:
 *
 *  - a literal backtick ends the string. Reword instead of quoting an identifier with one;
 *    office.server.test.ts fails if one slips in.
 *  - a dollar followed by a brace interpolates. Never write one.
 *
 * The palette is Docket Core's Warm Workshop, token for token, so Office reads as the same
 * product seen from a different room. Dark is the default here as it is there.
 *
 * The second half of this file is the office scene. Every pixel of the art is an SVG <rect>
 * whose fill is one of the --px-* tokens below, so the whole room re-themes, re-tints per
 * role and re-colours per runtime from here, with no redraw and no JavaScript. Animation is
 * CSS keyframes selected by the data-pose / data-screen attribute on a seat: a status change
 * is one attribute write, and a room where nothing is happening runs no animation at all.
 */
export const OFFICE_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #1f1710; --card-shadow: 0 2px 10px rgba(0,0,0,.3);
    --text: #f0e6d8; --muted: #a89984; --muted2: #8f8268; --meta: #8f8268; --faint: #6b5f4c;
    --danger: #e2685a;
    --card-empty-border: #4a3c28;
    --input-bg: #2b2119; --input-border: #3d3122;
    --card-bg: #2b2119; --card-border: #3d3122;
    --sage: #7fc492; --sage-bg: #223523;
    --lavender: #c79ee8; --lavender-bg: #352a41;
    --accent: #f5a623; --accent-bg: #3a2a1a;
    --due-bg: #3a2a1a; --due-text: #e2a361;
    --overdue-bg: #3a1f1a; --overdue-text: #e2685a;
    --ink: #f0e6d8; --ink-text: #1f1710;
    /* The edge of the human's own speech container: accent, but a quarter of the volume — a
       full-strength accent hairline around every one of your turns shouts down the replies. */
    --you-edge: #6b4a24;

    /* ---- the office, in pixels ---- */
    --px-wall: #33261a; --px-wall-2: #2c2016; --px-baseboard: #241a11;
    --px-floor: #4a3722; --px-floor-2: #43311e; --px-rug: #3a2b1c;
    --px-sky: #2c3a4d; --px-sky-2: #3a4b60; --px-door: #4f3a25;
    --px-chair-dark: #241c14; --px-chair: #4a3a26;
    --px-skin: #e2b489; --px-eye: #241c14; --px-mouth: #a8604c;
    --px-hair: #3a2a1c; --px-shirt: #6f97c4;
    --px-frame: #52412c; --px-desk: #7a5a38; --px-desk-dark: #573f27;
    --px-mug: #d98b4a; --px-paper: #e8dcc4; --px-lamp: #f5a623;
    --px-rt: #f5a623; --px-hire: #f5a623;
    --px-cab: #6b5136; --px-cab-drawer: #7f6142; --px-cab-handle: #e0bd80;
    --px-ghost: #8fb4d8; --px-ghost-eye: #2c3a4d;
    --px-screen-on: #ffcf7a; --px-screen-dim: #64796d; --px-screen-boot: #9fd9b4;
    --px-screen-alert: #c9412f; --px-screen-off: #2a2820; --px-alert-mark: #ffe9e4;
    --px-bubble-bg: #f6ecdc; --px-bubble-ink: #33261a; --px-bubble-line: #241a11;
    --px-shadow: rgba(0,0,0,.45);
  }
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #faf5ec; --card-shadow: 0 2px 8px rgba(61,50,41,.05);
    --text: #3d3229; --muted: #8a7a63; --muted2: #a8987f; --meta: #b4a488; --faint: #c9bca3;
    --danger: #b8402c;
    --card-empty-border: #e3d5b8;
    --input-bg: #ffffff; --input-border: #f0e2c9;
    --card-bg: #ffffff; --card-border: #f0e2c9;
    --sage: #3f7a50; --sage-bg: #e7f3ea;
    --lavender: #7c4f9e; --lavender-bg: #f1e9f7;
    --accent: #f5a623; --accent-bg: #fdeee0;
    --due-bg: #fdeee0; --due-text: #b8722f;
    --overdue-bg: #fbdcd6; --overdue-text: #b8402c;
    --ink: #3d3229; --ink-text: #ffffff;
    --you-edge: #f2cfa6;

    --px-wall: #f0e2c6; --px-wall-2: #e7d6b4; --px-baseboard: #c9ae82;
    --px-floor: #d8b98b; --px-floor-2: #cfae7c; --px-rug: #e3cba3;
    --px-sky: #bcd8ef; --px-sky-2: #d6e9f7; --px-door: #b98d5b;
    --px-chair-dark: #6b5335; --px-chair: #a3855c;
    --px-skin: #f0c9a2; --px-eye: #3d3229; --px-mouth: #c07561;
    --px-hair: #5b402a; --px-shirt: #5b86b8;
    --px-frame: #8a6c47; --px-desk: #c08f57; --px-desk-dark: #9c703f;
    --px-mug: #e0913f; --px-paper: #fffaf0; --px-lamp: #f5a623;
    --px-rt: #d98b1a; --px-hire: #d98b1a;
    --px-cab: #b98d5b; --px-cab-drawer: #cda071; --px-cab-handle: #6b5335;
    --px-ghost: #6f9dc9; --px-ghost-eye: #ffffff;
    --px-screen-on: #ffd77f; --px-screen-dim: #b9c4be; --px-screen-boot: #8fd3ac;
    --px-screen-alert: #d64b34; --px-screen-off: #8d8878; --px-alert-mark: #fff4f1;
    --px-bubble-bg: #ffffff; --px-bubble-ink: #3d3229; --px-bubble-line: #8a6c47;
    --px-shadow: rgba(61,50,41,.22);
  }

  * { box-sizing: border-box; }
  /* An app shell, not a document: the page itself never scrolls, the conversation does.
     A chat whose composer scrolls off the bottom is the thing being fixed here. */
  body {
    margin: 0; padding: 12px 16px 14px; background: var(--bg); color: var(--text);
    font-family: 'Karla', system-ui, sans-serif; font-size: 14px;
    display: flex; flex-direction: column; gap: 10px; height: 100vh; overflow: hidden;
  }
  h1, h2, h3 { font-family: 'Fredoka', sans-serif; font-weight: 600; margin: 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
  .faint { color: var(--muted2); }
  .empty { color: var(--muted2); font-style: italic; font-size: 13px; padding: 8px 2px; margin: 0; }
  .warn { color: var(--due-text); background: var(--due-bg); border-radius: 12px; padding: 9px 13px; font-size: 12.5px; margin: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: var(--input-bg); padding: 1px 5px; border-radius: 5px; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* ---- header ------------------------------------------------------------------------ */
  header {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding-bottom: 10px; border-bottom: 1px solid var(--card-border);
  }
  header h1 { font-size: 19px; font-weight: 700; }
  .ws {
    font-size: 12px; font-weight: 700; color: var(--lavender); background: var(--lavender-bg);
    padding: 3px 11px; border-radius: 999px;
  }
  .conn {
    font-size: 12px; font-weight: 600; padding: 3px 11px; border-radius: 999px;
    display: inline-flex; align-items: center; gap: 6px; background: var(--input-bg); color: var(--muted);
  }
  .conn::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted2); }
  .conn[data-state="live"] { background: var(--sage-bg); color: var(--sage); }
  .conn[data-state="live"]::before { background: var(--sage); animation: blip 2s ease-in-out infinite; }
  .conn[data-state="connecting"] { background: var(--due-bg); color: var(--due-text); }
  .conn[data-state="connecting"]::before { background: var(--due-text); }
  .conn[data-state="down"] { background: var(--overdue-bg); color: var(--overdue-text); }
  .conn[data-state="down"]::before { background: var(--overdue-text); }
  @keyframes blip { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .spacer { flex: 1; }
  .paused-badge {
    font-size: 11px; font-weight: 700; color: var(--overdue-text); background: var(--overdue-bg);
    padding: 3px 10px; border-radius: 999px;
  }

  /* ---- buttons ----------------------------------------------------------------------- */
  .btn {
    font-family: 'Fredoka', sans-serif; font-size: 12px; font-weight: 600; cursor: pointer;
    border: none; border-radius: 999px; padding: 7px 14px; white-space: nowrap;
    background: var(--input-bg); color: var(--muted);
    box-shadow: 0 0 0 1px var(--input-border) inset;
  }
  .btn:hover:not(:disabled) { color: var(--text); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn-solid { background: var(--sage); color: #fff; box-shadow: none; }
  .btn-solid:hover:not(:disabled) { filter: brightness(1.08); color: #fff; }
  .btn-primary { background: var(--accent); color: #2b2119; box-shadow: none; }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.08); color: #2b2119; }
  .btn-ghost { padding: 5px 11px; font-size: 11.5px; }
  .btn.danger { color: var(--danger); }
  .btn.danger:hover:not(:disabled) { background: var(--overdue-bg); }
  /* A pressed toggle reads as pressed — unless it is also the primary action, which outranks
     it. "Resume manager" is pressed (auto-wake is off) AND the one thing to do next, and it
     used to lose its accent to this rule and look like an inactive toggle. */
  .btn:not(.btn-primary):not(.btn-solid)[aria-pressed="true"] {
    background: var(--lavender-bg); color: var(--lavender); box-shadow: none;
  }

  input[type=text], textarea, select {
    font: inherit; font-size: 13px; border: none; border-radius: 12px; padding: 9px 13px;
    background: var(--input-bg); color: var(--text);
    box-shadow: 0 0 0 1px var(--input-border) inset; width: 100%;
  }
  textarea { resize: vertical; font-family: 'Karla', system-ui, sans-serif; }
  input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .field-label { font-family: 'Fredoka', sans-serif; font-size: 10.5px; font-weight: 600; color: var(--meta); margin-bottom: 4px; text-transform: uppercase; letter-spacing: .04em; }

  #notice[hidden] { display: none; }
  #notice {
    background: var(--overdue-bg); color: var(--overdue-text); border-radius: 12px;
    padding: 10px 14px; font-size: 12.5px; font-weight: 600;
  }

  /* ---- the two panes --------------------------------------------------------------------
   * The composition, and the reason it is this one.
   *
   * The chat used to be a 940px card centred by parking an equally wide EMPTY column to its
   * left as a counterweight, with the office squeezed against the right edge. The midpoint
   * measured dead centre and the page still read as a misplaced block, because a third of the
   * window was dead ground belonging to nothing. A centring test that passes on a page that
   * looks broken measured the wrong thing.
   *
   * So: nothing is centred by emptiness any more. The chat is the surface — it takes every
   * pixel the office dock does not, edge to edge, and the READING COLUMN inside it is what is
   * capped and centred (.chat-col / .ask-col). The whitespace either side of the prose is then
   * the chat's own margin, which is what every chat product looks like, rather than page
   * background with a slab floating in it. Hide the office and the same column simply centres
   * in a wider surface; nothing else moves.
   */
  .panes {
    flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px;
    align-items: stretch;
  }
  .panes > .chat { width: 100%; min-width: 0; }
  .panes > .stage { width: 100%; }

  /*
   * Wide enough for two columns: the office becomes a dock on the right and the conversation
   * takes the whole rest of the window at full height. Not gated on height any more — a dock
   * is the better composition on a wide screen whatever its height, and the old height gate is
   * what produced two completely different layouts a hundred pixels apart.
   */
  @media (min-width: 1180px) {
    .panes { flex-direction: row; align-items: stretch; }
    .panes > .chat { flex: 1 1 auto; min-width: 0; }
    .panes > .stage {
      flex: 0 0 clamp(300px, 23vw, 380px); max-width: none; max-height: none; min-height: 0;
    }
    /* A narrow room stacks its zones, the way it already does on a phone. */
    .panes > .stage .floor {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "lead" "workers" "review";
    }
    .panes > .stage .zone-review {
      border-left: none; padding-left: 0;
      border-top: 3px dashed var(--px-rug); padding-top: 8px;
    }
    .panes > .stage .zone-lead { align-self: auto; padding: 0; }
    .panes > .stage .zone-review .seats { justify-content: flex-start; }
  }

  /* ---- the conversation ---------------------------------------------------------------
     The primary working surface. It gets the leftover height, scrolls internally, and keeps
     its composer pinned at the bottom edge where the office band begins. */
  .chat {
    background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px;
    box-shadow: var(--card-shadow); position: relative;
    display: flex; flex-direction: column; flex: 1 1 auto; min-height: 260px; overflow: hidden;
  }
  .chat-bar {
    display: flex; align-items: center; gap: 8px; padding: 9px 16px;
    border-bottom: 1px solid var(--card-border); flex: 0 0 auto; background: var(--card-bg);
  }
  .chat-h { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--meta); }
  /* The well the conversation sits in is a shade DOWN from the card, so a speech container can
     be a shade up from it. Bubbles used to be var(--input-bg) on a var(--card-bg) pane — the
     same colour — which is why every message read as a flat panel with a border. */
  .chat-scroll {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    padding: 16px 20px 10px; background: var(--bg);
  }
  /* The reading column. Capped for measure, centred inside a full-width surface. */
  .chat-col { max-width: 780px; margin: 0 auto; }
  ol.chat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .cb-empty { color: var(--muted2); font-size: 13.5px; text-align: center; padding: 24px 0; }

  /* ---- one speaker block ----------------------------------------------------------------
   * Avatar in a gutter, name above, words in a container with a tail. Three signals that
   * somebody is talking, none of which a log line has.
   */
  .cb-msg {
    display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 10px; align-items: start;
    --px-shirt: #6f97c4; --bubble: var(--card-bg); --edge: var(--card-border);
  }
  .cb-msg[data-role="manager"] { --px-shirt: var(--lavender); }
  .cb-msg[data-role="reviewer"] { --px-shirt: var(--sage); }
  .cb-msg[data-hair="0"] { --px-hair: #3a2a1c; }
  .cb-msg[data-hair="1"] { --px-hair: #7a4a26; }
  .cb-msg[data-hair="2"] { --px-hair: #9aa0a8; }
  .cb-msg[data-hair="3"] { --px-hair: #c9762f; }
  .cb-msg[data-hair="4"] { --px-hair: #23303f; }

  .cm-col { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .cm-av {
    width: 30px; height: 30px; margin-top: 16px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%; background: var(--card-bg);
    box-shadow: 0 0 0 1.5px var(--px-shirt);
  }
  .px-avatar { width: 19px; height: auto; display: block; shape-rendering: crispEdges; }
  .cm-who { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 12.5px; color: var(--text); }
  .cb-msg[data-role="manager"] .cm-who { color: var(--lavender); }
  .cb-msg[data-role="reviewer"] .cm-who { color: var(--sage); }
  .cm-head { display: flex; align-items: baseline; gap: 7px; padding: 0 3px; }
  .cm-tag {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    padding: 1px 7px; border-radius: 999px; background: var(--input-bg); color: var(--muted2);
  }
  .cm-tag-manager { background: var(--lavender-bg); color: var(--lavender); }
  .cm-tag-reviewer { background: var(--sage-bg); color: var(--sage); }
  .cm-tag-you { background: var(--accent); color: #2b2119; }
  /* Quiet until wanted: the clock is not what anyone came to the conversation to read. */
  .cm-time {
    margin-left: auto; font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums;
    opacity: .55; transition: opacity .12s ease;
  }
  .cb-msg:hover .cm-time, .cb-msg:focus-within .cm-time { opacity: 1; }

  /* The speech container. The square corner is the tail — it points at the avatar. */
  .cm-bubble {
    background: var(--bubble); border: 1px solid var(--edge);
    border-radius: 4px 15px 15px 15px; padding: 11px 15px 12px;
    box-shadow: 0 1px 2px rgba(0,0,0,.12);
  }
  html[data-theme="light"] .cm-bubble { box-shadow: 0 1px 2px rgba(61,50,41,.05); }
  .cm-body { display: flex; flex-direction: column; gap: 9px; }

  /*
   * The human's own turns come from the other side of the conversation, which is the plainest
   * human-vs-agent signal there is — you never have to read a name to know which is which.
   */
  .cb-msg[data-kind="human"] {
    grid-template-columns: minmax(0, 1fr) 30px;
    --px-shirt: var(--accent); --px-hair: #4a3520;
    --bubble: var(--accent-bg); --edge: var(--you-edge);
  }
  .cb-msg[data-kind="human"] .cm-av { grid-column: 2; grid-row: 1; }
  .cb-msg[data-kind="human"] .cm-col { grid-column: 1; grid-row: 1; align-items: flex-end; }
  .cb-msg[data-kind="human"] .cm-head { flex-direction: row-reverse; }
  .cb-msg[data-kind="human"] .cm-time { margin-left: 0; margin-right: auto; }
  .cb-msg[data-kind="human"] .cm-bubble { border-radius: 15px 4px 15px 15px; max-width: 88%; }
  /* With no name beside it, the badge is the name — so it is set like one. */
  .cb-msg[data-kind="human"] .cm-tag-you {
    font-size: 10px; letter-spacing: .08em; padding: 2px 9px;
  }

  /* ---- what was actually said ----------------------------------------------------------
     Readable type, real line-height, full text. A long reply is clamped with a fade and a
     Show more, never cut with an ellipsis: nothing the agent wrote is thrown away. */
  .cm-say { position: relative; }
  .cm-say[data-long="true"] .md { max-height: 17em; overflow: hidden; }
  .cm-say[data-long="true"][data-open="true"] .md { max-height: none; }
  .cm-say[data-long="true"]:not([data-open="true"])::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: 24px; height: 44px;
    background: linear-gradient(transparent, var(--bubble));
    pointer-events: none;
  }
  .cm-more {
    position: relative; margin-top: 6px; font-family: 'Fredoka', sans-serif; font-size: 11.5px;
    font-weight: 600; cursor: pointer; border: none; background: none; padding: 2px 0;
    color: var(--accent);
  }
  .cm-more:hover { text-decoration: underline; }
  .cm-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .cm-clipped {
    margin: 7px 0 0; font-size: 10.5px; line-height: 1.45; color: var(--muted2);
  }
  /* Prose, set as prose: proportional face, real line-height, room to breathe. Monospace in
     here is reserved for code — an inline code span and a fenced block, and nothing else. */
  .md { font-size: 14px; line-height: 1.68; color: var(--text); word-break: break-word; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 .68em; }
  .md h4, .md h5, .md h6 { font-family: 'Fredoka', sans-serif; font-size: 14px; margin: 1em 0 .4em; color: var(--text); }
  .md ul, .md ol { margin: .35em 0 .68em; padding-left: 1.4em; }
  .md ul { list-style: disc; }
  .md ol { list-style: decimal; }
  .md ul ul { list-style: circle; }
  .md li { margin: .24em 0; }
  .md li::marker { color: var(--muted2); }
  .md code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .84em;
    background: var(--input-bg); padding: 1.5px 5px; border-radius: 5px; color: var(--due-text);
    box-shadow: 0 0 0 1px var(--card-border) inset;
  }
  .md pre {
    background: var(--bg); border-radius: 10px; padding: 10px 13px; overflow-x: auto;
    margin: .6em 0 .75em; box-shadow: 0 0 0 1px var(--card-border) inset;
  }
  .md pre code { background: none; padding: 0; box-shadow: none; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .md blockquote {
    margin: .5em 0; padding: 3px 0 3px 12px; border-left: 3px solid var(--card-empty-border);
    color: var(--muted);
  }
  .md a { color: var(--lavender); }
  .md strong { font-weight: 700; color: var(--text); }
  .md hr { border: none; border-top: 1px solid var(--card-border); margin: .8em 0; }

  /* ---- the mechanics, folded ------------------------------------------------------------
     init / started a turn / used <tool> / N message(s) delivered belong to the turn, not to
     the conversation. One muted line per block, and everything is still one click away. */
  .cm-acts { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--card-border); }
  .cm-acts-btn {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    background: none; border: 1px solid transparent; border-radius: 999px;
    padding: 2px 9px 2px 7px; margin-left: -7px; text-align: left;
    font-family: 'Karla', system-ui, sans-serif; font-size: 10.5px; color: var(--faint);
  }
  .cm-acts-btn:hover { color: var(--muted); border-color: var(--card-border); }
  .cm-acts-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cm-acts-mark {
    width: 4px; height: 4px; border-radius: 50%; background: currentColor; flex: 0 0 auto; opacity: .7;
  }
  .cm-acts-btn::after { content: "▾"; font-size: 8px; opacity: .6; }
  .cm-acts-btn[aria-expanded="true"]::after { content: "▴"; }
  ol.cm-acts-list {
    list-style: none; margin: 7px 0 1px; padding: 8px 11px; border-radius: 9px;
    background: var(--bg); box-shadow: 0 0 0 1px var(--card-border) inset;
    display: flex; flex-direction: column; gap: 3px;
  }
  ol.cm-acts-list[hidden] { display: none; }
  .cm-acts-list li { display: flex; gap: 10px; align-items: baseline; font-size: 11px; }
  .cm-acts-list time { color: var(--faint); font-variant-numeric: tabular-nums; flex: 0 0 auto; font-size: 10px; }
  /* The fold is the one place raw mechanics belong, and even here they are prose-set — the
     tool names are words, not a terminal transcript. */
  .cm-acts-list span { color: var(--muted2); word-break: break-word; font-size: 11px; line-height: 1.45; }

  /* ---- what happened, as opposed to what was said ----------------------------------------
   * Notes and system lines are markers ON the conversation, not turns in it, so they are set
   * the way every chat product sets "X joined": small, centred, low contrast, no italics, no
   * terminal face. Nothing in the column can be mistaken for stdout because nothing in the
   * column is styled like it.
   */
  .cb-note, .cb-system { padding: 2px 0; }
  /* A turn that did things and said nothing: one centred line, name included, no container. */
  .cb-acts {
    padding: 2px 0; display: flex; align-items: center; justify-content: center; gap: 7px;
  }
  .cb-acts .cm-acts { margin: 0; padding-top: 0; border-top: none; }
  .ca-who { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 10.5px; color: var(--muted2); }
  ul.cn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; align-items: center; }
  .cn {
    display: inline-flex; align-items: baseline; gap: 7px; max-width: 100%;
    font-size: 11px; line-height: 1.5; padding: 2px 11px; border-radius: 999px;
    background: var(--card-bg); box-shadow: 0 0 0 1px var(--card-border);
  }
  .cn-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted2); flex: 0 0 auto; align-self: center; }
  .cn[data-kind="manager"] .cn-dot { background: var(--lavender); }
  .cn[data-kind="worker"] .cn-dot { background: var(--accent); }
  .cn[data-kind="review"] .cn-dot { background: var(--sage); }
  .cn[data-kind="error"] .cn-dot { background: var(--danger); }
  .cn-time {
    color: var(--faint); font-variant-numeric: tabular-nums; font-size: 10px; flex: 0 0 auto;
    opacity: .6;
  }
  .cn:hover .cn-time { opacity: 1; }
  .cn-who { font-family: 'Fredoka', sans-serif; font-weight: 600; color: var(--muted); }
  .cn-text { color: var(--muted2); word-break: break-word; min-width: 0; }
  .cn[data-kind="error"] .cn-text { color: var(--overdue-text); }
  /* The daemon coming up and going down is the quietest thing on the page. */
  .cb-system .cn { background: transparent; box-shadow: none; }
  .cb-system .cn-text { color: var(--faint); }

  /* ---- the raw log, for when you want the stream itself ---------------------------------- */
  ul.feed {
    list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px;
  }
  ul.feed[hidden] { display: none; }
  .fd-row {
    display: grid; grid-template-columns: 8px 42px auto; gap: 7px; align-items: baseline;
    padding: 3px 4px; border-radius: 8px; font-size: 12px; line-height: 1.45;
  }
  .fd-row:hover { background: var(--input-bg); }
  .fd-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted2); align-self: center; }
  .fd-row[data-kind="manager"] .fd-dot { background: var(--lavender); }
  .fd-row[data-kind="worker"] .fd-dot { background: var(--accent); }
  .fd-row[data-kind="review"] .fd-dot { background: var(--sage); }
  .fd-row[data-kind="error"] .fd-dot { background: var(--danger); }
  .fd-time { color: var(--faint); font-variant-numeric: tabular-nums; font-size: 11px; }
  .fd-actor { grid-column: 3; font-family: 'Fredoka', sans-serif; font-weight: 600; color: var(--text); }
  .fd-actor + .fd-text { grid-column: 3; color: var(--muted); }
  .fd-text { grid-column: 3; color: var(--muted); word-break: break-word; }
  .fd-row[data-kind="error"] .fd-text { color: var(--overdue-text); }

  /* ---- jump to latest --------------------------------------------------------------------
     Autoscroll sticks to the bottom, but never yanks the view out from under someone who
     scrolled up to read. This is how they get back. */
  .jump {
    position: absolute; left: 50%; transform: translateX(-50%); bottom: 104px; z-index: 4;
    font-family: 'Fredoka', sans-serif; font-size: 11.5px; font-weight: 600; cursor: pointer;
    border: none; border-radius: 999px; padding: 6px 15px;
    background: var(--ink); color: var(--ink-text); box-shadow: 0 4px 14px rgba(0,0,0,.35);
  }
  .jump[hidden] { display: none; }
  .jump:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ---- the live turn indicator ------------------------------------------------------------
   * A turn takes 20–60 seconds and the conversation used to say nothing for all of it. This is
   * the row that says who is thinking, since when, and what they last did — shaped like the
   * speaker blocks above it (same avatar gutter, same role tint, same hair) so it reads as
   * that agent about to talk rather than as a status bar bolted to the bottom of the page.
   *
   * It is driven entirely by real state: see turnIndicators() in render.ts. Nothing in this
   * stylesheet can hold a row up that the daemon has stopped reporting.
   */
  .turns { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
  .turns[hidden] { display: none; }
  .tw {
    display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 10px; align-items: start;
    --px-shirt: #6f97c4;
  }
  .tw[data-role="manager"] { --px-shirt: var(--lavender); }
  .tw[data-role="reviewer"] { --px-shirt: var(--sage); }
  .tw[data-hair="0"] { --px-hair: #3a2a1c; }
  .tw[data-hair="1"] { --px-hair: #7a4a26; }
  .tw[data-hair="2"] { --px-hair: #9aa0a8; }
  .tw[data-hair="3"] { --px-hair: #c9762f; }
  .tw[data-hair="4"] { --px-hair: #23303f; }
  .tw-av {
    width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
    border-radius: 50%; background: var(--card-bg); box-shadow: 0 0 0 1.5px var(--px-shirt);
  }
  /* Hugs its content the way a speech container does — a full-width band across the column
     would read as a page-level status bar rather than as this agent being about to talk. */
  .tw-col {
    min-width: 0; width: fit-content; max-width: 100%;
    display: flex; flex-direction: column; gap: 3px;
    background: var(--card-bg); border: 1px solid var(--card-border);
    border-radius: 4px 15px 15px 15px; padding: 8px 14px 9px;
  }
  .tw-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .tw-who { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 12.5px; color: var(--text); }
  .tw[data-role="manager"] .tw-who { color: var(--lavender); }
  .tw[data-role="reviewer"] .tw-who { color: var(--sage); }
  .tw-state { font-size: 11.5px; color: var(--muted); }
  .tw-since { font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .tw-line {
    margin: 0; font-size: 11.5px; line-height: 1.45; color: var(--muted2); word-break: break-word;
  }
  /* Three dots, one animation, no timer anywhere near it: the dots say "a turn is open", and
     the turn is open because /api/state says the agent's status is working. */
  .tw-dots { display: inline-flex; gap: 3px; align-items: center; }
  .tw-dots i {
    width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: .28;
    animation: tw-pulse 1.25s ease-in-out infinite;
  }
  .tw-dots i:nth-child(2) { animation-delay: .18s; }
  .tw-dots i:nth-child(3) { animation-delay: .36s; }
  @keyframes tw-pulse { 0%, 70%, 100% { opacity: .28; } 35% { opacity: 1; } }
  .tw[data-phase="starting"] .tw-dots i { background: var(--px-screen-boot); }
  /* An ending that was not a success. The reply IS the outcome of a good turn, so only these
     get a row — and they are unmistakably not a spinner: no dots, danger colour, a reason. */
  .tw[data-phase="failed"] { --px-shirt: var(--danger); }
  .tw[data-phase="failed"] .tw-col { border-color: var(--danger); background: var(--overdue-bg); }
  .tw[data-phase="failed"] .tw-state,
  .tw[data-phase="failed"] .tw-line { color: var(--overdue-text); }
  .tw[data-phase="failed"] .tw-who { color: var(--overdue-text); }
  .tw[data-phase="cancelled"] .tw-col,
  .tw[data-phase="stopped"] .tw-col { border-style: dashed; }
  .tw[data-phase="cancelled"] .tw-state,
  .tw[data-phase="stopped"] .tw-state { color: var(--muted2); font-style: italic; }

  /* ---- the composer ----------------------------------------------------------------------
   * Same column as the conversation, so the thing you type lines up with the thing you read.
   *
   * ONE shell holds both the recipient strip and the box, because they are one decision: what
   * you are about to say and who is about to get it. They used to be a label row floating
   * above a separate rounded field, which is a form, and a form at the foot of a chat reads as
   * something that belongs to the page rather than to the conversation.
   *
   * The box has a RESTING HEIGHT of two lines (60px = ASK_MIN_H in app.ts) and grows a line at
   * a time to a ceiling of eight (190px = ASK_MAX_H), then scrolls inside itself. Before this
   * it was a single 38px line that never grew: everything past the first line was hidden behind
   * an invisible scroll, and the surrounding chrome shifted whenever the direct-message pill
   * appeared. Two lines at rest is the height at which a normal instruction fits with the pane
   * not moving at all — the first line and the second one both cost nothing.
   *
   * The two numbers live in app.ts as well because the browser is what measures the content;
   * these are the floor for a page whose script has not run yet, and they must agree.
   */
  .ask {
    flex: 0 0 auto; padding: 12px 20px 14px; border-top: 1px solid var(--card-border);
    background: var(--card-bg);
  }
  .ask-col { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: 5px; }
  .ask-shell {
    display: flex; flex-direction: column;
    background: var(--input-bg); border-radius: 18px;
    box-shadow: 0 0 0 1px var(--input-border) inset;
    /* The recipient strip is a full-bleed band inside the shell, so the shell's own radius has
       to be what clips it — otherwise its corners spill past the ring in the direct state. */
    overflow: hidden;
  }
  .ask-shell:focus-within { box-shadow: 0 0 0 2px var(--accent) inset; }
  .ask-row { display: flex; align-items: flex-end; gap: 8px; padding: 2px 6px 6px 7px; }
  .ask textarea {
    flex: 1; min-width: 0; height: 60px; min-height: 60px; max-height: 190px;
    font-size: 14px; line-height: 1.55; padding: 8px 10px;
    background: none; box-shadow: none; border-radius: 12px;
    /* The drag handle fights the autogrow, and a box that grows to fit does not need one. */
    resize: none; overflow-y: hidden;
  }
  .ask textarea[data-full="true"] { overflow-y: auto; }
  .ask textarea:focus-visible { outline: none; }
  .ask-send { flex: 0 0 auto; padding: 9px 20px; margin-bottom: 3px; }
  /* Who the message is going to, inside the box you type it in. The default is the manager;
     anything else repaints the whole composer, because bypassing the manager is a real decision. */
  /* 17px of lead so "TO" sits on the same optical margin as the first character you type
     (the row's 7px plus the textarea's own 10px), not a few pixels off it. */
  .ask-to {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px 2px 17px;
  }
  .ask-to-l {
    font-family: 'Fredoka', sans-serif; font-size: 10px; font-weight: 600; color: var(--meta);
    text-transform: uppercase; letter-spacing: .06em;
  }
  #ask-target {
    width: auto; max-width: 240px; padding: 4px 10px; font-size: 12px; border-radius: 999px;
    background: var(--card-bg); cursor: pointer;
  }
  .ask-direct {
    font-size: 10.5px; font-weight: 700; color: var(--lavender); background: var(--lavender-bg);
    padding: 2px 10px; border-radius: 999px; box-shadow: 0 0 0 1px var(--lavender) inset;
  }
  .ask-direct[hidden] { display: none; }
  .ask-hint { font-size: 10px; color: var(--faint); align-self: flex-end; padding-right: 4px; }

  /* Addressing a worker directly is a different mode, and it looks like one before you send:
     the shell carries the lavender that marks direct traffic everywhere else on the page, and
     the picker itself becomes the loud element rather than a quiet select in a label row. */
  .ask[data-direct="true"] .ask-shell {
    box-shadow: 0 0 0 2px var(--lavender) inset;
  }
  .ask[data-direct="true"] .ask-shell:focus-within {
    box-shadow: 0 0 0 2px var(--lavender) inset, 0 0 0 4px var(--lavender-bg);
  }
  .ask[data-direct="true"] .ask-to { background: var(--lavender-bg); }
  .ask[data-direct="true"] .ask-to-l { color: var(--lavender); }
  .ask[data-direct="true"] #ask-target {
    color: var(--lavender); font-weight: 700; box-shadow: 0 0 0 1px var(--lavender) inset;
  }
  .ask[data-direct="true"] .ask-send { background: var(--lavender); color: #fff; }

  /* ================= THE OFFICE ======================================================= */

  .stage {
    border: 1px solid var(--card-border); border-radius: 18px; overflow: hidden;
    box-shadow: var(--card-shadow); background: var(--px-wall);
    display: flex; flex-direction: column; flex: 0 0 auto; position: relative;
    max-height: min(292px, 36vh);
  }
  /* Collapsed: the conversation takes the whole window. The office is lovely but the chat is
     what the user reads all day, so hiding it has to be one click and it has to persist. */
  .stage[data-collapsed="true"] { display: none; }
  /* The view toggle hides one of the two with the hidden attribute, so that a screen reader
     is never told about both. A display rule on the element itself outranks the UA's
     [hidden] { display: none }, so it has to be restated here or the attribute does nothing. */
  .stage[hidden] { display: none; }

  /* ---- back wall: the cabinet, the window, the door ---------------------------------- */
  .wall {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 14px; align-items: flex-end; padding: 5px 18px 0; flex: 0 0 auto;
    background: linear-gradient(180deg, var(--px-wall-2) 0%, var(--px-wall) 70%);
    border-bottom: 7px solid var(--px-baseboard);
  }
  .wall-slot { display: flex; align-items: flex-end; gap: 12px; min-width: 0; }
  /* The window is a window, not a wall of glass: a fixed pane with wall around it. */
  .wall-window { flex-direction: column; align-items: center; gap: 5px; }

  .window {
    position: relative; width: 168px; height: 48px; overflow: hidden;
    border: 4px solid var(--px-frame);
    box-shadow: 0 3px 0 var(--px-shadow);
    background: linear-gradient(180deg, var(--px-sky-2) 0%, var(--px-sky) 100%);
  }
  .mullion-v { position: absolute; inset: 0 auto 0 50%; width: 4px; background: var(--px-frame); }
  .mullion-h { position: absolute; inset: 50% 0 auto 0; height: 4px; background: var(--px-frame); }
  .glass { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; padding: 0 8px 4px; z-index: 1; }
  ul.ghosts { list-style: none; margin: 0; padding: 0; display: flex; gap: 12px; align-items: flex-end; flex-wrap: nowrap; overflow: hidden; }
  .window-note[hidden] { display: none; }
  .window-note {
    margin: 0; font-size: 8.5px; line-height: 1.35; color: var(--muted2);
    max-width: 44ch; text-align: center;
  }

  /* Observed sessions. Behind glass, translucent, drifting, and — the point — not a button
     and not carrying a single data-act hook anywhere inside. Crew did not launch them. */
  .ghost { position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .px-ghost-art { width: 30px; height: auto; display: block; shape-rendering: crispEdges; opacity: .62; }
  .ghost-name {
    font-family: 'Fredoka', sans-serif; font-size: 8.5px; font-weight: 600; letter-spacing: .02em;
    color: var(--px-ghost); opacity: .9; max-width: 74px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .ghost .px-ghost-art { animation: px-float 4.2s ease-in-out infinite; }
  .ghost:nth-child(2n) .px-ghost-art { animation-duration: 5.1s; animation-delay: -1.4s; }
  .ghost:nth-child(3n) .px-ghost-art { animation-duration: 3.7s; animation-delay: -.7s; }
  @keyframes px-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

  .door {
    position: relative; width: 32px; height: 54px;
    background: var(--px-door); border: 4px solid var(--px-frame); border-bottom: none;
  }
  .knob { position: absolute; right: 4px; top: 26px; width: 5px; height: 5px; background: var(--px-cab-handle); }
  .plant { position: relative; width: 18px; height: 28px; }
  .pot { position: absolute; bottom: 0; left: 5px; width: 20px; height: 16px; background: var(--px-mug); }
  .leaf { position: absolute; width: 8px; background: #5c8f5f; }
  .leaf.l1 { left: 3px;  bottom: 14px; height: 22px; }
  .leaf.l2 { left: 11px; bottom: 14px; height: 30px; }
  .leaf.l3 { left: 19px; bottom: 14px; height: 18px; }

  /* ---- the Docket cabinet ------------------------------------------------------------- */
  .cabinet-slot { display: flex; align-items: flex-end; }
  .cabinet {
    background: none; border: none; padding: 0 2px; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
  }
  .cabinet:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .px-cab-art { width: 40px; height: auto; display: block; shape-rendering: crispEdges; }
  .cabinet:hover .px-cab-art { transform: translateY(-2px); }
  .cab-plate { display: flex; flex-direction: column; align-items: center; gap: 1px; }
  .cab-name { font-family: 'Fredoka', sans-serif; font-size: 9.5px; font-weight: 700; color: var(--text); letter-spacing: .04em; }
  .cab-count {
    font-family: 'Fredoka', sans-serif; font-size: 9.5px; font-weight: 700;
    background: var(--accent-bg); color: var(--accent); padding: 1px 7px; border-radius: 999px;
  }
  .cab-count[data-empty="true"] { background: var(--input-bg); color: var(--muted2); }
  /* Real events only: app.ts sets data-busy from assignment.created / .started / .completed,
     never on a timer, and clears it when the animation is done. */
  .cabinet[data-busy] .px-drawer-0 { animation: px-drawer .8s ease-in-out 1; }
  .cabinet[data-busy="1"] .px-drawer-0 { animation: none; }
  .cabinet[data-busy="1"] .px-drawer-1 { animation: px-drawer .8s ease-in-out 1; }
  .cabinet[data-busy="2"] .px-drawer-0 { animation: none; }
  .cabinet[data-busy="2"] .px-drawer-2 { animation: px-drawer .8s ease-in-out 1; }
  @keyframes px-drawer {
    0% { transform: translateX(0); }
    30% { transform: translateX(3px); }
    60% { transform: translateX(3px); }
    100% { transform: translateX(0); }
  }

  /* ---- the floor ---------------------------------------------------------------------- */
  /* One row, not two: the lead desk used to sit on a second row that fell below the fold,
     which meant the primary call to action was the one thing you could not see. */
  .floor {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 18px 8px;
    background: repeating-linear-gradient(90deg, var(--px-floor) 0 30px, var(--px-floor-2) 30px 33px);
    display: grid; gap: 8px 20px; align-content: start;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas: "workers lead review";
  }
  .zone-workers { grid-area: workers; }
  .zone-lead    { grid-area: lead; }
  .zone-review  { grid-area: review; }
  @media (max-width: 900px) {
    .floor { grid-template-columns: minmax(0, 1fr); grid-template-areas: "lead" "workers" "review"; }
    .zone-review { border-left: none; padding-left: 0; border-top: 3px dashed var(--px-rug); padding-top: 8px; }
  }

  .zone { min-width: 0; }
  .zone-h {
    font-size: 9.5px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700;
    color: #a5855c; margin-bottom: 4px;
  }
  .zone-review { border-left: 3px dashed var(--px-rug); padding-left: 18px; }
  .zone-review .seats { justify-content: flex-end; }
  /* The lead desk is bigger, stands on a rug, and sits a few pixels forward of the rest of
     the room — three signals, so it reads as the lead's desk without a label. */
  .zone-lead {
    padding: 0 14px; align-self: end;
    background: radial-gradient(130px 46px at 50% 98%, var(--px-rug) 0 99%, transparent 100%);
  }
  .zone-lead .seats { transform: translateY(5px); }
  .zone-lead .zone-h { color: var(--due-text); opacity: 1; }
  .seats { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 14px; }
  .zone-lead .seats { justify-content: center; }

  /* ---- one desk ----------------------------------------------------------------------- */
  .seat {
    position: relative; width: 78px; padding-top: 30px;
    --px-shirt: #6f97c4;
  }
  .zone-lead .seat { width: 108px; padding-top: 34px; }
  .seat[data-role="manager"] { --px-shirt: var(--lavender); }
  .seat[data-role="reviewer"] { --px-shirt: var(--sage); }
  .seat[data-hair="0"] { --px-hair: #3a2a1c; }
  .seat[data-hair="1"] { --px-hair: #7a4a26; }
  .seat[data-hair="2"] { --px-hair: #9aa0a8; }
  .seat[data-hair="3"] { --px-hair: #c9762f; }
  .seat[data-hair="4"] { --px-hair: #23303f; }
  .seat[data-runtime="claude"]   { --px-rt: #f5a623; }
  .seat[data-runtime="codex"]    { --px-rt: #c79ee8; }
  .seat[data-runtime="opencode"] { --px-rt: #7fc492; }

  .desk-btn {
    background: none; border: none; padding: 0; width: 100%; cursor: pointer; display: block;
    color: inherit; text-align: center;
  }
  .desk-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
  .desk-btn:disabled { cursor: not-allowed; opacity: .5; }
  .px-seat-art {
    width: 100%; height: auto; display: block; shape-rendering: crispEdges;
    filter: drop-shadow(0 3px 0 var(--px-shadow));
  }
  .desk-btn:hover:not(:disabled) .px-seat-art { transform: translateY(-2px); }

  .plate { display: block; margin-top: 3px; }
  .plate-name {
    display: block; font-family: 'Fredoka', sans-serif; font-size: 10.5px; font-weight: 700;
    color: var(--text); line-height: 1.15; word-break: break-word;
    text-shadow: 0 1px 0 var(--px-shadow);
  }
  .plate-meta { display: flex; justify-content: center; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
  .plate-st {
    font-family: 'Fredoka', sans-serif; font-size: 8.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .05em; padding: 1px 6px; border-radius: 999px;
    background: var(--input-bg); color: var(--muted2);
  }
  .seat[data-status="working"] .plate-st { background: var(--accent-bg); color: var(--accent); }
  .seat[data-status="idle"] .plate-st { background: var(--sage-bg); color: var(--sage); }
  .seat[data-status="starting"] .plate-st { background: var(--lavender-bg); color: var(--lavender); }
  .seat[data-status="failed"] .plate-st { background: var(--overdue-bg); color: var(--overdue-text); }
  .plate-rt { font-size: 8.5px; color: #b99a72; font-weight: 600; }
  html[data-theme="light"] .plate-rt { color: #6d4f2f; }

  /* ---- thought bubbles ---------------------------------------------------------------- */
  .bubble {
    position: absolute; left: -12px; right: -12px; top: 0; z-index: 3;
    background: var(--px-bubble-bg); color: var(--px-bubble-ink);
    border: 2px solid var(--px-bubble-line);
    box-shadow: 3px 3px 0 var(--px-shadow);
    padding: 4px 6px 5px; font-size: 9.5px; line-height: 1.3;
  }
  .bubble[hidden] { display: none; }
  .bubble::after, .bubble::before {
    content: ""; position: absolute; background: var(--px-bubble-bg);
    border: 2px solid var(--px-bubble-line); border-top: none;
  }
  .bubble::before { width: 8px; height: 6px; bottom: -8px; left: 16px; }
  .bubble::after  { width: 4px; height: 4px; bottom: -14px; left: 12px; }
  .bubble-text {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .seat[data-status="working"] .bubble { animation: px-bubble-in .22s steps(3, end) 1; }
  @keyframes px-bubble-in { from { transform: translateY(4px); opacity: 0; } to { transform: none; opacity: 1; } }

  /* ---- state to animation. One pose and one screen per AgentStatus, nothing else. ------ */
  .px-arms, .px-head, .px-person, .px-plus, .px-screen, .px-alert { transform-origin: center; }

  .seat[data-pose="typing"] .px-arms { animation: px-type .26s steps(1, end) infinite; }
  .seat[data-pose="typing"] .px-head { animation: px-nod 3.1s steps(1, end) infinite; }
  @keyframes px-type { 0%, 49% { transform: translateY(0); } 50%, 100% { transform: translateY(.7px); } }
  @keyframes px-nod { 0%, 88% { transform: translateY(0); } 92%, 100% { transform: translateY(.6px); } }

  .seat[data-pose="breathing"] .px-person { animation: px-breathe 4s ease-in-out infinite; }
  .seat[data-pose="breathing"] .px-arms { transform: translateY(-1.2px); }
  @keyframes px-breathe { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(.6px); } }

  .seat[data-pose="arriving"] .px-person,
  .seat[data-pose="arriving"] .px-arms { animation: px-walk-in 1.1s steps(5, end) 1 both; }
  @keyframes px-walk-in {
    0%   { transform: translate(-13px, 1px); opacity: 0; }
    40%  { opacity: 1; }
    100% { transform: translate(0, 0); opacity: 1; }
  }

  .seat[data-pose="slumped"] .px-person { transform: translate(1px, 1.6px); }
  .seat[data-pose="slumped"] .px-head { transform: translate(1.4px, 1.2px); }
  .seat[data-pose="slumped"] .px-arms { transform: translateY(1.4px); }

  .px-screen { fill: var(--px-screen-dim); }
  .seat[data-screen="flicker"] .px-screen { fill: var(--px-screen-on); animation: px-flicker 1.7s steps(1, end) infinite; }
  @keyframes px-flicker {
    0%, 70% { opacity: 1; } 73% { opacity: .7; } 76% { opacity: 1; }
    88% { opacity: .82; } 91%, 100% { opacity: 1; }
  }
  .seat[data-screen="boot"] .px-screen { fill: var(--px-screen-boot); animation: px-boot 1s steps(1, end) infinite; }
  @keyframes px-boot { 0%, 49% { opacity: .35; } 50%, 100% { opacity: 1; } }
  .seat[data-screen="dim"] .px-screen { fill: var(--px-screen-dim); opacity: .85; }
  .seat[data-screen="alert"] .px-screen { fill: var(--px-screen-alert); }
  .seat[data-screen="off"] .px-screen { fill: var(--px-screen-off); }
  .px-alert { display: none; }
  .seat[data-screen="alert"] .px-alert { display: block; animation: px-blink 1.05s steps(1, end) infinite; }
  @keyframes px-blink { 0%, 54% { opacity: 1; } 55%, 100% { opacity: .15; } }

  .seat[data-status="stopped"] { opacity: .72; }
  .seat[data-status="failed"] .plate-name { color: var(--overdue-text); }

  /* ---- a free desk: where you click to put somebody in it ----------------------------- */
  .seat-free .px-seat-art { opacity: .68; filter: none; }
  .seat-free .desk-btn:hover .px-seat-art,
  .seat-free .desk-btn:focus-visible .px-seat-art { opacity: 1; }
  .seat-free .plate-name { color: var(--due-text); }
  .seat-free .plate-st { background: transparent; color: #a5855c; box-shadow: 0 0 0 1px currentColor inset; }
  html[data-theme="light"] .seat-free .plate-st { color: #8a6c47; }
  .px-plus { animation: px-beckon 2.6s ease-in-out infinite; }
  @keyframes px-beckon { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }
  .seat-free .desk-btn:hover .px-plus { animation: none; opacity: 1; }

  .floor-sign {
    margin: 0; padding: 10px 16px; text-align: center; font-size: 12.5px; line-height: 1.5;
    color: var(--text); background: var(--px-rug); border-top: 2px solid var(--px-baseboard);
  }
  .floor-sign[hidden] { display: none; }

  /* ---- plain view --------------------------------------------------------------------- */
  .plain {
    background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px;
    padding: 14px 16px; box-shadow: var(--card-shadow);
    flex: 0 0 auto; max-height: 42vh; overflow-y: auto;
    width: 100%; max-width: 900px; align-self: center;
  }
  .plain[hidden] { display: none; }
  .plain > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--meta); }
  .plain-note { margin: 4px 0 12px; font-size: 12px; color: var(--muted2); }
  .board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 720px) { .board { grid-template-columns: minmax(0, 1fr); } }
  .col { min-width: 0; }
  .col-head {
    font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--meta);
    margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
  }
  .col-head .n {
    background: var(--input-bg); color: var(--muted2); border-radius: 999px; padding: 0 7px;
    font-size: 10px; font-weight: 700;
  }
  .col-body { display: flex; flex-direction: column; gap: 10px; }
  .ag {
    border-radius: 14px; padding: 11px 13px; display: flex; flex-direction: column; gap: 5px;
    background: var(--input-bg); border: 1px solid var(--card-border);
  }
  .ag:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ag.observed { background: transparent; border: 1.5px dashed var(--card-empty-border); opacity: .82; }
  .ag[data-status="working"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .ag[data-status="failed"] { border-color: var(--danger); }
  .ag-head { display: flex; align-items: center; gap: 8px; }
  .ag-name { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 13.5px; flex: 1; min-width: 0; word-break: break-word; }
  .ag-task { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text); word-break: break-word; }
  .ag-meta { font-size: 11px; color: var(--muted2); word-break: break-word; }
  .ag-meta .k { color: var(--faint); margin-right: 6px; }
  .ag-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
  .ag-elapsed { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; margin-left: auto; }
  .ag-actions { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
  .ag-observed-note { margin: 6px 0 0; font-size: 10.5px; line-height: 1.4; color: var(--muted2); font-style: italic; }

  .pill {
    font-family: 'Fredoka', sans-serif; font-size: 10px; font-weight: 700; padding: 2px 9px;
    border-radius: 999px; background: var(--input-bg); color: var(--muted2); white-space: nowrap;
    box-shadow: 0 0 0 1px var(--input-border) inset;
  }
  .st-working { background: var(--accent-bg); color: var(--accent); box-shadow: none; }
  .st-idle { background: var(--sage-bg); color: var(--sage); box-shadow: none; }
  .st-starting { background: var(--lavender-bg); color: var(--lavender); box-shadow: none; }
  .st-failed { background: var(--overdue-bg); color: var(--overdue-text); box-shadow: none; }
  .st-stopped { background: var(--input-bg); color: var(--faint); }
  .as-running, .as-review { background: var(--accent-bg); color: var(--accent); box-shadow: none; }
  .as-done { background: var(--sage-bg); color: var(--sage); box-shadow: none; }
  .as-failed, .as-cancelled { background: var(--overdue-bg); color: var(--overdue-text); box-shadow: none; }

  .tag {
    font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    padding: 2px 8px; border-radius: 999px;
  }
  .tag-managed { background: var(--sage-bg); color: var(--sage); }
  .tag-observed { background: transparent; color: var(--muted2); border: 1px dashed var(--card-empty-border); }
  .tag-manager { background: var(--lavender-bg); color: var(--lavender); }

  .cold { padding: 6px 2px; }
  .cold h2 { font-size: 15px; margin-bottom: 6px; }
  .cold p { font-size: 13px; color: var(--muted); margin: 0 0 12px; line-height: 1.5; }
  .cold-roster { display: flex; flex-direction: column; gap: 8px; }
  .cold[hidden] { display: none; }

  /* ---- profiles ---------------------------------------------------------------------- */
  .pf-row {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px;
    background: var(--input-bg); box-shadow: 0 0 0 1px var(--card-border); margin-bottom: 8px;
  }
  .pf-text { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .pf-name { font-family: 'Fredoka', sans-serif; font-weight: 600; font-size: 13px; }
  .pf-role { font-size: 10.5px; color: var(--muted2); text-transform: uppercase; letter-spacing: .05em; }
  .pf-spec { flex-basis: 100%; font-size: 11px; color: var(--faint); word-break: break-word; }

  /* ---- assignments ------------------------------------------------------------------- */
  table.asg { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.asg th {
    text-align: left; font-family: 'Fredoka', sans-serif; font-size: 10px; text-transform: uppercase;
    letter-spacing: .05em; color: var(--meta); font-weight: 600; padding: 0 8px 6px 0;
  }
  table.asg td { padding: 6px 8px 6px 0; border-top: 1px solid var(--card-border); vertical-align: top; word-break: break-word; }
  table.asg td.mono { color: var(--faint); white-space: nowrap; }
  .asg-docket { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--lavender); background: var(--lavender-bg); padding: 1px 7px; border-radius: 999px; }
  .asg-wrap { overflow-x: auto; }
  .assign-form { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--card-border); }
  .assign-form .full { grid-column: 1 / -1; }
  .assign-form .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .check { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted2); white-space: nowrap; cursor: pointer; }
  .check input { width: auto; accent-color: var(--sage); }
  #assign-hint { font-size: 11px; color: var(--muted2); }
  #assign-hint[hidden] { display: none; }
  .form-note { margin: 2px 0 0; font-size: 10.5px; line-height: 1.45; color: var(--faint); }

  /* ---- dialogs ----------------------------------------------------------------------- */
  dialog.agent-panel, dialog.sheet {
    max-width: 640px; width: calc(100% - 40px); max-height: 84vh; overflow-y: auto; margin: auto;
    background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text);
    border-radius: 18px; padding: 18px 20px; box-shadow: var(--card-shadow);
  }
  dialog::backdrop { background: rgba(10,7,4,.6); }
  .panel-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .rename-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .rename-row[hidden] { display: none; }
  .rename-row input { flex: 1; min-width: 0; }
  /* "You → backend": the conversation says who a direct message went to. */
  .cm-to {
    font-size: 11px; font-weight: 600; color: var(--lavender);
    background: var(--lavender-bg); padding: 1px 8px; border-radius: 999px;
  }
  .panel-head h2 { font-size: 17px; flex: 1; min-width: 0; word-break: break-word; }
  .sheet-note { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
  .panel-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .panel-task { font-size: 12.5px; color: var(--muted); margin-bottom: 10px; word-break: break-word; }
  .panel-task .k { color: var(--faint); text-transform: uppercase; font-size: 10px; letter-spacing: .05em; }
  .out {
    background: var(--bg); border-radius: 12px; padding: 10px 12px; max-height: 34vh; overflow-y: auto;
    font-size: 12px; display: flex; flex-direction: column; gap: 3px;
    box-shadow: 0 0 0 1px var(--card-border) inset;
  }
  .out-row { display: flex; gap: 8px; align-items: baseline; }
  .out-time { color: var(--faint); font-variant-numeric: tabular-nums; font-size: 10.5px; flex-shrink: 0; }
  .out-text { color: var(--muted); word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.5; }
  .panel-controls { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .panel-controls[hidden], .panel-readonly[hidden] { display: none; }
  .panel-controls .row { display: flex; gap: 8px; align-items: center; }
  .panel-readonly {
    margin-top: 12px; font-size: 12px; line-height: 1.5; color: var(--muted2);
    border: 1.5px dashed var(--card-empty-border); border-radius: 12px; padding: 10px 13px;
  }

  /* ---- toast ------------------------------------------------------------------------- */
  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--card-bg); border: 1px solid var(--card-border); color: var(--text);
    border-radius: 999px; padding: 10px 20px; font-size: 12.5px; font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,.35); opacity: 0; pointer-events: none;
    transition: opacity .15s ease; max-width: min(90vw, 560px); text-align: center; z-index: 20;
  }
  #toast[data-show="true"] { opacity: 1; }

  /* ---- when nothing should be moving --------------------------------------------------
     A hidden tab and a user who asked for stillness are the two cases where an office full
     of looping keyframes is pure waste. Both stop everything, including the connection blip. */
  body[data-idle="true"] .stage *,
  body[data-idle="true"] .turns *,
  body[data-idle="true"] .conn::before { animation-play-state: paused; }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
    ul.feed { scroll-behavior: auto; }
    .seat[data-screen="flicker"] .px-screen { opacity: 1; }
    .px-plus { opacity: 1; }
    /* The dots stop moving, so they have to stop being a signal on their own: the row still
       says "working" in words and still counts the seconds. Full opacity so they read as a
       mark rather than as three things that failed to load. */
    .tw-dots i { opacity: 1; }
  }
`;
