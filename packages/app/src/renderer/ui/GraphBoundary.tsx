import { Component, type ReactNode } from 'react';

/**
 * Around the graph view (F4 of the final review): an error thrown while it renders or in one of its effects shows a
 * message in its place, the tabs still there, instead of a blank window. Another tab shown (`plan`) tries again.
 */
export class GraphBoundary extends Component<{ plan: string; children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(e: unknown): { error: string } {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  componentDidUpdate(prev: { plan: string }): void {
    if (this.state.error !== null && prev.plan !== this.props.plan) this.setState({ error: null });
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="graph">
        <div className="placeholder">Le graphe ne peut pas être affiché ({this.state.error}) : choisissez un autre onglet, ou relancez Cirrus.</div>
      </div>
    );
  }
}
