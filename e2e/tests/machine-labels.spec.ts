import { test, expect } from '@playwright/test';
import { ensureCollection, createMachine } from './support/localVault';

/**
 * Labels on a machine, through the sealed item they live inside (ADR 0016, ADR 0011).
 *
 * WHAT THIS HOLDS THAT A UNIT CHECK CANNOT. The words go into the collection's item, which
 * rite-core encrypts under that collection's items key — so a label round-tripping is the
 * whole chain working: serialised into the record, sealed, stored, unsealed, deserialised.
 * `#[serde(default)]` makes the field additive, and the first case here is the one that
 * proves it: a machine created without labels comes back with none rather than failing to
 * decrypt.
 *
 * THE SCOPE GOVERNS THE VOCABULARY, NEVER THE ASSIGNMENT, and that is why this test is
 * about a machine rather than about a word list. Even an org-wide word — public, in the
 * clear, shared by the whole instance — is sealed HERE once it is put on a machine: which
 * machine wears it is readable only by this collection's members.
 */
test('a machine carries labels, sealed with the rest of its record', async ({ request }) => {
  const collection = await ensureCollection(request, 'e2e-labels');

  // Additive: a record written without the field reads as carrying no labels.
  const bare = await createMachine(request, collection, { name: 'e2e-label-bare' });
  const listed = async () =>
    (await (await request.get(`/api/local/collections/${collection}/machines`)).json()) as {
      id: string;
      name: string;
      labels: string[];
    }[];
  expect((await listed()).find((m) => m.id === bare)?.labels).toEqual([]);

  // A patch carries them whole — a list REPLACES rather than merges, because a merge has
  // no way to say "take that one off".
  const put = await request.put(`/api/local/collections/${collection}/machines/${bare}`, {
    data: { labels: ['api', 'PCI'] },
  });
  expect(put.status()).toBe(200);
  expect((await listed()).find((m) => m.id === bare)?.labels).toEqual(['api', 'PCI']);

  // The case that was typed is what comes back: folding happens when words are compared,
  // never when they are stored.
  const replaced = await request.put(`/api/local/collections/${collection}/machines/${bare}`, {
    data: { labels: ['PCI'] },
  });
  expect(replaced.status()).toBe(200);
  expect((await listed()).find((m) => m.id === bare)?.labels).toEqual(['PCI']);

  // And an edit that touches something else leaves them alone: absent keeps what is
  // stored, which is the rule every field on that patch follows.
  await request.put(`/api/local/collections/${collection}/machines/${bare}`, {
    data: { name: 'e2e-label-renamed' },
  });
  const after = (await listed()).find((m) => m.id === bare);
  expect(after?.name).toBe('e2e-label-renamed');
  expect(after?.labels).toEqual(['PCI']);

  // Emptying the list is a real state and not "keep what is there".
  await request.put(`/api/local/collections/${collection}/machines/${bare}`, {
    data: { labels: [] },
  });
  expect((await listed()).find((m) => m.id === bare)?.labels).toEqual([]);
});

/**
 * The vocabulary a collection DECLARES, which is not the same thing as the words its
 * machines wear.
 *
 * Declared, so a word can be agreed on before anything carries it — and sealed in the
 * collection's header under its meta key, which is a different key from the one the
 * machines ride. So this is the scope a sensitive word goes in: read by this collection's
 * members and nobody else, and it never travels up to the instance.
 */
test('a collection declares a vocabulary, in the same sealed header as its name', async ({
  request,
}) => {
  const collection = await ensureCollection(request, 'e2e-vocab');
  const read = async () =>
    (
      (await (await request.get('/api/local/collections')).json()) as {
        id: string;
        name: string;
        folders: unknown[];
        labels: string[];
      }[]
    ).find((c) => c.id === collection)!;

  // Additive: a header written before the field reads as declaring nothing.
  expect((await read()).labels).toEqual([]);

  const put = await request.put(`/api/local/collections/${collection}`, {
    data: { name: 'e2e-vocab', color: null, labels: ['pci', 'prod'] },
  });
  expect(put.status()).toBe(200);
  expect((await read()).labels).toEqual(['pci', 'prod']);

  // A RENAME MUST NOT DROP THEM. They share one blob with the name, the colour and the
  // folders, so the read-modify-write has to keep what the caller did not send — which is
  // exactly the bug that this shape invites.
  await request.put(`/api/local/collections/${collection}`, {
    data: { name: 'e2e-vocab-renamed', color: null },
  });
  const after = await read();
  expect(after.name).toBe('e2e-vocab-renamed');
  expect(after.labels).toEqual(['pci', 'prod']);

  // And a list replaces, down to empty.
  await request.put(`/api/local/collections/${collection}`, {
    data: { name: 'e2e-vocab-renamed', color: null, labels: [] },
  });
  expect((await read()).labels).toEqual([]);
});

/**
 * The vocabulary declared ABOVE the collections, on the support a local vault gives it.
 *
 * A LOCAL VAULT HAS THIS SCOPE, which is the whole point of the row: it has no
 * organisation and no administrator, but it is an instance of Rite with collections under
 * it — so a word declared once must not have to be redeclared in each one. The only reader
 * there is the owner, so it is sealed under the master key like their marks. On a server
 * the same pair of routes answers from a plaintext row, because there every member reads
 * it and sealing it under a key they all hold would buy a rotation path and no secrecy.
 *
 * `e2e/layouts-policy-check.mjs` holds the server's half against a real accounts server;
 * this is the vault's.
 */
test('a local vault declares words above its collections, sealed', async ({ request }) => {
  const read = async () =>
    ((await (await request.get('/api/labels')).json()) as { labels: string[] }).labels;

  // FROM A KNOWN STATE, NOT FROM A FRESH ONE. This spec shares one server and one vault
  // with every other, so "nothing declared yet" is an assertion about which file ran
  // first — it passed alone and failed beside `instance-labels.spec.ts`, which declares
  // words through the screen. Clearing and reading back is the same claim without the
  // dependency: an empty list is a real state the route can be put into.
  await request.put('/api/admin/labels', { data: { labels: [] } });
  expect(await read()).toEqual([]);

  const put = await request.put('/api/admin/labels', {
    data: { labels: ['pci', 'prod', 'eu-west'] },
  });
  expect(put.status()).toBe(204);
  expect(await read()).toEqual(['pci', 'prod', 'eu-west']);

  // THE SERVER VALIDATES TOO, because the client is not the boundary: this route takes a
  // list from whoever reached it. The first spelling is kept, blanks go, and a word longer
  // than the cap is cut — the same rules the field applies, in the other language.
  await request.put('/api/admin/labels', {
    data: { labels: ['API', '  api  ', '', '   ', 'x'.repeat(40), 'a  b'] },
  });
  expect(await read()).toEqual(['API', 'x'.repeat(24), 'a b']);

  // A list replaces, down to empty.
  await request.put('/api/admin/labels', { data: { labels: [] } });
  expect(await read()).toEqual([]);
});

/**
 * The support the route picks when no master password has ever been set.
 *
 * THE CASE THAT SHIPPED BROKEN. The reasoning behind its absence was wrong twice: "no
 * vault means no collections, which means nothing to label" forgets that a CONVERSATION
 * is labelled in that context too — its marks go to a file on the device (ADR 0022 §6) —
 * and a screen must not draw a Save button that can only answer 409.
 *
 * So the three supports are the three marks already have, and this is the third: a file
 * on the person's own machine, because nothing exists to seal with. Not a weaker choice,
 * the only one.
 *
 * This suite runs with a vault set up, so what it holds is the other half — that the route
 * SAYS which support answered, which is what lets the screen tell a locked vault from a
 * list nobody has filled in. Both arrive as an empty list, and a Save over the first can
 * only fail.
 */
test('the route says which support answered, so a screen can tell empty from locked', async ({
  request,
}) => {
  const got = await request.get('/api/labels');
  expect(got.status()).toBe(200);
  const body = (await got.json()) as { labels: string[]; support: string };
  // This suite has a vault and it is unlocked, so the list is sealed under its master key.
  expect(body.support).toBe('vault');
  expect(Array.isArray(body.labels)).toBe(true);
});

/**
 * A colour belongs to the WORD, and the server keeps the two stored shapes.
 *
 * `pci` is red on every machine and in every collection that can see the word, which is
 * the only reason a colour is worth scanning a grid for. So it is declared beside the word
 * in a vocabulary — never per use, which would give one word several colours — and a
 * machine's own `labels` stay plain strings, with no migration.
 *
 * A word nobody coloured is written as a BARE STRING, exactly as it was before colours
 * existed. That is what keeps the shape additive and what this test holds on the wire: an
 * uncoloured list round-trips byte for byte, and only a coloured word becomes an object.
 */
test('a vocabulary declares a colour per word, and writes the two shapes', async ({ request }) => {
  const read = async () =>
    (
      (await (await request.get('/api/labels')).json()) as {
        labels: (string | { label: string; color?: string })[];
      }
    ).labels;

  await request.put('/api/admin/labels', {
    data: { labels: ['pci', { label: 'prod', color: '#7c9cf5' }] },
  });
  // The uncoloured word came back bare; only the coloured one is an object.
  expect(await read()).toEqual(['pci', { label: 'prod', color: '#7c9cf5' }]);

  // THE SERVER VALIDATES THE COLOUR'S SHAPE, not the palette: the nine swatches are the
  // client's, and a tenth copy of those hexes here is what the swatch check exists to
  // stop. A colour that is not `#rrggbb` is dropped and the word kept — the word is the
  // declaration, the colour is a decoration on it.
  await request.put('/api/admin/labels', {
    data: {
      labels: [
        { label: 'a', color: 'red' },
        { label: 'b', color: '#abc' },
        { label: 'c', color: '#AbCdEf' },
      ],
    },
  });
  expect(await read()).toEqual(['a', 'b', { label: 'c', color: '#AbCdEf' }]);

  // And clearing a colour turns the word back into a string, rather than leaving an object
  // with nothing in it.
  await request.put('/api/admin/labels', { data: { labels: [{ label: 'c' }] } });
  expect(await read()).toEqual(['c']);
});

/**
 * The same two shapes in a collection's own header, through the same cleaner.
 *
 * One route must not accept what the other refuses: a word declared in a collection could
 * otherwise carry a colour the instance list would have dropped, and the same word would
 * then look different depending on which list a reader found it in.
 */
test('a collection declares colours too, validated the same way', async ({ request }) => {
  const collection = await ensureCollection(request, 'e2e-vocab-colour');
  const read = async () =>
    (
      (await (await request.get('/api/local/collections')).json()) as {
        id: string;
        labels: (string | { label: string; color?: string })[];
      }[]
    ).find((c) => c.id === collection)!.labels;

  await request.put(`/api/local/collections/${collection}`, {
    data: {
      name: 'e2e-vocab-colour',
      color: null,
      labels: [
        { label: 'client-acme', color: '#f7768e' },
        'internal',
        { label: 'x', color: 'nope' },
      ],
    },
  });
  expect(await read()).toEqual([{ label: 'client-acme', color: '#f7768e' }, 'internal', 'x']);
});
