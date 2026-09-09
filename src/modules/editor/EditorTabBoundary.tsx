import { Component, type ReactNode } from "react";

type Props = {
  path: string;
  onReturnToChat: () => void;
  children: ReactNode;
};

export class EditorTabBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-start justify-center gap-2 px-6 text-sm">
        <p className="text-destructive">Could not open editor: {this.props.path}</p>
        <p className="text-xs text-muted-foreground">{String(this.state.error)}</p>
        <button type="button" className="rounded border border-border px-3 py-1" onClick={this.props.onReturnToChat}>
          Return to chat
        </button>
      </div>
    );
  }
}
