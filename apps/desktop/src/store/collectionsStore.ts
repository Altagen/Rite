/**
 * Collections Store
 *
 * Manages connection collections (folders) for organizing connections
 */

import { create } from 'zustand';

export interface Collection {
  id: string;
  name: string;
  color?: string;
  createdAt: number;
}

interface CollectionsState {
  collections: Collection[];
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchCollections: () => Promise<void>;
  createCollection: (name: string, color?: string) => Promise<Collection>;
  updateCollection: (id: string, name: string, color?: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
}

// Load collections from localStorage (since it's just UI organization)
const STORAGE_KEY = 'rite_collections';

const loadCollections = (): Collection[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to load collections:', error);
    return [];
  }
};

const saveCollections = (collections: Collection[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
  } catch (error) {
    console.error('Failed to save collections:', error);
  }
};

export const useCollectionsStore = create<CollectionsState>((set, get) => ({
  collections: loadCollections(),
  isLoading: false,
  error: null,

  fetchCollections: async () => {
    set({ isLoading: true, error: null });
    try {
      const collections = loadCollections();
      set({ collections, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch collections',
        isLoading: false
      });
    }
  },

  createCollection: async (name: string, color?: string) => {
    set({ isLoading: true, error: null });
    try {
      const newCollection: Collection = {
        id: crypto.randomUUID(),
        name,
        color,
        createdAt: Date.now(),
      };

      const collections = [...get().collections, newCollection];
      saveCollections(collections);
      set({ collections, isLoading: false });

      return newCollection;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to create collection',
        isLoading: false
      });
      throw error;
    }
  },

  updateCollection: async (id: string, name: string, color?: string) => {
    set({ isLoading: true, error: null });
    try {
      const collections = get().collections.map(c =>
        c.id === id ? { ...c, name, color } : c
      );
      saveCollections(collections);
      set({ collections, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to update collection',
        isLoading: false
      });
      throw error;
    }
  },

  deleteCollection: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const collections = get().collections.filter(c => c.id !== id);
      saveCollections(collections);
      set({ collections, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete collection',
        isLoading: false
      });
      throw error;
    }
  },
}));
