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
