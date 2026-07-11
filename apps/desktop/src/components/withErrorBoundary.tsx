/**
 * withErrorBoundary HOC
 *
 * Wraps a functional component in an {@link ErrorBoundary}. Kept in its own
 * file so that ErrorBoundary.tsx only exports components (React Fast Refresh
 * requirement).
 */

import React from 'react';
import { ErrorBoundary, ErrorBoundaryProps } from './ErrorBoundary';

export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>
): React.FC<P> {
  const WrappedComponent: React.FC<P> = (props) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <Component {...props} />
    </ErrorBoundary>
  );

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name || 'Component'})`;

  return WrappedComponent;
}
