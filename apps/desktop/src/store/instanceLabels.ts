/**
 * The instance vocabulary: the label words declared above the collections.
 *
 * ONE SCOPE, TWO SUPPORTS, and the server picks — on an instance it is a plaintext row
 * every member reads, on a local vault a document sealed under the master key, because
 * there the only reader is the owner. The client sends and receives a list of words and
 * never learns which support answered, which is right: the decision belongs to the side
 * holding the key.
 *
 * A LOCAL VAULT HAS THIS SCOPE. It has no organisation and no administrator, but it is an
 * instance of Rite with collections under it, so a word declared once does not have to be
 * redeclared in each one — which is the whole reason this exists rather than letting each
 * collection carry its own list only.
 *
 * Read once, when something first needs the vocabulary. Nothing else in the app does, so
 * reading it at startup would be a request for a list most sessions never look at.
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { acceptedVocab, formatVocab, type VocabWord } from './labelsFormat';

/** Where the list is kept, as the server reported it. `locked` ⇒ a write will be refused. */
export type LabelsSupport = 'instance' | 'vault' | 'file' | 'locked';

interface InstanceLabelsState {
  /** The declared words, each with the colour somebody chose for it when there is one. */
  words: VocabWord[];
  /**
   * Which support answered.
   *
   * SAID BY THE SERVER RATHER THAN INFERRED, because `locked` and `nothing declared yet`
   * both arrive as an empty list — and a Save button drawn over the first can only fail.
   * That shipped once, as a 409 in a window with no master password.
   */
  support: LabelsSupport | null;
  loaded: boolean;
  /** Set when the last read or write failed, so a screen can say so rather than show none. */
  error: string | null;
  load: () => Promise<void>;
  /** Declare the whole list. A list replaces; writing is refused to a non-admin instance-side. */
  save: (words: VocabWord[]) => Promise<void>;
}

export const useInstanceLabels = create<InstanceLabelsState>((set) => ({
  words: [],
  support: null,
  loaded: false,
  error: null,

  load: async () => {
    try {
      const { labels, support } = await Backend.Labels.get();
      set({ words: acceptedVocab(labels), support, loaded: true, error: null });
    } catch (e) {
      // Loaded, with nothing: a vocabulary that could not be read is not an empty one, but
      // the screens that offer words must still draw. The error is kept so the editor can
      // say why rather than look like a list nobody has filled in.
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  save: async (words) => {
    const next = acceptedVocab(words);
    try {
      // Written in the two shapes: a word with no colour goes out bare, so a list nobody
      // has coloured round-trips exactly as it was stored.
      await Backend.Labels.set(formatVocab(next));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    // Written first, then held: a word that did not reach its support must not be on
    // screen as though it had — the same order the marks store keeps.
    set({ words: next, error: null, loaded: true });
  },
}));
