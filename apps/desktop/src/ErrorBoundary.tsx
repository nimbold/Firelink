import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children?: ReactNode;
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
    console.error("Uncaught error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', color: 'red', backgroundColor: '#222', height: '100vh', width: '100vw', whiteSpace: 'pre-wrap', overflow: 'auto' }}>
          <h1>Something went wrong.</h1>
          <p>{this.state.error?.toString()}</p>
          <hr />
          <p>{this.state.errorInfo?.componentStack}</p>
        </div>
      );
    }

    return this.props.children;
  }
}
