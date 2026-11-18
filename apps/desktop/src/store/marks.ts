/**
 * The names a person gave to conversations (ADR 0022 §6).
 *
 * A DOCUMENT OF ITS OWN, and that is the decision this file exists to carry. Marks were
 * in the workspace document for one release, which is where the mock put them, and the
 * reason to move was not size:
 *
 *   - A MARK ROTS AND A LAYOUT DOES NOT. It is keyed to a conversation id on a machine,
 *     and a vendor's tool rotates those away — Codex files one rollout per launch and
 *     Claude one per project. So marks accumulate dead entries, and the only way to know
 *     which is to probe that machine again. Rite may prune a document it owns; it must
 *     not prune a person's configuration file, so the two cannot share one.
 *   - FIFTY MARKS IN A FILE WHOSE USEFUL CONTENT IS THIRTY LINES buries the part that is
 *     read and edited.
 *   - And one parse error took both down: a `[[mark]]` nobody could write by hand still
 *     sat in the same document as the layout that opens in the morning.
 *
 * TWO SUPPORTS, AND NEITHER IS A FILE: the vault's own sealed document, or a blob sealed
 * under the user's key that a server stores and cannot read. The support is decided by the
 * context and not by a preference, so there is no gate here.
 *
 * AND WITH NO VAULT, NO SUPPORT AT ALL. It was a JSON file on the device for one
 * unreleased cycle, which made this the only place Rite wrote a person's own annotations
 * in the clear — a labelled conversation names a project and a customer. The binary
 * executes; the vault remembers. An agent is still found, read and resumed without one;
 * it cannot be named or labelled, because there is nowhere honest to keep that.
 *
 * NO POLICY. An instance governs whether Rite generates traffic on a user's behalf
 * (`agent_policy`); a label somebody wrote on their own screen is not that, and an
 * administrator who could delete it would be editing someone's filing system.
 *
 * JSON, because nobody edits this one by hand. That removes a parser, a block walk and
 * every syntax error they can produce — the workspace document is TOML because people
 * read it, and this is the opposite case.
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { useServerSession } from './serverSessionStore';
import { encryptString, decryptString } from '../utils/vaultCrypto';
import { acceptedMarks, formatMarks, withMark, type Mark } from './marksFormat';

export type { Mark };

/** A document that is not JSON at all is nothing held, not a crash. */
function read(text: string): Mark[] {
  try {
    return acceptedMarks(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Seal and unseal with the same primitives as the layouts blob and the library tree. */
const unseal = async (key: Uint8Array, blob: string): Promise<string> =>
  new TextDecoder().decode(await decryptString(key, blob));
const seal = (key: Uint8Array, text: string): Promise<string> =>
  encryptString(key, new TextEncoder().encode(text));

interface MarksState {
  marks: Mark[];
  loaded: boolean;
  /**
   * Which support answered, or `null` when there is none — which is a window with no
   * vault, and the signal every screen uses to offer no enrichment rather than to offer
   * one that cannot be kept.
   */
  support: 'vault' | 'account' | null;
  load: () => Promise<void>;
  /** Name a conversation, or take its name away by passing `null`. */
  set: (mark: Mark | (Omit<Mark, 'name' | 'color'> & { name: null })) => Promise<void>;
}

export const useMarks = create<MarksState>((set, get) => ({
  marks: [],
  loaded: false,
  support: null,

  load: async () => {
    const { userKey } = useServerSession.getState();
    // The account first, and only when there is a key to open it with: a window signed
    // into an instance has no file to read, and one that has not unlocked yet has
    // nothing it could decrypt.
    if (userKey) {
      try {
        const row = await Backend.UserMarks.get();
        const text = row.blob ? await unseal(userKey, row.blob) : '';
        set({ marks: text ? read(text) : [], loaded: true, support: 'account' });
        return;
      } catch {
        // A blob that will not open is not an empty one: leaving what is held alone
        // beats replacing a person's names with nothing.
        set({ loaded: true, support: 'account' });
        return;
      }
    }
    try {
      const file = await Backend.Marks.get();
      // `null` is the route saying there is no support here, which an empty document is
      // not: a fresh vault answers with `''`. Told apart, because one means "nothing named
      // yet" and the other means "naming is not available at all".
      if (file.text === null || file.text === undefined) {
        set({ marks: [], loaded: true, support: null });
        return;
      }
      set({ marks: file.text ? read(file.text) : [], loaded: true, support: 'vault' });
    } catch {
      set({ loaded: true, support: null });
    }
  },

  set: async (mark) => {
    const { userKey } = useServerSession.getState();
    // REFUSED HERE AND NOT ONLY ON SCREEN. The manager offers no way to reach this
    // without a vault, and a store that would have written anyway is one route away from
    // putting a person's annotation somewhere it cannot be sealed.
    if (!userKey && get().support === null) {
      throw new Error('marks: no vault to keep this in');
    }
    const next = withMark(get().marks, mark);
    const text = formatMarks(next);
    if (userKey) await Backend.UserMarks.set(await seal(userKey, text));
    else await Backend.Marks.put(text);
    // Written first, then held: a name that failed to reach its support must not be on
    // screen as though it had.
    set({ marks: next, support: userKey ? 'account' : 'vault' });
  },
}));
