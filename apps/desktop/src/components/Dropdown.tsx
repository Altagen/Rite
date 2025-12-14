/**
 * Dropdown Component
 *
 * Reusable dropdown component with custom options
 */

import { useRef, useEffect } from 'react';

export interface DropdownOption<T = string | number> {
  label: string;
  value: T;
}

interface DropdownProps<T = string | number> {
  label?: string;
  selectedLabel: string;
  options: DropdownOption<T>[];
  onSelect: (value: T) => void;
  isOpen: boolean;
  onToggle: () => void;
  className?: string;
}

export function Dropdown<T = string | number>({
  label,
  selectedLabel,
  options,
  onSelect,
  isOpen,
  onToggle,
  className = '',
}: DropdownProps<T>) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        if (isOpen) {
          onToggle();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onToggle]);

  return (
    <div ref={dropdownRef} className={className}>
      {label && <label className="mb-1 block text-sm font-medium">{label}</label>}
      <div className="relative">
        <button
          type="button"
          onClick={onToggle}
          className="w-full rounded border border-border bg-input px-3 py-2 text-left text-foreground focus:border-primary focus:outline-none flex justify-between items-center"
        >
          <span>{selectedLabel}</span>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Dropdown Menu */}
        {isOpen && (
          <div className="absolute z-10 mt-1 w-full rounded border border-border bg-background shadow-lg divide-y divide-border">
            {options.map((option, index) => (
              <button
                key={index}
                type="button"
                onClick={() => {
                  onSelect(option.value);
                  onToggle();
                }}
                className="w-full px-3 py-2 text-left hover:bg-muted transition-colors"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
