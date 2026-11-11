import { test, expect } from '@playwright/test';

/**
 * Where the marks document is kept, in a context that has a local vault (ADR 0022 §6).
 *
 * THE SUPPORT IS DECIDED BY WHERE THE KEY IS, never by a preference. This suite drives a
 * local vault, which is one of the three rows and the one that was wrong: a mark went to a
 * sealed blob on a server account and to a JSON file in the clear everywhere else —
 * including here, where the master key exists and the process is holding it. A local vault
 * IS a vault, and a labelled conversation names a project and a customer.
 *
 * What makes it observable without reading the database: `path` is where a file support
 * would have answered from, and null when it is not one. So a vault answering `path: null`
 * with text that round-trips is the whole claim — the document is kept somewhere that is
 * not a file, and only the key that sealed it can read it back.
 *
 * THE OTHER ROW IS IN RUST, because no Playwright project can reach a window with no
 * vault: this suite's own is created by `smoke.spec.ts` before anything else runs.
 * `a_window_with_no_vault_keeps_no_marks_and_no_words` in `packages/rite-server/src/lib.rs`
 * holds it — a read answers null and a write is refused, rather than a JSON file landing
 * in the clear beside the binary (ADR 0022 §6, as 0.2.9 amends it).
 */
test('a local vault seals its own marks, and writes no file', async ({ request }) => {
  const doc = JSON.stringify({
    version: 1,
    marks: [{ machine: '@local', tool: 'claude', id: 'c-1', name: 'the port', labels: ['api'] }],
  });

  const put = await request.put('/api/marks', { data: { value: doc } });
  expect(put.status()).toBe(204);

  const got = await request.get('/api/marks');
  expect(got.status()).toBe(200);
  const body = await got.json();
  // It came back, so it was sealed and unsealed with the vault's key.
  expect(body.text).toBe(doc);
  // And NOT from the file: a path here would mean the plaintext support answered, which is
  // the row this closes.
  expect(body.path).toBeNull();

  // A second write replaces rather than appends — one row per document, last write wins,
  // which is the same bargain the account's blob makes.
  const second = JSON.stringify({ version: 1, marks: [] });
  expect((await request.put('/api/marks', { data: { value: second } })).status()).toBe(204);
  expect((await (await request.get('/api/marks')).json()).text).toBe(second);
});
