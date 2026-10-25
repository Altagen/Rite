/**
 * Bench agent. Served only from a bench build, never from the shipped bundle.
 *
 * It polls the driver for one JavaScript expression at a time, evaluates it in the page,
 * and posts the result back. Everything the driver needs to know about the page — what is
 * painted, how many columns xterm computed, whether a button exists — is a one-line
 * expression, so the agent itself stays this small.
 */
(() => {
  const BASE = 'http://127.0.0.1:9931';
  const say = (path, body) =>
    fetch(BASE + path, { method: 'POST', body }).catch(() => {});

  const run = async (src) => {
    // Indirect eval: the expression runs in global scope, so it can reach the page's own
    // globals rather than this closure.
    const value = await (0, eval)(src);
    return value === undefined ? null : value;
  };

  const loop = async () => {
    for (;;) {
      let cmd = null;
      try {
        const r = await fetch(BASE + '/cmd');
        cmd = await r.json();
      } catch {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (!cmd || !cmd.id) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      let out;
      try {
        out = { id: cmd.id, ok: true, value: await run(cmd.js) };
      } catch (e) {
        out = { id: cmd.id, ok: false, value: String(e && e.message ? e.message : e) };
      }
      await say('/res', JSON.stringify(out));
    }
  };

  say('/hello', location.href);
  loop();
})();
