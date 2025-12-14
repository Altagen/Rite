/**
 * Error Boundary Component
 *
 * Captures React component errors and prevents the entire app from crashing.
 * Integrates with the centralized error handler for logging and tracking.
 */

import React, { Component, ReactNode } from 'react';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, errorInfo: React.ErrorInfo, reset: () => void) => ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  level?: 'app' | 'feature' | 'component'; // For contextual error tracking
  name?: string; // Name of the boundary for better error context
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const { onError, level = 'component', name } = this.props;

    // Update state with error info
    this.setState({
      errorInfo,
    });

    // Log to centralized error handler
    errorHandler.handle(`React component error in ${name || 'unnamed boundary'}`, {
      severity: level === 'app' ? ErrorSeverity.FATAL : ErrorSeverity.ERROR,
      category: ErrorCategory.UNKNOWN,
      originalError: error,
      context: {
        boundaryLevel: level,
        boundaryName: name,
        componentStack: errorInfo.componentStack,
      },
    });

    // Call custom error handler if provided
    if (onError) {
      onError(error, errorInfo);
    }

    // Log to console for development
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
  }

  resetError = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    const { hasError, error, errorInfo } = this.state;
    const { children, fallback, level = 'component', name } = this.props;

    if (hasError && error) {
      // Use custom fallback if provided
      if (fallback) {
        return fallback(error, errorInfo!, this.resetError);
      }

      // Default fallback UI based on boundary level
      if (level === 'app') {
        return (
          <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
            <div className="max-w-2xl text-center">
              <div className="mb-6 flex justify-center">
                <div className="rounded-full bg-red-500/10 p-6">
                  <svg
                    className="h-16 w-16 text-red-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
              </div>
              <h1 className="mb-4 text-3xl font-bold text-foreground">
                Application Error
              </h1>
              <p className="mb-6 text-lg text-muted-foreground">
                The application encountered an unexpected error and needs to restart.
              </p>
              <details className="mb-6 rounded-lg bg-card p-4 text-left">
                <summary className="cursor-pointer font-medium text-foreground hover:text-primary">
                  Error Details
                </summary>
                <div className="mt-4 space-y-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Error:</p>
                    <p className="font-mono text-xs text-red-500">{error.message}</p>
                  </div>
                  {errorInfo?.componentStack && (
                    <div>
                      <p className="text-sm font-medium text-foreground">Component Stack:</p>
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
                        {errorInfo.componentStack}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Reload Application
              </button>
            </div>
          </div>
        );
      }

      // Feature-level error (less critical)
      if (level === 'feature') {
        return (
          <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card p-8 text-center">
            <div className="mb-4 rounded-full bg-yellow-500/10 p-4">
              <svg
                className="h-12 w-12 text-yellow-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-foreground">
              Feature Error
            </h3>
            <p className="mb-4 text-sm text-muted-foreground">
              This feature encountered an error: {error.message}
            </p>
            <button
              onClick={this.resetError}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Try Again
            </button>
          </div>
        );
      }

      // Component-level error (least critical)
      return (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <div className="flex-1">
              <h4 className="text-sm font-medium text-foreground">
                Component Error
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">
                {name || 'This component'} failed to render: {error.message}
              </p>
              <button
                onClick={this.resetError}
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}

/**
 * Hook version for functional components (wraps the class-based ErrorBoundary)
 */
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
