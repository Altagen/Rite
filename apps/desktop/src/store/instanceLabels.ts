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
import { acceptedVocabulary } from './labelsFormat';

interface InstanceLabelsState {
  words: string[];
  loaded: boolean;
  /** Set when the last read or write failed, so a screen can say so rather than show none. */
  error: string | null;
  load: () => Promise<void>;
  /** Declare the whole list. A list replaces; writing is refused to a non-admin instance-side. */
  save: (words: string[]) => Promise<void>;
}

export const useInstanceLabels = create<InstanceLabelsState>((set) => ({
  words: [],
  loaded: false,
  error: null,

  load: async () => {
    try {
      const { labels } = await Backend.Labels.get();
      set({ words: acceptedVocabulary(labels), loaded: true, error: null });
    } catch (e) {
      // Loaded, with nothing: a vocabulary that could not be read is not an empty one, but
      // the screens that offer words must still draw. The error is kept so the editor can
      // say why rather than look like a list nobody has filled in.
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  save: async (words) => {
    const next = acceptedVocabulary(words);
    try {
      await Backend.Labels.set(next);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    // Written first, then held: a word that did not reach its support must not be on
    // screen as though it had — the same order the marks store keeps.
    set({ words: next, error: null, loaded: true });
  },
}));
