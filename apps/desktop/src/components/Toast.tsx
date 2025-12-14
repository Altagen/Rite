/**
 * Toast Notification Component
 *
 * Simple, elegant toast notifications
 */

import { useEffect } from 'react';

interface ToastProps {
  message: string;
  type?: 'error' | 'success' | 'info';
  onClose: () => void;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function Toast({ message, type = 'error', onClose, duration = 4000, action }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const bgColor = type === 'error' ? 'bg-red-500/90' : type === 'success' ? 'bg-green-500/90' : 'bg-blue-500/90';
  const label = type === 'error' ? 'Error:' : type === 'success' ? 'Success:' : 'Info:';

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-1/2 animate-in slide-in-from-top-5 fade-in duration-300">
      <div className={`${bgColor} backdrop-blur-sm text-white px-4 py-2 shadow-lg flex items-center gap-3 border border-white/20 rounded-lg`}>
        <span className="text-sm font-bold uppercase tracking-wide">{label}</span>
        <p className="flex-1 text-sm font-medium">{message}</p>
        {action && (
          <button
            onClick={() => {
              action.onClick();
              onClose();
            }}
            className="bg-white/20 hover:bg-white/30 rounded px-3 py-1.5 text-xs font-semibold transition-colors"
          >
            {action.label}
          </button>
        )}
        <button
          onClick={onClose}
          className="hover:bg-white/20 rounded p-1 transition-colors"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
