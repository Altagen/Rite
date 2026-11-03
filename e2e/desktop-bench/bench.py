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


def drag_over(wid, needle, mid_drag=False):
    """Drag the real mouse across the row carrying `needle`, and say if it selected.

    `mid_drag` returns the rect count from BEFORE the button is released as well, as
    `(mid, after)`. A mode that copies on selection releases it on that very mouseup, so
    counting only afterwards cannot tell a drag that selected nothing from one that
    selected and was released — two different bugs with the same reading.

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
    mid = js("document.querySelectorAll('.xterm-selection div').length") if mid_drag else None
    subprocess.run(["xdotool", "mouseup", "1"], check=False)
    time.sleep(0.5)
    after = js("document.querySelectorAll('.xterm-selection div').length")
    return (mid, after) if mid_drag else after


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


def right_click(wid):
    """Right-click in the middle of the terminal, with the real pointer.

    `drag_over` above says why a synthetic MouseEvent is not an option here either: it
    reaches nothing in WebKitGTK.
    """
    rect = js(
        "(() => { const b = document.querySelector('.xterm-screen').getBoundingClientRect();"
        " return {x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2)}; })()"
    )
    geo = x("xdotool", "getwindowgeometry", "--shell", wid)
    org = dict(l.split("=", 1) for l in geo.splitlines() if "=" in l)
    subprocess.run(
        ["xdotool", "mousemove",
         str(int(org["X"]) + rect["x"]), str(int(org["Y"]) + rect["y"])],
        check=False,
    )
    subprocess.run(["xdotool", "click", "3"], check=False)
    time.sleep(1.0)


def pick_copy_mode(name):
    """Choose a copy convention in Settings, by test id, and close Settings.

    Through the UI and not by writing the document: the document is not an editing
    surface, and this is also the path a person takes.
    """
    js("document.querySelector('[data-testid=vault-pastille]')?.click(); 1")
    time.sleep(0.4)
    js("document.querySelector('[data-testid=pastille-settings]')?.click(); 1")
    time.sleep(0.6)
    js("document.querySelector('[data-testid=settings-nav-clipboard]')?.click(); 1")
    time.sleep(0.4)
    js("document.querySelector('[data-testid=copy-mode]')?.click(); 1")
    time.sleep(0.4)
    js(f"document.querySelector('[data-testid=copy-mode-{name}]')?.click(); 1")
    time.sleep(0.5)
    chosen = js("document.querySelector('[data-testid=copy-mode]')?.textContent")
    # Escape is not enough here: the dropdown closed on it, not the screen. The close
    # button is the one the person uses, and it is found by its label rather than its
    # position so a rearranged header does not break this.
    press("Escape")
    time.sleep(0.3)
    js(
        "(() => { const b = Array.from(document.querySelectorAll('button'))"
        "   .find(b => /settings|fermer|close/i.test(b.getAttribute('aria-label') || ''));"
        " if (b) b.click(); return !!b; })()"
    )
    time.sleep(0.8)
    return chosen


def scenario_rightpaste(wid):
    """`selectRightPaste`, the mode that reproduces PuTTY, on the engine that ships.

    IT DID NOTHING AT ALL, and the reason is here rather than in the decision table. The
    paste half has no native event to ride: a middle click is served by the engine itself,
    a context menu carries nothing, so the client has to read the clipboard — and reading
    is gated on transient activation. The right button grants it; the `contextmenu` WebKit
    synthesises from that button does not. Measured below, both halves of it, because the
    two have different fixes and only one of them is "move the paste to the mouseup".

    The `clipboard` scenario above could never have caught it: every read it makes happens
    inside a keydown.
    """
    print("\nright-click paste")
    if not js("!!document.querySelector('.xterm-rows')"):
        check("a local terminal opens", open_terminal())
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    # Something on the clipboard, put there the only way this engine allows: from inside a
    # gesture. The page wrote it, which is the case the mode itself produces — a selection
    # the client copied a moment earlier.
    put = clipboard_through_a_gesture("BENCH-RIGHT")
    check("the clipboard holds a known value", put == "ok:BENCH-RIGHT", f"got {put}")

    # ONE right click, and every event it fires asks the same question.
    js(
        "window.__R = {};"
        " window.__cm = (e) => { if (e.type === 'contextmenu') e.preventDefault();"
        "   if (e.type !== 'contextmenu' && e.button !== 2) return;"
        "   const k = e.type; window.__R[k] = 'pending';"
        "   navigator.clipboard.readText().then(v => window.__R[k] = 'ok:' + v)"
        "     .catch(err => window.__R[k] = 'ERR ' + err.name); };"
        " for (const t of ['contextmenu', 'mousedown', 'mouseup'])"
        "   window.addEventListener(t, window.__cm, true); 1"
    )
    right_click(wid)
    time.sleep(1.5)
    res = json.loads(js("JSON.stringify(window.__R)") or "{}")
    js(
        "for (const t of ['contextmenu', 'mousedown', 'mouseup'])"
        " window.removeEventListener(t, window.__cm, true); 1"
    )
    press("Escape")
    check("a right click reaches the page as contextmenu", "contextmenu" in res,
          f"got {sorted(res)}")
    # The one the fix rests on. If this ever breaks, the mode has no paste at all.
    check("the clipboard can be read from the release of that click",
          res.get("mouseup") == "ok:BENCH-RIGHT", f"got {res.get('mouseup')}")
    # And the one that was the bug. A green here would mean WebKit changed and the paste
    # could move back to the gesture it is named after — so it is asserted, not assumed.
    check("but not from inside the context menu, on this engine",
          res.get("contextmenu") == "ERR NotAllowedError", f"got {res.get('contextmenu')}")

    # ── and now the client's own, end to end ─────────────────────────────────────
    chosen = pick_copy_mode("selectRightPaste")
    check("the mode is chosen in Settings",
          chosen == "Select to copy, right click pastes", f"got {chosen}")
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    clipboard_through_a_gesture("BENCH-PUTTY")
    before = len(sent_bytes())
    right_click(wid)
    time.sleep(1.2)
    after = " ".join(sent_bytes(before))
    hexed = "".join(f"{ord(c):02x} " for c in "BENCH-PUTTY").strip()
    check("a right click pastes into the shell", hexed in after, f"sent={after}")
    check("and pastes once", after.count(hexed) == 1, f"{after.count(hexed)} occurrences")

    # The copy half, and the release that goes with it. A selection that stays highlighted
    # after the drag that made it has nothing left to do: it was already copied.
    press("ctrl+c")
    time.sleep(0.3)
    type_text("echo BENCH-RELEASE")
    time.sleep(0.6)
    mid, left = drag_over(wid, "BENCH-RELEASE", mid_drag=True)
    check("dragging the mouse selects something", bool(mid), f"{mid} rects mid-drag")
    got = clipboard_through_a_gesture()
    check("the selection was copied without a chord",
          isinstance(got, str) and "BENCH-RELEASE" in got, f"got {got}")
    # The bug this half fixes: the highlight used to stay after the drag that made it,
    # with nothing left to do about it — it had already been copied.
    check("and the selection is released on the mouseup", left == 0, f"{left} rects left")

    press("ctrl+c")
    shot("rightpaste")


def scenario_rightcopy(wid):
    """`rightCopyPaste`: one gesture, two meanings, on the engine that ships.

    Selecting does nothing on its own; a right click copies the selection and lets it go;
    a right click with nothing selected pastes. The decision is a table
    (`e2e/clipboard-decision-check.mjs`); what only a real engine can answer is whether
    the selection is STILL THERE when the right mouseup arrives. If xterm cleared it on
    the mousedown, every right click would read an empty selection and paste — the mode
    would have exactly one of its two meanings, and the table would still be green.
    """
    print("\nright click copies, then pastes")
    if not js("!!document.querySelector('.xterm-rows')"):
        check("a local terminal opens", open_terminal())
    chosen = pick_copy_mode("rightCopyPaste")
    check("the mode is chosen in Settings", chosen == "Right click copies, then pastes",
          f"got {chosen}")
    focus(wid)
    js("document.querySelector('.xterm-helper-textarea')?.focus()")
    time.sleep(0.3)

    press("ctrl+c")
    time.sleep(0.3)
    type_text("echo BENCH-RIGHTCOPY")
    time.sleep(0.6)

    # Something else on the clipboard first, so "the selection was copied" cannot pass on
    # what was already there.
    clipboard_through_a_gesture("BENCH-STALE")

    # READING THE CLIPBOARD COSTS THE SELECTION. The probe presses a key to get a gesture,
    # and a keystroke clears xterm's selection — which is correct of xterm and fatal to a
    # scenario that reads the clipboard between selecting and right-clicking. So each half
    # gets its own drag, and nothing is read between a drag and the click under test.
    mid, left = drag_over(wid, "BENCH-RIGHTCOPY", mid_drag=True)
    check("dragging selects", bool(mid), f"{mid} rects mid-drag")
    check("and leaves the selection on screen", left > 0, f"{left} rects left")
    got = clipboard_through_a_gesture()
    check("a drag copies nothing by itself", got == "ok:BENCH-STALE", f"got {got}")

    drag_over(wid, "BENCH-RIGHTCOPY")
    before = len(sent_bytes())
    right_click(wid)
    time.sleep(0.8)
    # The selection first, because reading the clipboard would clear it either way.
    gone = js("document.querySelectorAll('.xterm-selection div').length")
    after = " ".join(sent_bytes(before))
    check("the first right click sends nothing to the shell", after == "", f"sent={after}")
    # THE MEASUREMENT THIS SCENARIO EXISTS FOR. Without the release the next right click
    # meets the same selection, copies it again, and the paste is unreachable for ever.
    check("and lets the selection go", gone == 0, f"{gone} rects left")
    got = clipboard_through_a_gesture()
    check("and copied the selection", isinstance(got, str) and "BENCH-RIGHTCOPY" in got,
          f"got {got}")

    before = len(sent_bytes())
    right_click(wid)
    time.sleep(1.2)
    after = " ".join(sent_bytes(before))
    hexed = "".join(f"{ord(c):02x} " for c in "BENCH-RIGHTCOPY").strip()
    check("the second right click pastes what the first copied", hexed in after, f"sent={after}")
    check("and pastes it once", after.count(hexed) == 1, f"{after.count(hexed)} occurrences")

    press("ctrl+c")
    shot("rightcopy")


def scenario_agents(wid):
    """The agent manager on a real desktop, which is the only place it has a local machine.

    A browser is offered none — its "local" would be the instance's container, shared by
    every member — so the browser suite can only hold the absence. THIS is the half that
    cannot be tested anywhere else: a desktop window, in a context with no vault opened
    at all, offering the machine it is running on and probing it.

    The image has no agent CLI installed, so the honest answer is none. That is the
    assertion: "none" has to read as an answer, with the time it was read, rather than as
    an error or a blank panel.
    """
    print("\nagent manager")
    focus(wid)
    opened = js(
        "(() => { const b = document.querySelector('[data-testid=toolbar-agents]');"
        " if (!b) return false; b.click(); return true; })()"
    )
    check("the toolbar opens it", opened is True)
    time.sleep(0.8)
    check("and it is a view", js("!!document.querySelector('[data-testid=agent-manager]')"))

    # The machine that is always there on a desktop, and only on a desktop.
    js("document.querySelector('[data-testid=agent-machine]')?.click(); 1")
    time.sleep(0.4)
    labels = js(
        "Array.from(document.querySelectorAll('[role=option]')).map(o => o.textContent.trim())"
    )
    check("this machine is offered, with no vault open", "This machine" in (labels or []),
          f"got {labels}")
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => o.textContent.trim() === 'This machine'); if (o) o.click(); })()"
    )
    time.sleep(0.5)
    check("and picking it says it has not been looked at",
          js("!!document.querySelector('[data-testid=agent-not-probed]')"))

    js("document.querySelector('[data-testid=agent-probe]')?.click(); 1")
    time.sleep(3.0)
    err = js("document.querySelector('[data-testid=agent-error]')?.textContent || ''")
    empty = js("document.querySelector('[data-testid=agent-empty]')?.textContent || ''")
    check("probing answers rather than failing", err == "", f"error={err}")
    # No CLI in this image, so none is the truth — and it is said with the time it was
    # read, which is what makes it an answer.
    check("and says none, dated", "This machine" in empty, f"got {empty!r}")
    shot("agents")


def scenario_agentload(wid):
    """The manager under the load it actually meets. Run with RITE_BENCH_AGENTS=1.

    Seventy-odd conversations, in the proportions measured on a real machine: six Claude
    projects, sixty-one Codex rollouts of which exactly one was ever typed into, four
    Grok projects and two Antigravity databases. A manager that reads well on four cards
    says nothing about the one in front of a person.

    It asserts the few things that are facts — the count, the order, that the one Codex
    conversation with a question is first — and then takes a screenshot, because the rest
    of what this scenario is for is a judgement nobody can make from a number.
    """
    print("\nagent manager, loaded")
    focus(wid)
    js("document.querySelector('[data-testid=toolbar-agents]')?.click(); 1")
    time.sleep(0.8)
    # Two calls, because the options are rendered by the click above: asking for them in
    # the same tick asks before React has drawn them.
    js("document.querySelector('[data-testid=agent-machine]')?.click(); 1")
    time.sleep(0.5)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => o.textContent.trim() === 'This machine'); if (o) o.click(); })()"
    )
    time.sleep(0.5)
    js("document.querySelector('[data-testid=agent-probe]')?.click(); 1")
    time.sleep(6.0)

    sub = js("document.querySelector('[data-testid=agent-subtitle]')?.textContent || ''")
    check("every conversation is counted", "73 conversations" in sub, f"got {sub!r}")
    bands = js(
        "Array.from(document.querySelectorAll('[data-testid^=agent-band-]'))"
        ".map(b => b.getAttribute('data-testid').replace('agent-band-',''))"
    )
    check("one band per tool that answered", bands == ["claude", "codex", "grok", "antigravity"],
          f"got {bands}")
    first = js(
        "document.querySelector('[data-testid=agent-band-codex] [data-testid^=agent-card-]')"
        "?.textContent || ''"
    )
    # The whole reason the listing asks for a time: this one started in September.
    check("the Codex conversation written last is first", "Reprendre le portage" in first,
          f"got {first[:60]!r}")

    # THE BAND SPLITS WHERE THE INFORMATION DOES. Seven conversations were typed into;
    # the other sixty-six have a date and an id, and they sit behind one line per band
    # rather than in front of the card being looked for.
    count = js("document.querySelectorAll('[data-testid^=agent-card-]').length")
    # Seven were typed into, and six more belong to adapters that do not read a
    # transcript at all — those are drawn plainly, because "no question" would be a
    # statement about Grok that is only true of this client.
    check("only the conversations with a question are drawn", count == 13, f"{count} cards")
    quiet = js(
        "Array.from(document.querySelectorAll('[data-testid^=agent-quiet-]'))"
        # The chevron is the first child and carries no words; the count is the line.
        ".map(b => b.textContent.replace(/[^0-9a-zA-Z ]/g, '').trim())"
    )
    check("and the rest are one line per band, counted",
          quiet == ["60 sessions with no question"],
          f"got {quiet}")
    shot("agentload-stacked")

    js("document.querySelector('[data-testid=agent-quiet-codex]')?.click(); 1")
    time.sleep(0.6)
    opened = js("document.querySelectorAll('[data-testid^=agent-card-]').length")
    check("opening one shows them, without hiding anything else", opened == 73, f"{opened} cards")
    shot("agentload-opened")
    js("document.querySelector('[data-testid=agent-quiet-codex]')?.click(); 1")
    time.sleep(0.4)

    # And the filter that answers "only November", on the load that needs it.
    js("document.querySelector('[data-testid=agent-since]')?.click(); 1")
    time.sleep(0.4)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => /24 hours/.test(o.textContent)); if (o) o.click(); })()"
    )
    time.sleep(0.6)
    sub = js("document.querySelector('[data-testid=agent-subtitle]')?.textContent || ''")
    check("the count still names what the machine holds", "73 conversations" in sub, f"got {sub!r}")
    shot("agentload-since")
    js("document.querySelector('[data-testid=agent-since]')?.click(); 1")
    time.sleep(0.4)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => /Any time/.test(o.textContent)); if (o) o.click(); })()"
    )
    time.sleep(0.4)

    # NAMING SOMEONE ELSE'S CONVERSATION (ADR 0022 §6). What it writes is a `[[mark]]`
    # in the workspace document — the same support a layout rides — so the proof it
    # worked is that the card reads differently after a reload would have cost nothing.
    card = js(
        "document.querySelector('[data-testid^=agent-rename-]')"
        "?.getAttribute('data-testid') || ''"
    )
    check("a card offers a rename", card.startswith("agent-rename-"), f"got {card!r}")
    js(f"document.querySelector('[data-testid=\"{card}\"]')?.click(); 1")
    time.sleep(0.5)
    check("and a dialog opens on it", js("!!document.querySelector('[data-testid=agent-rename-dialog]')"))
    js(
        "(() => { const i = document.querySelector('[data-testid=agent-rename-input]');"
        " const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
        " set.call(i, 'le portage du worker');"
        " i.dispatchEvent(new Event('input', { bubbles: true })); })()"
    )
    time.sleep(0.3)
    js("document.querySelector('[data-testid=agent-color-7c5cff]')?.click(); 1")
    time.sleep(0.3)
    js("document.querySelector('[data-testid=agent-rename-save]')?.click(); 1")
    time.sleep(1.2)
    named = js(
        "Array.from(document.querySelectorAll('[data-testid^=agent-card-]'))"
        ".some(c => c.textContent.includes('le portage du worker'))"
    )
    check("the card wears the name", named is True)
    # The question it replaced is still under it: a name adds a handle, it does not hide
    # what the conversation is.
    both = js(
        "Array.from(document.querySelectorAll('[data-testid^=agent-card-]'))"
        ".some(c => c.textContent.includes('le portage du worker')"
        "        && c.textContent.includes('Question 1'))"
    )
    check("and what the tool reported is still under it", both is True)

    # AND THE NAME IS SOMETHING TO FILTER BY, which is what a name is for on a list of
    # seventy-three. A FILTER and not a second grouping: the band per CLI stays the
    # structure of the page, so narrowing by name does not cost the tool a card is under.
    js("document.querySelector('[data-testid=agent-named]')?.click(); 1")
    time.sleep(0.4)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => o.textContent.trim() === 'le portage du worker'); if (o) o.click(); })()"
    )
    time.sleep(0.6)
    only = js("document.querySelectorAll('[data-testid^=agent-card-]').length")
    check("filtering by the name leaves that one conversation", only == 1, f"{only} cards")
    bands_left = js("document.querySelectorAll('[data-testid^=agent-band-]').length")
    check("and it is still under its own tool", bands_left == 1, f"{bands_left} bands")
    shot("agentload-named")
    js("document.querySelector('[data-testid=agent-named]')?.click(); 1")
    time.sleep(0.4)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => o.textContent.trim() === 'Any'); if (o) o.click(); })()"
    )
    time.sleep(0.5)

    # EVERY MACHINE AT ONCE, which is the entry no single-machine tool has. It never
    # probes: it is every answer already held, so with one machine read it says one.
    js("document.querySelector('[data-testid=agent-machine]')?.click(); 1")
    time.sleep(0.5)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => o.textContent.trim() === 'All machines'); if (o) o.click(); })()"
    )
    time.sleep(0.8)
    sub = js("document.querySelector('[data-testid=agent-subtitle]')?.textContent || ''")
    check("all machines speaks for what has been read",
          "73 conversations across 1 machines" in sub, f"got {sub!r}")
    # And it asks nothing: fanning a probe across the library would be one SSH round
    # trip per machine behind a view that opened by itself.
    check("and offers no probe of its own",
          js("!document.querySelector('[data-testid=agent-probe]')"))
    shot("agentload-all")
    js("document.querySelector('[data-testid=agent-machine]')?.click(); 1")
    time.sleep(0.5)
    js(
        "(() => { const o = Array.from(document.querySelectorAll('[role=option]'))"
        "   .find(o => o.textContent.trim() === 'This machine'); if (o) o.click(); })()"
    )
    time.sleep(0.6)

    # CLICKING A CARD OPENS WHAT IS KNOWN ABOUT IT, beside the list rather than over it.
    js(
        "(() => { const c = document.querySelector('[data-testid^=agent-card-]');"
        " if (c) c.click(); })()"
    )
    time.sleep(0.6)
    check("a card opens a detail", js("!!document.querySelector('[data-testid=agent-detail]')"))
    facts = js("document.querySelector('[data-testid=agent-detail]')?.textContent || ''")
    # What a listing gave, and nothing it did not: the resume line is the fact a person
    # cannot get anywhere else, because the adapter built it.
    check("and it carries the line that resumes it", "claude --resume" in facts, f"got {facts[:80]!r}")

    # THE FACTS AND THE ACTIONS FIRST, THE PROMPT LAST. A first message can be a pasted
    # file, and four thousand characters at the top of the panel pushed all five buttons
    # off the bottom of it — so opening a card meant scrolling before anything could be
    # done. Asserted as an ORDER in the document rather than as a pixel, because that is
    # the decision; the screenshot beside it is for the rest.
    order = js(
        "(() => { const d = document.querySelector('[data-testid=agent-detail]');"
        " const a = d.querySelector('[data-testid=agent-detail-resume]');"
        " const p = d.querySelector('[data-testid=agent-detail-ask]');"
        " if (!a || !p) return 'missing';"
        " return (a.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING)"
        "   ? 'actions first' : 'prompt first'; })()"
    )
    check("the actions come before the prompt", order == "actions first", f"got {order!r}")
    shot("agentload-detail")
    js("document.querySelector('[data-testid=agent-detail-close]')?.click(); 1")
    time.sleep(0.4)

    # AND THE FOLD IS MEASURED, NOT GUESSED. One of the seeded conversations opens with a
    # pasted file; the short ones must not grow a "see more" that reveals nothing.
    def open_card_with(needle):
        return js(
            "(() => { const c = Array.from(document.querySelectorAll('[data-testid^=agent-card-]'))"
            f"   .find(c => c.textContent.includes({needle!r})); if (!c) return false;"
            " c.click(); return true; })()"
        )

    check("the pasted-file conversation is on screen", open_card_with("Voici le diff complet") is True)
    time.sleep(0.6)
    folded = js(
        "(() => { const p = document.querySelector('[data-testid=agent-detail-ask]');"
        " return p ? p.scrollHeight > p.clientHeight + 1 : null; })()"
    )
    check("a long prompt arrives folded", folded is True, f"got {folded}")
    check("and offers to unfold it", js("!!document.querySelector('[data-testid=agent-detail-ask-more]')"))
    js("document.querySelector('[data-testid=agent-detail-ask-more]')?.click(); 1")
    time.sleep(0.4)
    whole = js(
        "(() => { const p = document.querySelector('[data-testid=agent-detail-ask]');"
        " return p ? p.scrollHeight <= p.clientHeight + 1 : null; })()"
    )
    check("unfolded, the whole prompt is there", whole is True, f"got {whole}")
    shot("agentload-prompt")
    js("document.querySelector('[data-testid=agent-detail-close]')?.click(); 1")
    time.sleep(0.4)

    check("a short conversation is on screen", open_card_with("Question 1 sur") is True)
    time.sleep(0.6)
    check("a short prompt grows no control",
          js("!document.querySelector('[data-testid=agent-detail-ask-more]')"))

    # WHAT THE MACHINE SAYS NOW, read when the card was clicked and kept nowhere. A branch
    # is the example and the rule is general: anything that is a property of the machine
    # rather than of the file is asked for on the gesture, because shown on a card it would
    # be read as current and go stale the moment someone switches branches.
    #
    # The proof is the switch itself: this repository is in the throwaway home, so the
    # bench is allowed to move it between two looks at the SAME conversation.
    repo = os.path.join(os.environ.get("HOME", ""), "repo")

    def live_text():
        for _ in range(40):
            out = js("document.querySelector('[data-testid=agent-detail-live]')?.textContent || ''")
            if out and "Reading" not in out:
                return out
            time.sleep(0.25)
        return out

    out = live_text()
    check("the machine answers with the branch it is on", "main" in out, f"got {out!r}")
    check("and whether the tree is clean", "clean" in out or "uncommitted" in out, f"got {out!r}")
    check("and names the directory it asked about", repo in out, f"got {out!r}")

    # Moved on the machine, behind the panel's back.
    x("git", "-C", repo, "checkout", "-q", "-b", "hotfix")
    js("document.querySelector('[data-testid=agent-detail-live-again]')?.click(); 1")
    time.sleep(0.5)
    out = live_text()
    check("asking again follows the machine", "hotfix" in out, f"got {out!r}")

    # AND NOTHING IS KEPT: closing and reopening the same card asks the machine again
    # rather than showing what the last look found.
    x("git", "-C", repo, "checkout", "-q", "main")
    js("document.querySelector('[data-testid=agent-detail-close]')?.click(); 1")
    time.sleep(0.4)
    check("the same card reopens", open_card_with("Question 1 sur") is True)
    time.sleep(0.5)
    out = live_text()
    check("and it is read again, not remembered", "main" in out and "hotfix" not in out,
          f"got {out!r}")
    shot("agentload-live")

    # The other answer the panel has to be able to give, on the conversation seeded with a
    # directory that does not exist. "Not a git repository" there would be false.
    js("document.querySelector('[data-testid=agent-detail-close]')?.click(); 1")
    time.sleep(0.4)
    check("the conversation with a vanished directory is on screen",
          open_card_with("Question 2 sur") is True)
    time.sleep(0.5)
    out = live_text()
    check("a directory that is gone says so, and not 'no repository'",
          "gone" in out.lower() and "repositor" not in out.lower(), f"got {out!r}")
    js("document.querySelector('[data-testid=agent-detail-close]')?.click(); 1")
    time.sleep(0.4)
    check("back on the one being deleted", open_card_with("Question 1 sur") is True)
    time.sleep(0.6)

    # DELETING ONE, which is a vendor's file going away on a real machine. The card is
    # expected to go with it, and the file is read back off the disk — a screen that
    # dropped the row without the `rm` landing would pass every assertion but one.
    path = js(
        "(() => { const d = document.querySelector('[data-testid=agent-detail]');"
        " const m = d.textContent.match(/\\/[^\\s]*\\.jsonl/); return m ? m[0] : ''; })()"
    )
    check("the panel names the file it would remove", path.endswith(".jsonl"), f"got {path!r}")
    before = js("document.querySelectorAll('[data-testid^=agent-card-]').length")
    # The name given earlier landed on this same card, so the document Rite owns holds it
    # now and must not hold it afterwards: a mark is keyed to a conversation id, and this
    # is the one moment Rite knows for certain that one has rotted.
    cid = os.path.basename(path)[: -len(".jsonl")]
    marks_file = os.path.join(os.environ.get("HOME", ""), ".config/rite/marks.json")
    marks_before = open(marks_file).read() if os.path.exists(marks_file) else ""
    check("the name is in the document Rite owns", cid in marks_before, f"got {marks_before[:120]!r}")
    js("document.querySelector('[data-testid=agent-detail-delete]')?.click(); 1")
    time.sleep(0.6)
    asked = js("document.querySelector('[data-testid=confirm-dialog]')?.textContent || ''")
    # The path is IN the question, because it is the fact that settles it: one file, on
    # one machine, named rather than described.
    check("delete asks first, and names the file", path in asked, f"got {asked[:120]!r}")
    js("document.querySelector('[data-testid=confirm-cancel]')?.click(); 1")
    time.sleep(0.6)
    check("and a cancel removes nothing", os.path.exists(path) and
          js("document.querySelectorAll('[data-testid^=agent-card-]').length") == before)

    js("document.querySelector('[data-testid=agent-detail-delete]')?.click(); 1")
    time.sleep(0.6)
    js("document.querySelector('[data-testid=confirm-accept]')?.click(); 1")
    time.sleep(2.0)
    check("the file is gone", not os.path.exists(path), path)
    after = js("document.querySelectorAll('[data-testid^=agent-card-]').length")
    check("and the card went with it", after == before - 1, f"{before} -> {after}")
    check("and the panel closed on what no longer exists",
          js("!document.querySelector('[data-testid=agent-detail]')"))
    marks_after = open(marks_file).read() if os.path.exists(marks_file) else ""
    check("and the name went with it", cid not in marks_after, f"got {marks_after[:160]!r}")
    shot("agentload-deleted")

    # STARTING ONE, which is the other half: the tool run with no arguments, in the
    # directory that was named. The seeded fake binary prints its own `$PWD` and stays
    # up, so the pane itself says whether the directory arrived.
    js("document.querySelector('[data-testid=agent-new-claude]')?.click(); 1")
    time.sleep(0.6)
    check("a band offers to start one", js("!!document.querySelector('[data-testid=agent-new-dialog]')"))
    js(
        "(() => { const i = document.querySelector('[data-testid=agent-new-cwd]');"
        " const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
        " set.call(i, 'relative/path');"
        " i.dispatchEvent(new Event('input', { bubbles: true })); })()"
    )
    time.sleep(0.4)
    check("a relative directory is refused before the machine sees it",
          js("!!document.querySelector('[data-testid=agent-new-start]')?.disabled"))
    js(
        "(() => { const i = document.querySelector('[data-testid=agent-new-cwd]');"
        " const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
        f" set.call(i, {os.environ.get('HOME', '/root') + '/.codex'!r});"
        " i.dispatchEvent(new Event('input', { bubbles: true })); })()"
    )
    time.sleep(0.4)
    shot("agentload-new")
    js("document.querySelector('[data-testid=agent-new-start]')?.click(); 1")
    time.sleep(3.0)
    pane = "\n".join(screen_text())
    check("the agent started where it was told",
          "cwd=" in pane and "/.codex" in pane, f"got {pane[-200:]!r}")
    shot("agentload-started")

    js("document.querySelector('[data-testid=toolbar-agents]')?.click(); 1")
    time.sleep(0.8)
    js("document.querySelector('[data-testid=agent-layout-rail]')?.click(); 1")
    time.sleep(0.6)
    shot("agentload-rail")


SCENARIOS = {
    "probe": scenario_probe,
    "size": scenario_size,
    "accents": scenario_accents,
    "clean": scenario_clean,
    "tab": scenario_tab,
    "picker": scenario_picker,
    "second": scenario_second,
    "clipboard": scenario_clipboard,
    "rightpaste": scenario_rightpaste,
    "rightcopy": scenario_rightcopy,
    "agents": scenario_agents,
    "agentload": scenario_agentload,
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
