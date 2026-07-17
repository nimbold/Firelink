import { Component, ErrorInfo, ReactNode } from 'react';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({
      error,
      errorInfo
    });
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-bg-primary text-text-primary p-8 overflow-auto">
          <div className="max-w-2xl w-full bg-bg-secondary p-6 rounded-lg border border-red-900/50 shadow-2xl">
            <div className="flex items-center gap-3 mb-4 text-red-500">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h1 className="text-xl font-bold">{i18n.t($ => $.dialogs.errorBoundary.title)}</h1>
            </div>
            <div className="text-sm text-text-secondary mb-6">
              {i18n.t($ => $.dialogs.errorBoundary.description)}
            </div>
            <div className="bg-black/50 p-4 rounded text-xs font-mono text-red-300 overflow-x-auto mb-4">
              {this.state.error && this.state.error.toString()}
              <br />
              {this.state.errorInfo && this.state.errorInfo.componentStack}
            </div>
            <button
              className="app-button px-4 py-2 bg-red-600/20 text-red-400 border border-red-600/50 hover:bg-red-600/30 transition-colors rounded"
              onClick={() => window.location.reload()}
            >
              {i18n.t($ => $.dialogs.errorBoundary.reload)}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
