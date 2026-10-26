#!/usr/bin/env python3
"""
Desktop bench: drives the real Rite window in a throwaway X server.

It runs INSIDE the harness container, where the binary, Xvfb and xdotool live. Three
channels observe what happens, and none of them is a screenshot read by eye:

  - the bytes that reach the PTY        (RITE_TRACE_INPUT=1 in the client's own log)
  - the browser events the engine emits (the page agent beacons them)
  - the size the shell actually has     (the winsize of its own tty, read from /proc)

A screenshot is taken as well, because some failures are only visible.
"""
import json, os, queue, re, signal, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9931
OUT = "/out"
RITE = "/workspace/target/release/rite"
LOG = "/tmp/rite.log"
DISPLAY = ":99"

# ── the broker: one command out, one result back, plus the event sink ────────────
_cmds: "queue.Queue[dict]" = queue.Queue()
_results: "dict[str, dict]" = {}
_events: list[str] = []
_hello = threading.Event()


class Broker(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/cmd":
            try:
                cmd = _cmds.get(timeout=0.4)
            except queue.Empty:
                cmd = {}
            return self._send(200, json.dumps(cmd).encode())
        self._send(404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        if self.path == "/res":
            msg = json.loads(body)
            _results[msg["id"]] = msg
        elif self.path == "/ime":
            _events.extend(body.splitlines())
        elif self.path == "/hello":
            _hello.set()
        self._send(204)

    def log_message(self, *a):
        pass

    def handle_one_request(self):
        # The command channel is a long poll: the page gives up on it routinely, and a
        # closed socket is the normal end of a request here, not an error worth a trace.
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


def serve():
    ThreadingHTTPServer(("127.0.0.1", PORT), Broker).serve_forever()


# ── talking to the page ──────────────────────────────────────────────────────────
_seq = 0


def js(expr, timeout=10):
    """Evaluate one expression in the page and return its value."""
    global _seq
    _seq += 1
    ident = f"c{_seq}"
    _cmds.put({"id": ident, "js": expr})
    deadline = time.time() + timeout
    while time.time() < deadline:
        if ident in _results:
            msg = _results.pop(ident)
            if not msg["ok"]:
                raise RuntimeError(f"page error: {msg['value']}")
            return msg["value"]
        time.sleep(0.05)
    raise TimeoutError(f"no answer for {expr[:60]}")


# ── the X server and the window ──────────────────────────────────────────────────
def x(*args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw).stdout.strip()


def window_id():
    """The Rite window, which is the visible one named Rite — not the 1x1 helpers."""
    for _ in range(60):
        for wid in x("xdotool", "search", "--onlyvisible", "--name", "^Rite$").split():
            geo = x("xdotool", "getwindowgeometry", wid)
            m = re.search(r"Geometry: (\d+)x(\d+)", geo)
            if m and int(m.group(1)) > 200:
                return wid
        time.sleep(0.5)
    raise RuntimeError("no Rite window")


def resize(wid, w, h):
    subprocess.run(["xdotool", "windowsize", wid, str(w), str(h)], check=True)
    time.sleep(1.2)


def focus(wid):
    # `windowactivate` needs a window manager to claim _NET_ACTIVE_WINDOW, and this X
    # server has none. `windowfocus` sets the input focus directly, which is all a
    # keystroke needs.
    subprocess.run(["xdotool", "windowraise", wid], check=False)
    subprocess.run(["xdotool", "windowfocus", "--sync", wid], check=False)
    time.sleep(0.3)


def type_text(text, delay=40):
    subprocess.run(["xdotool", "type", "--delay", str(delay), text], check=True)
    time.sleep(0.4)


def press(*keys):
    for k in keys:
        subprocess.run(["xdotool", "key", k], check=True)
        time.sleep(0.15)
    time.sleep(0.4)


def shot(name):
    path = f"{OUT}/{name}.png"
    subprocess.run(["import", "-window", "root", path], check=False)
    return path


# ── the shell's own view of its terminal ─────────────────────────────────────────
def pty_size():
    """rows, cols as the shell's tty reports them — the PTY's truth, not the UI's."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() not in ("fish", "bash", "sh", "zsh"):
                    continue
            with open(f"/proc/{pid}/stat") as f:
                ppid = f.read().split()[3]
            with open(f"/proc/{ppid}/comm") as f:
                if f.read().strip() != "rite":
                    continue
            out = subprocess.run(
                ["stty", "size"], stdin=open(f"/proc/{pid}/fd/0"),
                capture_output=True, text=True,
            ).stdout.split()
            return int(out[0]), int(out[1])
        except Exception:
            continue
    return None


# ── what reached the PTY ─────────────────────────────────────────────────────────
TRACE = re.compile(r"\[trace-input\].*hex=\[([0-9a-f ]*)\]")


def sent_bytes(since=0):
    """Every byte posted to a terminal since `since`, as a flat list."""
    out = []
    with open(LOG, errors="replace") as f:
        for line in f:
            m = TRACE.search(line)
            if m:
                out.append(m.group(1))
    return out[since:]


# ── the report ───────────────────────────────────────────────────────────────────
FAILED = []


def check(name, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + name + (f"   {detail}" if detail else ""))
    if not ok:
        FAILED.append(name)
    return ok


# ── scenarios ────────────────────────────────────────────────────────────────────
def scenario_probe(wid):
    """What the page offers, so a scenario can act on names instead of coordinates."""
    print("\nprobe")
    print("  url      ", js("location.href"))
    print("  title    ", js("document.title"))
    ids = js("Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.dataset.testid)")
    print("  testids  ", ids)
    btns = js(
        "Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim())"
        ".filter(Boolean).slice(0,30)"
    )
    print("  buttons  ", btns)
    print("  shot     ", shot("probe"))
    # The shell picker's own menu, which a scenario about a given shell has to reach.
    if js("(() => { const b = Array.from(document.querySelectorAll('button'))"
          ".find(b => /\\uD83D\\uDC1A/.test(b.textContent));"
          " if (!b) return false; b.click(); return true; })()"):
        time.sleep(0.6)
        print("  shells   ", js(
            "Array.from(document.querySelectorAll('button,[role=menuitem]'))"
            ".map(b=>b.textContent.trim()).filter(Boolean).slice(0,40)"
        ))


def click_text(label):
    """Click the button whose label is exactly `label`. Names survive a redesign; the
    coordinates of a button do not, and a bench that clicks pixels fails on a theme."""
    return js(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        f".find(b => b.textContent.trim() === {label!r});"
        " if (!b) return false; b.click(); return true; })()"
    )


def pick_shell(name):
    """Open the toolbar's shell picker and choose the shell whose entry names `name`.

    The pane the "Terminal" button opens runs the frontend's default shell, so a scenario
    about a particular shell has to ask for it the way a user does.
    """
    opened = js(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        '.find(b => /\\uD83D\\uDC1A/.test(b.textContent));'
        " if (!b) return false; b.click(); return true; })()"
    )
    if not opened:
        return False
    time.sleep(0.6)
    return js(
        "(() => { const b = Array.from(document.querySelectorAll('button,[role=menuitem],li'))"
        f".find(b => b.textContent.toLowerCase().includes({name!r}));"
        " if (!b) return false; b.click(); return true; })()"
    )


def open_terminal():
    """Open a local shell pane and wait for xterm to paint."""
    if not click_text("Terminal"):
        return False
    for _ in range(40):
        if js("!!document.querySelector('.xterm-rows')"):
            time.sleep(1.5)
            return True
        time.sleep(0.5)
    return False


def xterm_geometry():
    """The grid xterm is painting.

    Rows are the row elements. Columns cannot be counted from the text — a row holds only
    the characters actually painted, so an empty line measures zero — so they are derived
    from the geometry: the screen's width over the width of one cell, which xterm measures
    into `.xterm-char-measure-element` as a run of 32 glyphs.
    """
    return js(
        "(() => {"
        " const rows = document.querySelector('.xterm-rows');"
        " const screen = document.querySelector('.xterm-screen');"
        " const measure = document.querySelector('.xterm-char-measure-element');"
        " if (!rows || !screen || !measure) return null;"
        " const cell = measure.getBoundingClientRect().width / (measure.textContent.length || 1);"
        " return { rows: rows.children.length,"
        "   cols: cell > 0 ? Math.floor(screen.getBoundingClientRect().width / cell) : null,"
        "   cell: Math.round(cell * 100) / 100,"
        "   screenWidth: Math.round(screen.getBoundingClientRect().width) }; })()"
    )


def screen_text():
    """What the terminal is painting, line by line."""
    return js(
        "Array.from(document.querySelectorAll('.xterm-rows > div'))"
        ".map(d => d.textContent.replace(/\\u00a0/g,' ').trimEnd())"
    )


def scenario_size(wid):
    """The PTY must learn the pane's real size, at open and after a window resize."""
    print("\nterminal size")
    check("a local terminal opens", open_terminal())
    geo = xterm_geometry()
    pty = pty_size()
    check("the PTY is not left at its placeholder 24x80", pty != (24, 80), f"pty={pty}")
    check(
        "the PTY width matches what xterm paints",
        pty is not None and geo is not None and abs(pty[1] - geo["cols"]) <= 1,
        f"pty={pty} xterm={geo}",
    )
    shot("size-before-resize")

    resize(wid, 700, 600)
    time.sleep(1.5)
    geo2 = xterm_geometry()
    pty2 = pty_size()
    check("a window resize reaches the PTY", pty2 != pty, f"{pty} -> {pty2}")
    check(
        "and the PTY still matches the pane",
        pty2 is not None and geo2 is not None and abs(pty2[1] - geo2["cols"]) <= 1,
        f"pty={pty2} xterm={geo2}",
    )
    shot("size-after-resize")
    resize(wid, 1200, 800)


def scenario_accents(wid):
    """A dead-key accent sends one character, and nothing else."""
    print("\naccented input")
    if not js("!!document.querySelector('.xterm-rows')"):
        check("a local terminal opens", open_terminal())
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    before = len(sent_bytes())
    press("dead_circumflex", "o")
    after = sent_bytes(before)
    check("^ then o sends exactly one chunk", len(after) == 1, f"sent={after}")
    check("and that chunk is ô (c3 b4)", after == ["c3 b4"], f"sent={after}")

    before = len(sent_bytes())
    press("eacute")
    after = sent_bytes(before)
    check("a directly typed é sends it once", after == ["c3 a9"], f"sent={after}")

    before = len(sent_bytes())
    type_text("hello")
    after = sent_bytes(before)
    check("plain letters are unaffected", len(after) == 5, f"sent={after}")
    check("no DEL was invented", "7f" not in after, f"sent={after}")

    # xterm's hidden textarea keeps what it could not attribute to a keystroke, and this
    # engine never empties it on an ordinary key. It is bounded all the same: xterm clears
    # it on Enter, on Ctrl+C and on blur. Measured here rather than assumed, because the
    # replay bug was that buffer being sent whole.
    hoard = js("document.querySelector('.xterm-helper-textarea').value")
    press("Return")
    time.sleep(0.4)
    after_enter = js("document.querySelector('.xterm-helper-textarea').value")
    check("Enter empties the hidden textarea", after_enter == "", f"before={hoard!r} after={after_enter!r}")

    type_text("more")
    time.sleep(0.3)
    js("document.querySelector('.xterm-helper-textarea').blur()")
    time.sleep(0.4)
    check(
        "blur empties it too",
        js("document.querySelector('.xterm-helper-textarea').value") == "",
    )
    shot("accents")


def scenario_clean(wid):
    """A whole accented command, and a screen that holds nothing but it."""
    print("\nscreen integrity")
    if not js("!!document.querySelector('.xterm-rows')"):
        check("a local terminal opens", open_terminal())
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    # Start from a clean screen so the count below is about this command alone. Ctrl+C
    # first: a scenario before this one may have left a line typed and unsent, which would
    # otherwise glue itself to `clear` and leave the screen full.
    press("ctrl+c")
    type_text("clear")
    press("Return")
    time.sleep(0.6)

    before = len(sent_bytes())
    type_text("echo d")
    press("eacute")
    type_text("j")
    press("agrave")
    type_text(" ")
    press("dead_circumflex", "o")
    type_text("ter")
    typed = sent_bytes(before)

    lines = [l for l in screen_text() if l]
    check(
        "the command line shows what was typed",
        any("echo déjà ôter" in l for l in lines),
        f"lines={lines}",
    )
    check("no pending accent is left on screen", not any("^" in l for l in lines), f"lines={lines}")

    press("Return")
    time.sleep(0.8)
    lines = [l for l in screen_text() if l]
    body = "\n".join(lines)
    check(
        "the output is the command's, once",
        body.count("déjà ôter") == 2,
        f"count={body.count('déjà ôter')} lines={lines}",
    )
    check("the command line is not duplicated", body.count("echo") == 1, f"lines={lines}")
    check("nothing was deleted", "7f" not in typed, f"sent={typed}")
    shot("clean")


def scenario_tab(wid):
    """Tab reaches the shell, and the shell completes with it."""
    print("\nshell completion")
    wanted = os.environ.get("RITE_BENCH_PICK_SHELL", "")
    if wanted:
        # The menu entry chooses the shell; the pane still opens from the Terminal button.
        check(f"{wanted} is chosen in the shell picker", pick_shell(wanted))
        check(f"a {wanted} pane opens", open_terminal())
    elif not js("!!document.querySelector('.xterm-rows')"):
        check("a local terminal opens", open_terminal())
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    press("ctrl+c")
    time.sleep(0.4)
    before = len(sent_bytes())
    type_text("ech")
    press("Tab")
    time.sleep(0.8)
    after = sent_bytes(before)
    check("Tab is sent to the shell as 09", "09" in after, f"sent={after}")
    # Which shell actually answered, named in the client's own log: the scenario is about
    # completion, and completion is the shell's, so a run has to say whose it tested.
    shell = ""
    with open(LOG, errors="replace") as f:
        for line in f:
            if "Using shell:" in line:
                shell = line.split("Using shell:")[1].strip()
    check("the pane runs a shell the log names", bool(shell), f"shell={shell or 'unknown'}")

    lines = [l for l in screen_text() if l]
    check(
        "the shell completed the word",
        any(l.rstrip().endswith("echo") for l in lines),
        f"lines={lines[-3:]}",
    )
    # The other completion, and the one a user meets first: several candidates, which fish
    # and bash draw as a LIST under the prompt. A single candidate completes in place and
    # needs no pager at all, so it says nothing about this.
    press("ctrl+c")
    type_text("mkdir -p zz_one zz_two zz_three")
    press("Return")
    time.sleep(0.8)
    before = len(sent_bytes())
    type_text("cd zz_")
    press("Tab")
    time.sleep(1.2)
    after = sent_bytes(before)
    check("Tab after a prefix with several matches is sent", "09" in after, f"sent={after}")

    lines = [l for l in screen_text() if l]
    shown = sum(1 for l in lines if "zz_one" in l or "zz_two" in l or "zz_three" in l)
    check(
        "the candidates are listed on screen",
        shown >= 1 and any("zz_one" in l and "zz_two" in l for l in lines)
        or sum(1 for l in lines if "zz_" in l) >= 2,
        f"lines={lines[-6:]}",
    )
    press("ctrl+c")
    shot("tab")


def scenario_picker(wid):
    """The key path can be filled by the shell, not only typed.

    The native chooser itself is not scriptable — it is a GTK dialog owned by the toolkit —
    so this drives the hook the shell was given for exactly that: a `pick-file` message
    carrying the path answers without raising a dialog. What it proves is the whole round
    trip through the real binary: the IPC is decoded, the answer reaches THIS window, and
    the page fills its field. The chooser's own branch is covered by the shell's unit tests.
    """
    print("\nkey path from the shell")
    focus(wid)
    asked = "/home/someone/.ssh/id_from_the_shell"
    ok = js(
        "(() => { if (!window.ipc) return 'no ipc';"
        " window.__PICKED__ = null;"
        " window.addEventListener('rite-file-picked', e => { window.__PICKED__ = e.detail; });"
        f" window.ipc.postMessage(JSON.stringify({{type:'pick-file',token:'bench-1',path:{asked!r}}}));"
        " return 'sent'; })()"
    )
    check("the page can ask the shell for a chooser", ok == "sent", f"js={ok}")
    time.sleep(1.0)
    got = js("window.__PICKED__")
    check(
        "the shell answers the window that asked, with the path",
        isinstance(got, dict) and got.get("token") == "bench-1" and got.get("path") == asked,
        f"detail={got}",
    )

    # And a cancelled chooser has to answer too, or the page waits on its promise for good.
    # This one raises the real GTK dialog, so it has to be dismissed where it lives: the
    # keystroke goes to the dialog's own window, which has to take the input focus first —
    # there is no window manager here to hand it over.
    js(
        "(() => { window.__PICKED__ = null;"
        " window.ipc.postMessage(JSON.stringify({type:'pick-file',token:'bench-2'}));"
        " return true; })()"
    )
    chooser = ""
    for _ in range(20):
        found = x("xdotool", "search", "--onlyvisible", "--name", "Choose a file").split()
        if found:
            chooser = found[-1]
            break
        time.sleep(0.3)
    check("the native chooser opens when no path is given", bool(chooser), f"window={chooser!r}")
    if chooser:
        focus(chooser)
        press("Escape")
    time.sleep(1.2)
    got = js("window.__PICKED__")
    check(
        "a cancelled chooser answers with no path",
        isinstance(got, dict) and got.get("token") == "bench-2" and not got.get("path"),
        f"detail={got}",
    )
    shot("picker")


def scenario_second(wid):
    """A second Rite, on its own data directory, gets a window instead of dying.

    Two processes cannot share one GApplication id: the second cannot own the bus name and
    GTK crashes inside `gtk_window_set_application` — no message, no stderr, four coredumps
    to find out. The id is therefore derived from the data directory, so only an installed
    Rite claims the canonical one. This proves both halves: derived ids live side by side,
    and forcing them to share still kills the newcomer, which is why the derivation exists.
    """
    print("\na second instance")
    before = set(x("xdotool", "search", "--onlyvisible", "--name", "^Rite$").split())

    def start(home, env_extra=None):
        env = dict(os.environ)
        env.update(HOME=home, XDG_DATA_HOME=f"{home}/.local/share",
                   XDG_CONFIG_HOME=f"{home}/.config")
        env.pop("RITE_APP_ID", None)
        env.update(env_extra or {})
        os.makedirs(f"{home}/.local/share", exist_ok=True)
        return subprocess.Popen([RITE], env=env,
                                stdout=open(f"/tmp/rite-second.log", "w"),
                                stderr=subprocess.STDOUT)

    second = start("/tmp/rite-home-2")
    found = set()
    for _ in range(40):
        found = set(x("xdotool", "search", "--onlyvisible", "--name", "^Rite$").split()) - before
        if found and second.poll() is None:
            break
        time.sleep(0.5)
    check(
        "a second data directory gets its own window",
        bool(found) and second.poll() is None,
        f"new windows={sorted(found)} exit={second.poll()}",
    )
    shot("second")
    second.terminate()
    try:
        second.wait(timeout=10)
    except subprocess.TimeoutExpired:
        second.kill()

    # The defect itself, on purpose: the same id in two processes.
    time.sleep(1.0)
    before = set(x("xdotool", "search", "--onlyvisible", "--name", "^Rite$").split())
    forced = start("/tmp/rite-home-3", {"RITE_APP_ID": "io.github.altagen.rite.bench"})
    died = False
    for _ in range(30):
        if forced.poll() is not None:
            died = True
            break
        time.sleep(0.5)
    check(
        "sharing an id is what kills it, which the derived id avoids",
        died,
        f"exit={forced.poll()} windows={sorted(set(x('xdotool','search','--onlyvisible','--name','^Rite$').split()) - before)}",
    )
    if not died:
        forced.terminate()
    # And the instance this bench drives is still the one it was driving.
    check("the first instance is untouched", js("1+1") == 2)


def drag_over(wid, needle):
    """Drag the real mouse across the row carrying `needle`, and say if it selected.

    A real pointer, not a synthetic MouseEvent: dispatching mousedown/mousemove/mouseup
    with clientX/clientY reaches xterm's selection service in Chromium and reaches nothing
    in WebKitGTK — measured, 0 selection rects — which is exactly the kind of gap this
    bench exists for. The window carries no decorations under this X server, so a client
    coordinate is a screen coordinate plus the window's own origin.
    """
    rect = js(
        "(() => { const rows = document.querySelectorAll('.xterm-rows > div');"
        f" const row = Array.from(rows).find(r => /{needle}/.test(r.textContent||''));"
        " if (!row) return null; const b = row.getBoundingClientRect();"
        " return {left: Math.round(b.left), right: Math.round(b.right),"
        "         mid: Math.round(b.top + b.height/2)}; })()"
    )
    if not rect:
        return None
    geo = x("xdotool", "getwindowgeometry", "--shell", wid)
    org = dict(l.split("=", 1) for l in geo.splitlines() if "=" in l)
    ox, oy = int(org["X"]), int(org["Y"])
    y = oy + rect["mid"]
    subprocess.run(["xdotool", "mousemove", str(ox + rect["left"] + 2), str(y)], check=False)
    subprocess.run(["xdotool", "mousedown", "1"], check=False)
    time.sleep(0.2)
    subprocess.run(
        ["xdotool", "mousemove", str(ox + (rect["left"] + rect["right"]) // 2), str(y)],
        check=False,
    )
    time.sleep(0.2)
    subprocess.run(["xdotool", "mousemove", str(ox + rect["right"] - 4), str(y)], check=False)
    time.sleep(0.2)
    subprocess.run(["xdotool", "mouseup", "1"], check=False)
    time.sleep(0.5)
    return js("document.querySelectorAll('.xterm-selection div').length")


def clipboard_through_a_gesture(write=None):
    """Read, or write then read, the clipboard from inside a real keydown.

    The Clipboard API is gated on transient activation on this engine: the same call is
    `NotAllowedError` from an eval and fine from a keydown. So the bench installs a
    handler, presses a key, and reads the answer back — which is also exactly how the
    client's own guard has to do it.
    """
    js(
        "window.__CB = 'not fired';"
        " window.__probe = (e) => { if (e.key !== 'F8') return;"
        "   const w = " + ("navigator.clipboard.writeText(%r)" % write if write is not None
                           else "Promise.resolve()") + ";"
        "   w.then(() => navigator.clipboard.readText())"
        "    .then(v => window.__CB = 'ok:' + v)"
        "    .catch(err => window.__CB = 'ERR ' + err.name); };"
        " window.addEventListener('keydown', window.__probe, true); 1"
    )
    press("F8")
    time.sleep(1.2)
    out = js("window.__CB")
    js("window.removeEventListener('keydown', window.__probe, true); 1")
    return out


def scenario_clipboard(wid):
    """Copy and paste, on the engine Rite actually ships in.

    Both halves were measured here before they were written. What the measurements said,
    and what this scenario now holds:

      - `Ctrl+Shift+C` sent nothing and copied nothing: no chord fired xterm's own copy.
      - `Ctrl+Shift+V` already pastes, so paste is deliberately not bound — it must still
        happen exactly once.
      - a middle click with an empty clipboard sent `ESC[200~ ESC[201~`, two escape
        sequences around no text. The browser suite cannot assert that one: a synthetic
        empty paste delivers nothing either way, and a page cannot clear what X11 holds.
    """
    print("\nclipboard")
    if not js("!!document.querySelector('.xterm-rows')"):
        check("a local terminal opens", open_terminal())
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    # The API is there, and it answers from a gesture. Both are preconditions of the
    # design, so a change in the engine shows up here rather than as a silent no-copy.
    check("the engine is a secure context", js("window.isSecureContext") is True)
    check("the clipboard API exists", js("!!(navigator.clipboard && navigator.clipboard.readText)"))
    probe = clipboard_through_a_gesture("BENCH-GESTURE")
    check(
        "the clipboard answers from inside a keydown",
        probe == "ok:BENCH-GESTURE",
        f"got {probe}",
    )

    press("ctrl+c")
    time.sleep(0.3)
    type_text("echo BENCH-SELECT")
    time.sleep(0.6)

    rects = drag_over(wid, "BENCH-SELECT")
    check("dragging the mouse selects something", bool(rects), f"{rects} selection rects")

    before = len(sent_bytes())
    press("ctrl+shift+c")
    time.sleep(0.6)
    after = sent_bytes(before)
    # A terminal that copies AND sends is worse than one that only sends: the shell acts
    # on something nobody typed.
    check("the copy chord sends nothing to the shell", after == [], f"sent={after}")
    got = clipboard_through_a_gesture()
    check(
        "the copy chord put the selection on the clipboard",
        isinstance(got, str) and "BENCH-SELECT" in got,
        f"got {got}",
    )

    # Nothing to paste, established rather than hoped for: the clipboard is emptied from
    # inside a gesture, which is the only way to touch it here.
    clipboard_through_a_gesture("")
    before = len(sent_bytes())
    subprocess.run(["xdotool", "click", "2"], check=False)
    time.sleep(0.8)
    after = sent_bytes(before)
    check("a middle click with nothing to paste sends nothing", after == [], f"sent={after}")

    # And a paste that carries text still arrives, once, bracketed.
    clipboard_through_a_gesture("BENCH-PASTE")
    before = len(sent_bytes())
    press("ctrl+shift+v")
    time.sleep(0.8)
    after = " ".join(sent_bytes(before))
    hexed = "".join(f"{ord(c):02x} " for c in "BENCH-PASTE").strip()
    check("a paste carrying text arrives", hexed in after, f"sent={after}")
    check(
        "and it arrives once",
        after.count(hexed) == 1,
        f"{after.count(hexed)} occurrences",
    )

    press("ctrl+c")
    before = len(sent_bytes())
    press("ctrl+c")
    time.sleep(0.5)
    # The whole reason copy needs its own chord: this one belongs to the shell.
    check("Ctrl+C still interrupts", "03" in sent_bytes(before), f"sent={sent_bytes(before)}")
    shot("clipboard")


SCENARIOS = {
    "probe": scenario_probe,
    "size": scenario_size,
    "accents": scenario_accents,
    "clean": scenario_clean,
    "tab": scenario_tab,
    "picker": scenario_picker,
    "second": scenario_second,
    "clipboard": scenario_clipboard,
}


# ── entry ────────────────────────────────────────────────────────────────────────
def main():
    wanted = sys.argv[1:] or ["probe"]
    threading.Thread(target=serve, daemon=True).start()

    subprocess.Popen(
        ["Xvfb", DISPLAY, "-screen", "0", "1400x900x24"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    os.environ["DISPLAY"] = DISPLAY

    rite = subprocess.Popen(
        [RITE], stdout=open(LOG, "w"), stderr=subprocess.STDOUT,
    )
    wid = window_id()
    print(f"window {wid}")
    resize(wid, 1200, 800)
    focus(wid)

    if not _hello.wait(30):
        print("  FAIL  the page agent never reported in")
        FAILED.append("agent")
    else:
        print("agent connected")

    try:
        for name in wanted:
            SCENARIOS[name](wid)
    finally:
        shot("final")
        rite.send_signal(signal.SIGTERM)
        time.sleep(1)
        rite.kill()

    print()
    if FAILED:
        print(f"❌ {len(FAILED)} failed: {', '.join(FAILED)}")
    else:
        print("✅ all checks passed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
