import { View, div, svg } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, nextCommand, notify, shared, setShared } from "herdr";
import { DEFAULT_COUNT, directoryKey, projectSessions, initialCount, age, sessionTab } from "./model.js";
import { LocalAdapter } from "./bridge.js";
import { ProjectViews } from "./projects.js";

function location() {
  const space = spaces().find(s => s.active), tab = space?.tabs?.find(t => t.active), f = focused();
  const pane = panes().find(p => p.tab === tab?.id && p.focused && p.cwd)
    ?? panes().find(p => p.tab === tab?.id && p.cwd);
  const cwd = f?.tab === tab?.id ? f?.cwd ?? pane?.cwd : pane?.cwd;
  const on = f?.tab === tab?.id && f?.terminal?.includes("/") ? f.terminal.split("/")[0] : space?.machine ?? null;
  return { cwd, on, space: space?.id, key: JSON.stringify([space?.id, on, cwd]) };
}

export default class OpenCodeSessions extends View {
  init(_props, cx) {
    this.views = new ProjectViews(); this.adapter = new LocalAdapter();
    this.context = null; this.inflight = new Map(); this.failures = new Map();
    this.revision = 0; this.lastRevisionCheck = 0; this.checkingRevision = false;
    this.handle = cx.focus_handle();
    // In-memory navigation checks only; no subprocess or network work in render.
    cx.timer.every(150, cx => this.tick(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
      }
    });
  }

  get allProjects() { return shared("opencode-panel.allProjects") === true; }

  location() {
    const context = location();
    return { ...context, allProjects: this.allProjects,
      key: JSON.stringify(this.allProjects ? [context.on, true] : [context.key, false]) };
  }

  toggleProjects(cx) {
    setShared("opencode-panel.allProjects", !this.allProjects);
    this.refresh(cx, false, false);
    cx.notify();
  }

  tick(cx) {
    const context = this.location();
    const changed = context.key !== this.context?.key;
    this.context = context;
    if (!context.cwd) return;
    const view = this.views.exact(context), failure = this.failures.get(context.key);
    if ((!failure || Date.now() - failure.checked >= 5000)
      && ((!view && changed) || !view || Date.now() - view.checked >= 30000)) this.refresh(cx, false, false);
    if (!context.on && !this.checkingRevision && Date.now() - this.lastRevisionCheck >= 2000) {
      this.checkingRevision = true; this.lastRevisionCheck = Date.now();
      cx.spawn(async cx => {
        try {
          const result = await this.adapter.revision();
          if (result.revision !== this.revision) {
            this.revision = result.revision;
            if (this.location().key === context.key) this.refresh(cx, false, false);
          }
        } catch { /* snapshots own actionable errors; do not blank a cached list */ }
        finally { this.checkingRevision = false; }
      });
    }
  }

  refresh(cx, more = false, force = true) {
    const context = this.location();
    if (!context.cwd) return;
    this.context = context;
    const view = this.views.get(context), wanted = Math.min(1000, DEFAULT_COUNT + (view?.extra ?? 0));
    const requestKey = JSON.stringify([context.on, context.allProjects ? null : context.cwd, wanted, context.allProjects]);
    if (this.inflight.has(requestKey)) return;
    this.inflight.set(requestKey, { context: context.key, force });
    this.failures.delete(context.key);
    let shouldNotify = force || !view;
    cx.spawn(async cx => {
      try {
        const snapshot = context.on ? await this.remoteSnapshot(context, wanted, force)
          : await this.adapter.snapshot(context.cwd, wanted, force, context.allProjects);
        const update = this.views.update(context, snapshot);
        shouldNotify = shouldNotify || update.changed;
        if (!context.on) this.revision = snapshot.revision;
      } catch (error) {
        this.failures.set(context.key, { error: String(error), checked: Date.now() });
        shouldNotify = true;
      } finally {
        this.inflight.delete(requestKey);
        // Cache late responses for later visits, but never bind them to a
        // different currently selected project/space.
        if (shouldNotify && this.location().key === context.key) cx.notify();
      }
    });
    if (force || !view) cx.notify();
  }

  async remoteSnapshot(context, wanted, force) {
    // Preserve the existing remote-space feature until a bridge is installed
    // there. Never send remote filesystem paths to the local API service.
    const options = { cwd: context.cwd, on: context.on };
    if (context.allProjects) {
      const rows = []; let cursor = null;
      do {
        const query = `parentID=null&archived=false&order=desc&limit=${Math.min(100, wanted - rows.length)}`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const result = await exec("opencode", ["api", "get", `/api/session?${query}`], options);
        if (result.code !== 0) throw new Error("Remote OpenCode could not list all sessions.");
        const page = JSON.parse(result.stdout);
        rows.push(...page.data);
        if (page.cursor.next && page.cursor.next === cursor) throw new Error("Remote OpenCode repeated a pagination cursor.");
        cursor = page.cursor.next;
      } while (cursor && rows.length < wanted);
      return { projectID: null, root: null, sessions: projectSessions(rows.map(s => ({
        id: s.id, title: s.title, directory: s.location.directory, updated: s.time.updated, created: s.time.created,
      }))), hasMore: Boolean(cursor), loading: false, error: null, capped: wanted >= 1000 };
    }
    const git = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], options);
    const roots = git.code === 0 ? git.stdout.trim().split("\n") : [context.cwd, context.cwd];
    const cached = this.views.entries.get(this.views.key(context, roots[0]));
    if (!force && cached && Date.now() - cached.checked < 30000 && (cached.sessions.length >= wanted || !cached.hasMore)) {
      return { projectID: roots[0], root: roots[1], sessions: cached.sessions, hasMore: cached.hasMore, loading: false, error: null };
    }
    const limit = Math.min(1000, Math.max(30, wanted));
    const result = await exec("opencode", ["session", "list", "--format", "json", "--max-count", String(limit)], options);
    if (result.code !== 0) throw new Error("Remote OpenCode could not list sessions.");
    const rows = JSON.parse(result.stdout);
    return { projectID: roots[0], root: roots[1], sessions: projectSessions(rows), hasMore: rows.length >= limit, loading: false, error: null, capped: limit >= 1000 };
  }

  open(session) {
    const context = this.location(), view = this.views.get(context);
    if (!view?.sessions.some(s => s.id === session.id)) return;
    try { run("tab.new", sessionTab(session, context.space)); }
    catch (error) { notify({ title: "Cannot open session", body: String(error), level: "error" }); }
  }

  newSession() {
    const context = location();
    if (!context.cwd || !context.space) return;
    try { run("tab.new", { space: context.space, folder: context.cwd, name: "OpenCode", argv: ["opencode"] }); }
    catch (error) { notify({ title: "Cannot start session", body: String(error), level: "error" }); }
  }

  more(cx) {
    const view = this.views.get(this.location());
    if (!view || view.loading) return;
    view.extra = Math.min(990, view.extra + 20);
    if (DEFAULT_COUNT + view.extra > view.sessions.length && view.hasMore) this.refresh(cx, true, false);
    else cx.notify();
  }

  placeholderRows(t) {
    return Array.from({ length: DEFAULT_COUNT }, (_, i) => v_flex().id(`session-placeholder-${i}`).w_full().min_h(64).flex_none().px(8).py(12).gap(8)
      .child(div().w(168 + (i % 3) * 20).h(12).rounded(3).bg(t.raised))
      .child(div().w(64 + (i % 2) * 32).h(10).rounded(3).bg(t.raised)));
  }

  render(cx) {
    const context = this.location();
    const t = theme(), now = Date.now();
    const view = context.cwd ? this.views.get(context) : null;
    const pending = Boolean(context.cwd && ((!view && !this.failures.has(context.key)) || view?.loading
      || [...this.inflight.values()].some(task => task.context === context.key && task.force)));
    const sessions = view?.sessions ?? [];
    const count = Math.min(sessions.length, initialCount(sessions) + (view?.extra ?? 0));
    const shown = sessions.slice(0, count), canMore = view && (count < sessions.length || view.hasMore) && count < 1000;
    const placeholder = pending && !view;
    const error = this.failures.get(context.key)?.error ?? view?.error;
    const scopeLabel = this.allProjects ? "Showing all projects" : context.cwd ?? "No terminal directory";
    const control = (id, label, action, disabled = false, icon = null, iconOnly = false) => Button.new(id).h(32).px(8).rounded(6)
      .flex().items_center().gap(4).flex_none().when(iconOnly, el => el.w(32).justify_center())
      .text_size(12).text_color(disabled ? t.dim : t.muted).disabled(disabled).accessibility_label(label).tooltip(label)
      .hover(s => s.bg(t.hover)).focus(s => s.bg(t.selected)).active(s => s.bg(t.selected)).on_click(action)
      .when(Boolean(icon), el => el.child(svg(`mods/opencode-panel/${icon}.svg`).size(14)))
      .when(!iconOnly, el => el.child(label));
    return v_flex().id("opencode-sessions").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("icons/opencode.svg").size(16))
        .child(div().font_semibold().child("OpenCode"))
        .child(div().flex_1())
        .child(control("sessions-refresh", pending ? "Loading sessions…" : "Refresh sessions", (_e, cx) => this.refresh(cx), pending || !context.cwd, "refresh", true))
        .child(control("sessions-new", "New session", () => this.newSession(), !context.cwd, "plus")))
      .child(v_flex().flex_none().px(12).py(8).gap(4).border_b(1).border_color(t.border)
        .child(div().id("sessions-scope").truncate().text_size(12).text_color(t.muted).tooltip(scopeLabel).child(scopeLabel))
        .child(h_flex().items_center().justify_between().gap(8)
          .child(div().text_size(11).text_color(t.dim).child(this.allProjects ? "All sessions · newest 10" : "Project sessions · newest 10"))
           .child(control("sessions-all-projects", this.allProjects ? "Show current project" : "Show all projects", (_e, cx) => this.toggleProjects(cx))
            .selected(this.allProjects).when(this.allProjects, el => el.bg(t.selected).text_color(t.foreground)))))
      .child(v_flex().id(`opencode-session-list-${view?.key ?? "loading"}`).flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(4)
        .when(Boolean(error), el => el.child(div().p(8).text_size(12).text_color(t.ansi1).child(error)))
        .when(placeholder, el => el.child(v_flex().id("sessions-loading").w_full().gap(4).accessibility_label("Loading OpenCode sessions")
          .children(this.placeholderRows(t))))
        .when(!shown.length && !placeholder, el => el.child(div().p(8).text_size(12).text_color(t.dim)
           .child(!context.cwd ? "Select a terminal to see its sessions." : error ? "Use Refresh to try again." : this.allProjects ? "No sessions found." : "No sessions in this project.")))
        .children(shown.map(session => Button.new(`session-${session.id}`).w_full().min_h(64).px(8).py(8).rounded(6)
          .text_color(t.foreground).hover(s => s.bg(t.hover)).focus(s => s.bg(t.selected)).active(s => s.bg(t.selected)).accessibility_label(`Resume ${session.title}`)
          .tooltip(`${session.title}\n${session.directory}\n${session.id}\nUpdated ${new Date(session.updated).toLocaleString()}`)
          .on_click(() => this.open(session))
          .child(v_flex().w_full().min_w(0).gap(4)
            .child(div().w_full().truncate().text_size(13).child(session.title))
            .child(h_flex().gap(8).text_size(11).text_color(t.dim)
              .child(div().child(age(session.updated, now)))
              .child(div().flex_1()).child(div().child("↗")))
            .when(directoryKey(session.directory) !== directoryKey(context.cwd), el => el.child(
              div().w_full().truncate().text_size(11).text_color(t.dim).child(session.directory))))))
        .when(canMore && !placeholder && !error, el => el.child(control("sessions-more", pending ? "Loading…" : "Show more", (_e, cx) => this.more(cx), pending)))
        .when(view?.capped && shown.length >= 1000, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("Showing the newest 1,000 sessions."))))
      .child(div().flex_none().px(12).py(8).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(placeholder ? "Loading sessions…" : !context.cwd ? "No terminal selected" : `${shown.length}${view && !view.hasMore ? ` of ${sessions.length}` : "+"} sessions · opens in a new tab`));
  }
}
