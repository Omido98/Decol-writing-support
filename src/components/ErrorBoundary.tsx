import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * The last line of defence for render-time crashes: without a boundary an
 * uncaught error unmounts the whole React root, leaving a blank window
 * with no way back. This shows the error and offers a reload instead.
 *
 * Event-handler and async failures are NOT caught here (React boundaries
 * only see render/lifecycle errors) — those are surfaced by their own
 * actions.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("The interface crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center h-screen w-screen gap-3 px-8 text-center bg-background"
      >
        <p className="text-text-primary text-sm font-medium">
          Something went wrong while drawing the interface.
        </p>
        <p className="text-text-muted text-xs max-w-[70ch] break-words">
          {this.state.error.message}
        </p>
        <p className="text-text-muted text-xs max-w-[60ch]">
          Reload the window to continue. Your stored data was not affected.
        </p>
        <Button
          size="sm"
          className="bg-primary hover:bg-primary/80 text-primary-foreground mt-2"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    );
  }
}
