import { Component, type ReactNode } from 'react';

/**
 * Around each floating panel, and around the full screen (ruling of the final review, « rien ne plante »): an error
 * thrown while it renders, or in one of its effects, shows `fallback` in its place — the panel's frame, which still
 * moves and closes, with a French sentence in its body —, its cause in the console (`what` names the panel). The
 * window, the graph and the other panels stay, where a root left without a boundary would be unmounted whole. A
 * panel opened again is a new one, which tries again.
 */
export class PanelBoundary extends Component<{ what: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(e: unknown): void {
    console.error(`${this.props.what} :`, e);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
