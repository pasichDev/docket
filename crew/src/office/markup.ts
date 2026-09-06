/*
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the Office page's
 * body — the static shell only. Every region that changes is an empty container that
 * client/app.ts fills from render.ts; nothing here is ever built from daemon data, which is
 * why nothing here needs escaping.
 *
 * Same two hazards as Docket Core's markup.ts: a literal backtick ends the string, and
 * a dollar-brace interpolates. office.server.test.ts fails if either slips in.
 *
 * Shape of the page, top to bottom:
 *
 *   header            — workspace, connection, ONE manager action, view + theme toggles
 *   .panes            — the conversation and the office. The chat takes every pixel the office
 *                       does not; the office is a dock on the right above ~1180px and a band
 *                       under the chat below that. There is no empty counterweight column: a
 *                       layout centred by parking a void beside it reads as broken, however
 *                       well the midpoint measures.
 *   .chat             — the conversation, and the whole surface. The pane is edge to edge; the
 *                       reading column inside it (.chat-col / .ask-col) is what is capped and
 *                       centred, so the whitespace belongs to the chat rather than to the page.
 *   .stage            — the illustrated office: back wall (Docket cabinet, window, door)
 *                       over a single row of desks. Collapsible, because the chat is what the
 *                       user reads all day.
 *   #plain            — the same information as a plain list, for anyone who wants it
 *   dialogs           — agent detail, the Docket cabinet's task list, the hiring roster
 *
 * The scene and the plain view are two renderings of one board. Whichever is showing carries
 * the same controls with the same data-act hooks, so nothing is reachable in only one of them.
 */
export const OFFICE_MARKUP = `
  <header>
    <h1>Docket Crew</h1>
    <span class="ws" id="workspace" aria-label="Workspace">—</span>
    <span class="conn" id="conn" role="status" aria-live="polite" data-state="connecting">connecting…</span>
    <span class="spacer"></span>
    <!--
      ONE manager control, not three. Which action it offers is the manager's state — start it,
      pause it, or resume it — so there is never a pair of competing primary buttons next to a
      badge repeating what one of them already says. app.ts owns data-act; the handlers behind
      "start-manager" and "pause" are unchanged.
    -->
    <button type="button" class="btn btn-primary" id="manager-action" data-act="start-manager">Start manager</button>
    <button type="button" class="btn" id="view-toggle" data-act="view" aria-pressed="false">Plain view</button>
    <button type="button" class="btn" data-act="theme" aria-label="Toggle light and dark theme">Theme</button>
  </header>

  <div id="notice" role="alert" hidden></div>

  <div class="panes" id="panes">
    <section class="chat" aria-labelledby="chat-h">
      <div class="chat-bar">
        <h2 id="chat-h" class="chat-h">Team</h2>
        <span class="spacer"></span>
        <button type="button" class="btn btn-ghost" id="log-toggle" data-act="log" aria-pressed="false">Raw log</button>
        <button type="button" class="btn btn-ghost" id="office-toggle" data-act="office" aria-pressed="true">Hide office</button>
      </div>

      <!--
        The scroller spans the whole pane so the conversation has no visible edge to float in;
        the reading column inside it is what is capped and centred. That is the difference
        between "a chat" and "a block parked in the middle of the page".
      -->
      <div class="chat-scroll" id="chat-scroll">
        <div class="chat-col">
          <ol class="chat-list" id="chat" aria-live="polite" aria-label="Team conversation"></ol>
          <ul class="feed" id="feed" aria-live="off" aria-label="Raw event log" hidden></ul>
          <!--
            The live turn indicator: who is working right now, straight after the last thing
            said, because that is where the reader's eye already is. It is drawn from
            CrewAgent.status and the agent.started/output/idle/failed/stopped events (see
            turnIndicators in render.ts) — never from a timer — so it cannot outlive the turn.
            aria-hidden because the announcement is the sr-only status line below it: the
            visible row changes on every streamed line and would flood a live region.
          -->
          <div class="turns" id="turns" aria-hidden="true" hidden></div>
          <p class="sr-only" id="turns-live" role="status" aria-live="polite"></p>
        </div>
      </div>

      <button type="button" class="jump" id="jump" data-act="jump" hidden>Jump to latest</button>

      <!--
        One solid element, not a form. The recipient strip lives INSIDE the composer's shell
        so "who am I talking to" is part of the thing you are typing in, and data-direct on
        the wrapper repaints the whole composer when the target is not the manager — going
        round the manager is a deliberate act and has to look like one before you send.
      -->
      <div class="ask" id="ask-wrap" data-direct="false">
        <div class="ask-col">
          <div class="ask-shell">
            <div class="ask-to">
              <label class="ask-to-l" for="ask-target">To</label>
              <select id="ask-target" aria-describedby="ask-direct"></select>
              <span class="ask-direct" id="ask-direct" hidden>straight to this agent — the manager is not involved</span>
            </div>
            <div class="ask-row">
              <label class="sr-only" for="ask">Tell the team what to do</label>
              <textarea id="ask" rows="1" placeholder="Message the team…  (@name to address someone directly)"></textarea>
              <button type="button" class="btn btn-primary ask-send" id="ask-send" data-act="ask">Send</button>
            </div>
          </div>
          <span class="ask-hint">Enter to send · Shift+Enter for a new line</span>
        </div>
      </div>
    </section>

    <section class="stage" id="stage" aria-labelledby="stage-h">
      <h2 id="stage-h" class="sr-only">The office floor</h2>

      <div class="wall">
        <div class="wall-slot wall-left">
          <div id="cabinet-slot" class="cabinet-slot"></div>
        </div>

        <div class="wall-slot wall-window">
          <div class="window">
            <div class="glass">
              <ul class="ghosts" id="ghosts" aria-label="Observed Docket sessions, outside the office"></ul>
            </div>
            <div class="mullion-v" aria-hidden="true"></div>
            <div class="mullion-h" aria-hidden="true"></div>
          </div>
          <p class="window-note" id="ghosts-empty">Nobody outside. Docket sessions Crew didn't launch show up here.</p>
          <p class="window-note" id="ghosts-note" hidden>Crew didn't launch these — visible only, no controls.</p>
        </div>

        <div class="wall-slot wall-door" aria-hidden="true">
          <div class="door"><span class="knob"></span></div>
          <div class="plant"><span class="pot"></span><span class="leaf l1"></span><span class="leaf l2"></span><span class="leaf l3"></span></div>
        </div>
      </div>

      <div class="floor" id="floor">
        <section class="zone zone-lead" aria-labelledby="z-lead">
          <h3 class="zone-h" id="z-lead">Lead desk</h3>
          <div class="seats" id="seats-lead"></div>
        </section>

        <section class="zone zone-workers" aria-labelledby="z-workers">
          <h3 class="zone-h" id="z-workers">The floor</h3>
          <div class="seats" id="seats-workers"></div>
        </section>

        <section class="zone zone-review" aria-labelledby="z-review">
          <h3 class="zone-h" id="z-review">Review corner</h3>
          <div class="seats" id="seats-review"></div>
        </section>
      </div>

      <p class="floor-sign" id="floor-sign" hidden></p>
    </section>
  </div>

  <section class="plain" id="plain" aria-labelledby="plain-h" hidden>
    <h2 id="plain-h">Plain view</h2>
    <p class="plain-note">The same board without the drawing: every agent, every control.</p>
    <div class="cold" id="cold" hidden></div>
    <div class="board" id="board"></div>
  </section>

  <dialog class="sheet" id="docket-panel" aria-labelledby="docket-h">
    <div class="panel-head">
      <h2 id="docket-h">Docket — the crew's task drawer</h2>
      <button type="button" class="btn" data-act="close-docket" aria-label="Close the Docket task list">Close</button>
    </div>
    <div class="asg-wrap" id="assignments"></div>
    <div class="assign-form">
      <div class="full">
        <div class="field-label" id="assign-title-l">Hand work to one agent</div>
        <input type="text" id="assign-title" placeholder="Title — what should get done" aria-labelledby="assign-title-l" />
      </div>
      <div class="full">
        <textarea id="assign-body" rows="2" placeholder="Instructions (optional — the title is used if this is blank)" aria-label="Assignment instructions"></textarea>
      </div>
      <div>
        <div class="field-label" id="assign-to-l">Assignee</div>
        <select id="assign-to" aria-labelledby="assign-to-l"></select>
      </div>
      <div>
        <div class="field-label" id="assign-docket-l">Docket task (optional)</div>
        <input type="text" id="assign-docket" placeholder="T-ABC123" aria-labelledby="assign-docket-l" />
      </div>
      <div class="full row">
        <button type="button" class="btn btn-solid" id="assign-send" data-act="assign">Assign</button>
        <label class="check"><input type="checkbox" id="assign-isolate" checked /> isolate in a git worktree</label>
        <span id="assign-hint" hidden></span>
      </div>
      <p class="full form-note">Isolating needs a clean git tree — the daemon refuses rather than
      hand a worker a different tree than the one you are looking at. Untick to work in place.</p>
    </div>
  </dialog>

  <dialog class="sheet" id="hire-panel" aria-labelledby="hire-h">
    <div class="panel-head">
      <h2 id="hire-h">Who sits here?</h2>
      <button type="button" class="btn" data-act="close-hire" aria-label="Close the hiring roster">Close</button>
    </div>
    <p class="sheet-note" id="hire-note">Pick a profile. It starts immediately and walks in.</p>
    <div id="profiles"></div>
  </dialog>

  <dialog class="agent-panel" id="agent-panel" aria-labelledby="panel-title">
    <div class="panel-head">
      <h2 id="panel-title"></h2>
      <button type="button" class="btn btn-ghost" id="panel-rename" data-act="rename" hidden>Rename</button>
      <button type="button" class="btn" data-act="close-panel" aria-label="Close agent panel">Close</button>
    </div>
    <form class="rename-row" id="rename-row" hidden>
      <label class="sr-only" for="rename-input">New name for this agent</label>
      <input type="text" id="rename-input" maxlength="60" placeholder="backend, tests, docs…" />
      <button type="button" class="btn btn-solid" data-act="rename-save">Save</button>
      <button type="button" class="btn" data-act="rename-cancel">Cancel</button>
    </form>
    <div class="panel-meta" id="panel-meta"></div>
    <div class="panel-task" id="panel-task"></div>
    <div class="field-label">Visible output</div>
    <div class="out" id="panel-output" aria-live="polite" aria-label="Live agent output"></div>

    <div class="panel-controls" id="panel-controls" hidden>
      <div>
        <label class="field-label" for="panel-message">Message this agent</label>
        <textarea id="panel-message" rows="2" placeholder="Enter to send · Shift+Enter for a new line"></textarea>
      </div>
      <div class="row">
        <button type="button" class="btn btn-solid" data-act="send-message">Send</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger" data-act="cancel">Cancel run</button>
        <button type="button" class="btn danger" data-act="stop">Stop agent</button>
      </div>
    </div>

    <p class="panel-readonly" id="panel-readonly" hidden>
      This is an <strong>observed</strong> Docket session — Crew did not launch it and has no
      handle on its process. Its output is shown because it shares this workspace, but Crew
      cannot prompt, cancel or stop it, so no controls are offered.
    </p>
  </dialog>

  <div id="toast" role="status" aria-live="polite" data-show="false"></div>
`;
