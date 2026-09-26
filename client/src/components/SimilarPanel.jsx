import React from 'react';
import { StatusBadge, FlagList } from './Badges.jsx';
import { usd, shortTime } from '../format.js';

export default class SimilarPanel extends React.Component {
  constructor(props) {
    super(props);
    this.panelRef = React.createRef();
  }

  componentDidMount() {
    this.panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderBody() {
    const { state } = this.props;
    if (state.loading) {
      return (
        <div className="similar-grid">
          {[0, 1, 2].map((i) => (
            <div className="similar-card skeleton-card" key={i}>
              <span className="skeleton" />
              <span className="skeleton" />
              <span className="skeleton short" />
            </div>
          ))}
        </div>
      );
    }
    if (state.error) return <div className="banner banner-error">{state.error}</div>;
    if (!state.results.length) return <div className="muted">No other enriched exceptions to compare against yet.</div>;

    return (
      <div className="similar-grid">
        {state.results.map((r, i) => {
          const pct = Math.max(0, Math.round(r.similarity * 100));
          return (
            <article className="similar-card" key={r._id}>
              <header>
                <span className="rank">#{i + 1}</span>
                <span className="mono strong">{r.evidenceId}</span>
                <StatusBadge meta={{ status: 'COMPLETED', riskLevel: r.aiMetadata.riskLevel }} />
              </header>
              <div className="similarity">
                <span className="similarity-track">
                  <span className="similarity-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="mono">{r.similarity.toFixed(3)}</span>
              </div>
              <div className="entity">{r.entityName}</div>
              <p className="description">{r.description}</p>
              <div className="muted small">
                {usd(r.monetaryImpact)} · {r.controlId} · {shortTime(r.timestamp)}
              </div>
              <FlagList flags={r.aiMetadata.anomalyFlags} limit={3} />
            </article>
          );
        })}
      </div>
    );
  }

  render() {
    const { source, state, onClose } = this.props;
    return (
      <div className="similar-panel" ref={this.panelRef}>
        <div className="similar-head">
          <div>
            <strong>Top 3 similar historical exceptions</strong>
            <span className="muted small">
              {' '}
              for {source.evidenceId} · cosine similarity on 8-dim semantic vectors
              {state.meta ? ` · ${state.meta.tookMs} ms` : ''}
            </span>
          </div>
          <button className="btn btn-xs btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {this.renderBody()}
      </div>
    );
  }
}
