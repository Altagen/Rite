/**
 * Collections Manager Component
 *
 * Modal for managing connection collections
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useCollectionsStore, type Collection } from '../store/collectionsStore';

interface CollectionsManagerProps {
  onClose: () => void;
}

export function CollectionsManager({ onClose }: CollectionsManagerProps) {
  const { t } = useTranslation();
  const { collections, fetchCollections, createCollection, updateCollection, deleteCollection } = useCollectionsStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<Collection | null>(null);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const handleCreate = async () => {
    if (!newCollectionName.trim()) return;

    try {
      await createCollection(newCollectionName.trim());
      setNewCollectionName('');
    } catch (error) {
      console.error('Failed to create collection:', error);
    }
  };

  const handleUpdate = async (id: string) => {
    if (!editingName.trim()) return;

    try {
      await updateCollection(id, editingName.trim());
      setEditingId(null);
      setEditingName('');
    } catch (error) {
      console.error('Failed to update collection:', error);
    }
  };

  const handleDelete = async () => {
    if (!collectionToDelete) return;

    try {
      await deleteCollection(collectionToDelete.id);
      setShowDeleteConfirm(false);
      setCollectionToDelete(null);
    } catch (error) {
      console.error('Failed to delete collection:', error);
    }
  };

  const startEdit = (collection: Collection) => {
    setEditingId(collection.id);
    setEditingName(collection.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const confirmDeleteCollection = (collection: Collection) => {
    setCollectionToDelete(collection);
    setShowDeleteConfirm(true);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="mx-4 w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-2xl font-bold">{t('connections.collectionManage')}</h2>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('connections.cancel')}
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* New Collection Form */}
          <div className="mb-6 rounded border border-border p-4">
            <label className="mb-2 block text-sm font-medium">{t('connections.collectionNew')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleCreate()}
                placeholder={t('connections.collectionNamePlaceholder')}
                className="flex-1 rounded border border-border bg-input px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
              />
              <button
                onClick={handleCreate}
                className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('connections.collectionCreate')}
              </button>
            </div>
          </div>

          {/* Collections List */}
          <div className="space-y-2">
            {collections.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No collections yet. Create one above!
              </p>
            ) : (
              collections.map((collection) => (
                <div
                  key={collection.id}
                  className="flex items-center gap-2 rounded border border-border p-3"
                >
                  {editingId === collection.id ? (
                    <>
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleUpdate(collection.id)}
                        className="flex-1 rounded border border-border bg-input px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
                        autoFocus
                      />
                      <button
                        onClick={() => handleUpdate(collection.id)}
                        className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                        title="Save"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="rounded bg-secondary px-3 py-1 text-xs hover:bg-secondary/80"
                        title="Cancel"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-1 items-center gap-2">
                        {collection.color && (
                          <div
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: collection.color }}
                          />
                        )}
                        <span className="font-medium">{collection.name}</span>
                      </div>
                      <button
                        onClick={() => startEdit(collection)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Edit"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => confirmDeleteCollection(collection)}
                        className="rounded p-1 text-red-500 hover:bg-red-50 hover:text-red-600"
                        title="Delete"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Close Button */}
          <div className="mt-6 flex justify-end">
            <button
              onClick={onClose}
              className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80"
            >
              {t('connections.cancel')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      {showDeleteConfirm && collectionToDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
            <h2 className="mb-4 text-xl font-bold">{t('connections.delete')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Are you sure you want to delete the collection "{collectionToDelete.name}"?
            </p>
            <p className="mb-6 text-sm text-muted-foreground">
              Note: Connections in this collection will not be deleted, they will just become ungrouped.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setCollectionToDelete(null);
                }}
                className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80"
              >
                {t('connections.cancel')}
              </button>
              <button
                onClick={handleDelete}
                className="rounded bg-red-500 px-4 py-2 font-medium text-white hover:bg-red-600"
              >
                {t('connections.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
