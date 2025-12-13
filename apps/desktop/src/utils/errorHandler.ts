/**
 * Centralized Error Handling System
 *
 * Provides consistent error handling, logging, and user notifications
 * across the application.
 */

// Error severity levels
export enum ErrorSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  FATAL = 'fatal',
}

// Error categories for better tracking
export enum ErrorCategory {
  NETWORK = 'network',
  AUTH = 'auth',
  TERMINAL = 'terminal',
  FILE_SYSTEM = 'file_system',
  DATABASE = 'database',
  VALIDATION = 'validation',
  UNKNOWN = 'unknown',
}

export interface AppError {
  message: string;
  severity: ErrorSeverity;
  category: ErrorCategory;
  originalError?: Error | unknown;
  context?: Record<string, unknown>;
  timestamp: number;
  stack?: string;
}

class ErrorHandler {
  private errors: AppError[] = [];
  private readonly MAX_ERRORS = 100; // Keep last 100 errors
  private errorCallbacks: Set<(error: AppError) => void> = new Set();

  /**
   * Register a callback to be notified of errors
   */
  onError(callback: (error: AppError) => void): () => void {
    this.errorCallbacks.add(callback);
    // Return unsubscribe function
    return () => this.errorCallbacks.delete(callback);
  }

  /**
   * Handle an error with proper logging and notification
   */
  handle(
    message: string,
    options: {
      severity?: ErrorSeverity;
      category?: ErrorCategory;
      originalError?: Error | unknown;
      context?: Record<string, unknown>;
      silent?: boolean; // Don't notify user
    } = {}
  ): AppError {
    const {
      severity = ErrorSeverity.ERROR,
      category = ErrorCategory.UNKNOWN,
      originalError,
      context,
      silent = false,
    } = options;

    const appError: AppError = {
      message,
      severity,
      category,
      originalError,
      context,
      timestamp: Date.now(),
      stack: originalError instanceof Error ? originalError.stack : undefined,
    };

    // Store error
    this.errors.push(appError);
    if (this.errors.length > this.MAX_ERRORS) {
      this.errors.shift(); // Remove oldest
    }

    // Log to console with appropriate level
    this.logToConsole(appError);

    // Notify callbacks (e.g., Toast notifications) unless silent
    if (!silent) {
      this.errorCallbacks.forEach((callback) => callback(appError));
    }

    return appError;
  }

  /**
   * Log error to console with appropriate formatting
   */
  private logToConsole(error: AppError): void {
    const prefix = `[${error.category.toUpperCase()}]`;
    const timestamp = new Date(error.timestamp).toISOString();

    switch (error.severity) {
      case ErrorSeverity.INFO:
        console.log(`${prefix} ${timestamp}:`, error.message, error.context || '');
        break;
      case ErrorSeverity.WARNING:
        console.warn(`${prefix} ${timestamp}:`, error.message, error.context || '');
        break;
      case ErrorSeverity.ERROR:
        console.error(`${prefix} ${timestamp}:`, error.message, error.context || '');
        if (error.originalError) {
          console.error('Original error:', error.originalError);
        }
        break;
      case ErrorSeverity.FATAL:
        console.error(`${prefix} FATAL ${timestamp}:`, error.message, error.context || '');
        if (error.stack) {
          console.error('Stack trace:', error.stack);
        }
        break;
    }
  }

  /**
   * Get all errors
   */
  getErrors(filter?: {
    severity?: ErrorSeverity;
    category?: ErrorCategory;
    since?: number; // timestamp
  }): AppError[] {
    let filtered = this.errors;

    if (filter) {
      if (filter.severity) {
        filtered = filtered.filter((e) => e.severity === filter.severity);
      }
      if (filter.category) {
        filtered = filtered.filter((e) => e.category === filter.category);
      }
      if (filter.since !== undefined) {
        filtered = filtered.filter((e) => e.timestamp >= filter.since!);
      }
    }

    return filtered;
  }

  /**
   * Clear error history
   */
  clearErrors(): void {
    this.errors = [];
  }

  /**
   * Get error statistics
   */
  getStats(): {
    total: number;
    bySeverity: Record<ErrorSeverity, number>;
    byCategory: Record<ErrorCategory, number>;
  } {
    const bySeverity = {
      [ErrorSeverity.INFO]: 0,
      [ErrorSeverity.WARNING]: 0,
      [ErrorSeverity.ERROR]: 0,
      [ErrorSeverity.FATAL]: 0,
    };

    const byCategory = {
      [ErrorCategory.NETWORK]: 0,
      [ErrorCategory.AUTH]: 0,
      [ErrorCategory.TERMINAL]: 0,
      [ErrorCategory.FILE_SYSTEM]: 0,
      [ErrorCategory.DATABASE]: 0,
      [ErrorCategory.VALIDATION]: 0,
      [ErrorCategory.UNKNOWN]: 0,
    };

    this.errors.forEach((error) => {
      bySeverity[error.severity]++;
      byCategory[error.category]++;
    });

    return {
      total: this.errors.length,
      bySeverity,
      byCategory,
    };
  }
}

// Global singleton instance
export const errorHandler = new ErrorHandler();

/**
 * Helper to extract meaningful error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'Unknown error occurred';
}

/**
 * Helper to safely execute async operations with error handling
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  options: {
    errorMessage: string;
    category?: ErrorCategory;
    fallback?: T;
    silent?: boolean;
  }
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    errorHandler.handle(options.errorMessage, {
      category: options.category || ErrorCategory.UNKNOWN,
      originalError: error,
      silent: options.silent,
    });
    return options.fallback;
  }
}
