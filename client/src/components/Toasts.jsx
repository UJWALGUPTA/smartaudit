import React from 'react';

export default class Toasts extends React.Component {
  render() {
    return (
      <div className="toasts" role="status" aria-live="polite">
        {this.props.items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <strong>{t.title}</strong>
            <span>{t.body}</span>
          </div>
        ))}
      </div>
    );
  }
}
