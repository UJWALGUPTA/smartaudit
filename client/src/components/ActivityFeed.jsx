import React from 'react';
import { clock } from '../format.js';

export default class ActivityFeed extends React.Component {
  render() {
    const { items } = this.props;
    return (
      <aside className="card activity">
        <div className="card-head">
          <div>
            <h2>Pipeline activity</h2>
            <p className="muted">Live events from the API and AI worker.</p>
          </div>
        </div>
        {items.length === 0 ? (
          <div className="muted small activity-empty">Waiting for events…</div>
        ) : (
          <ol className="activity-list">
            {items.map((item) => (
              <li key={item.id} className={`activity-item kind-${item.kind}`}>
                <span className="dot" />
                <div>
                  <div className="activity-line">
                    <span className="mono strong">{item.evidenceId}</span>
                    <span className="muted tiny mono">{clock(item.at)}</span>
                  </div>
                  <div className="small">{item.text}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </aside>
    );
  }
}
