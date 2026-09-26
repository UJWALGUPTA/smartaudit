import React from 'react';
import AuditRow from './AuditRow.jsx';
import SimilarPanel from './SimilarPanel.jsx';

const COLUMNS = ['Evidence', 'Details', 'Impact', 'Risk', 'AI analysis', 'Auditor notes', ''];

export default class AuditTable extends React.Component {
  render() {
    const { entries, loading, pending, flashed, similar, onUpdate, onRetry, onFindSimilar, onCloseSimilar } = this.props;

    if (loading) {
      return (
        <div className="empty">
          <span className="spinner" /> Loading audit stream…
        </div>
      );
    }
    if (!entries.length) {
      return (
        <div className="empty">
          No evidence yet. Run <code>npm run seed</code> or ingest a record above.
        </div>
      );
    }

    return (
      <div className="table-wrap">
        <table className="audit-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <React.Fragment key={entry._id}>
                <AuditRow
                  entry={entry}
                  pending={pending[entry._id]}
                  flashed={Boolean(flashed[entry._id])}
                  similarOpen={similar?.sourceId === entry._id}
                  similarLoading={similar?.sourceId === entry._id && similar.loading}
                  onUpdate={onUpdate}
                  onRetry={onRetry}
                  onFindSimilar={onFindSimilar}
                />
                {similar?.sourceId === entry._id && (
                  <tr className="similar-row">
                    <td colSpan={COLUMNS.length}>
                      <SimilarPanel source={entry} state={similar} onClose={onCloseSimilar} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}
