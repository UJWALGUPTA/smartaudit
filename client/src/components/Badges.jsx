import React from 'react';
import { humanFlag } from '../format.js';

/** PENDING / PROCESSING / FAILED, or the computed risk level once COMPLETED. */
export class StatusBadge extends React.Component {
  render() {
    const { status, riskLevel } = this.props.meta;
    if (status === 'COMPLETED') return <span className={`badge badge-${riskLevel.toLowerCase()}`}>{riskLevel}</span>;
    if (status === 'PROCESSING') {
      return (
        <span className="badge badge-processing">
          <span className="spinner spinner-xs" /> Analyzing
        </span>
      );
    }
    if (status === 'FAILED') return <span className="badge badge-failed">Failed</span>;
    return (
      <span className="badge badge-pending">
        <i className="pulse" /> Pending
      </span>
    );
  }
}

export class ScoreMeter extends React.Component {
  render() {
    const { score, level, stale } = this.props;
    if (score == null) return <span className="muted small">—</span>;
    return (
      <div className={`meter ${stale ? 'is-stale' : ''}`} title={stale ? 'Previous score — being recomputed' : `Risk score ${score}/100`}>
        <span className="meter-value">{score}</span>
        <span className="meter-track">
          <span className={`meter-fill fill-${(level ?? 'low').toLowerCase()}`} style={{ width: `${score}%` }} />
        </span>
      </div>
    );
  }
}

export class FlagList extends React.Component {
  render() {
    const { flags = [], limit = 99 } = this.props;
    if (!flags.length) return null;
    const shown = flags.slice(0, limit);
    return (
      <div className="flags">
        {shown.map((f) => (
          <span className="flag" key={f} title={f}>
            {humanFlag(f)}
          </span>
        ))}
        {flags.length > limit && <span className="flag flag-more">+{flags.length - limit}</span>}
      </div>
    );
  }
}

/** The 8-dim semantic vector as a tiny diverging bar chart. */
export class VectorBars extends React.Component {
  render() {
    const { vector = [] } = this.props;
    if (vector.length === 0) return null;
    const max = Math.max(...vector.map(Math.abs), 0.001);
    return (
      <div className="vector" title={`semanticVector [${vector.map((v) => v.toFixed(2)).join(', ')}]`}>
        <span className="vector-label">vec</span>
        {vector.map((v, i) => (
          <span key={i} className="vector-cell">
            <span
              className={`vector-bar ${v < 0 ? 'neg' : ''}`}
              style={{ height: `${Math.max(8, (Math.abs(v) / max) * 100)}%`, opacity: 0.35 + (Math.abs(v) / max) * 0.65 }}
            />
          </span>
        ))}
      </div>
    );
  }
}
