import React from 'react';
import { StatusBadge, ScoreMeter, FlagList, VectorBars } from './Badges.jsx';
import { usd, shortTime, isInFlight } from '../format.js';

const coreDraftOf = (entry) => ({
  description: entry.description,
  controlId: entry.controlId,
  monetaryImpact: String(entry.monetaryImpact),
});

export default class AuditRow extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      notesDraft: props.entry.aiMetadata.auditorNotes ?? '',
      editingCore: false,
      coreDraft: coreDraftOf(props.entry),
    };
  }

  componentDidUpdate(prev) {
    // Adopt notes changed elsewhere (another tab/auditor) unless the user is mid-edit.
    const before = prev.entry.aiMetadata.auditorNotes ?? '';
    const now = this.props.entry.aiMetadata.auditorNotes ?? '';
    if (before !== now && this.state.notesDraft === before) this.setState({ notesDraft: now });
  }

  saveNotes = () => {
    this.props.onUpdate(this.props.entry, { aiMetadata: { auditorNotes: this.state.notesDraft } }, 'notes');
  };

  startEdit = () => this.setState({ editingCore: true, coreDraft: coreDraftOf(this.props.entry) });

  cancelEdit = () => this.setState({ editingCore: false });

  saveCore = async () => {
    const { coreDraft } = this.state;
    const ok = await this.props.onUpdate(
      this.props.entry,
      { ...coreDraft, monetaryImpact: Number(coreDraft.monetaryImpact) },
      'core',
    );
    if (ok) this.setState({ editingCore: false });
  };

  setCore = (field) => (e) => this.setState({ coreDraft: { ...this.state.coreDraft, [field]: e.target.value } });

  renderDetails() {
    const { entry } = this.props;
    const { editingCore, coreDraft } = this.state;
    if (editingCore) {
      return (
        <div className="core-edit">
          <label>
            Description
            <textarea rows={3} value={coreDraft.description} onChange={this.setCore('description')} />
          </label>
          <label>
            Control ID
            <input value={coreDraft.controlId} onChange={this.setCore('controlId')} />
          </label>
        </div>
      );
    }
    return (
      <>
        <div className="entity">{entry.entityName}</div>
        <div className="description">{entry.description}</div>
        <span className="chip mono">{entry.controlId}</span>
      </>
    );
  }

  renderAnalysis() {
    const { aiMetadata: ai } = this.props.entry;
    const rerun = isInFlight(this.props.entry) && ai.aiSummary;
    if (!ai.aiSummary) {
      if (ai.status === 'FAILED') return <div className="error-text small">{ai.lastError || 'Enrichment failed'}</div>;
      return (
        <div className="skeleton-block" aria-label="AI analysis pending">
          <span className="skeleton" />
          <span className="skeleton short" />
          {ai.lastError && <div className="warn-text small">Retrying: {ai.lastError}</div>}
        </div>
      );
    }
    return (
      <div className={rerun ? 'is-stale' : ''}>
        {rerun && <div className="rerun-note">Recomputing — showing previous analysis</div>}
        <p className="summary">{ai.aiSummary}</p>
        <FlagList flags={ai.anomalyFlags} limit={4} />
        <div className="analysis-foot">
          <VectorBars vector={ai.semanticVector} />
          {ai.provider && (
            <span className="provenance" title={`Enriched ${ai.enrichedAt ? new Date(ai.enrichedAt).toLocaleString() : ''}`}>
              {ai.provider} · rev {ai.enrichedRevision}
            </span>
          )}
        </div>
      </div>
    );
  }

  render() {
    const { entry, pending, flashed, similarOpen, similarLoading, onFindSimilar, onRetry } = this.props;
    const { notesDraft, editingCore, coreDraft } = this.state;
    const ai = entry.aiMetadata;
    const notesDirty = notesDraft !== (ai.auditorNotes ?? '');
    const canSearch = ai.semanticVector?.length > 0;

    return (
      <tr className={`row ${flashed ? 'flash' : ''} ${similarOpen ? 'is-open' : ''}`}>
        <td className="col-evidence" data-label="Evidence">
          <div className="mono strong">{entry.evidenceId}</div>
          <div className="muted small">{entry.eventType}</div>
          <div className="muted small">{shortTime(entry.timestamp)}</div>
          <div className="muted small mono">{entry.actorUserId}</div>
        </td>
        <td className="col-details" data-label="Details">{this.renderDetails()}</td>
        <td className="col-amount" data-label="Impact">
          {editingCore ? (
            <input
              className="amount-input"
              type="number"
              min="0"
              value={coreDraft.monetaryImpact}
              onChange={this.setCore('monetaryImpact')}
            />
          ) : (
            <span className="amount">{usd(entry.monetaryImpact)}</span>
          )}
        </td>
        <td className="col-risk" data-label="Risk">
          <StatusBadge meta={ai} />
          <ScoreMeter score={ai.riskScore} level={ai.riskLevel} stale={isInFlight(entry)} />
          {ai.status === 'FAILED' && (
            <button className="btn btn-xs" disabled={pending === 'retry'} onClick={() => onRetry(entry)}>
              Retry
            </button>
          )}
        </td>
        <td className="col-analysis" data-label="AI analysis">{this.renderAnalysis()}</td>
        <td className="col-notes" data-label="Auditor notes">
          <textarea
            className="notes"
            rows={3}
            placeholder="Add auditor notes…"
            value={notesDraft}
            onChange={(e) => this.setState({ notesDraft: e.target.value })}
          />
          <div className="notes-actions">
            <span className="muted tiny">{notesDirty ? 'Fast-track save · no AI re-run' : ' '}</span>
            <button className="btn btn-xs btn-fast" disabled={!notesDirty || pending === 'notes'} onClick={this.saveNotes}>
              {pending === 'notes' ? <span className="spinner spinner-xs" /> : '⚡'} Save
            </button>
          </div>
        </td>
        <td className="col-actions" data-label="Actions">
          {editingCore ? (
            <div className="stack">
              <button className="btn btn-xs btn-primary" disabled={pending === 'core'} onClick={this.saveCore}>
                {pending === 'core' ? <span className="spinner spinner-xs" /> : null} Save &amp; re-analyze
              </button>
              <button className="btn btn-xs btn-ghost" onClick={this.cancelEdit}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="stack">
              <button
                className={`btn btn-xs ${similarOpen ? 'btn-active' : ''}`}
                disabled={!canSearch || similarLoading}
                title={canSearch ? 'Find the 3 most similar historical exceptions' : 'Available once AI enrichment completes'}
                onClick={() => onFindSimilar(entry)}
              >
                {similarLoading ? <span className="spinner spinner-xs" /> : '≈'} Similar
              </button>
              <button className="btn btn-xs btn-ghost" onClick={this.startEdit} title="Edit core financial evidence">
                ✎ Edit evidence
              </button>
            </div>
          )}
        </td>
      </tr>
    );
  }
}
