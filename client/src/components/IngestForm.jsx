import React from 'react';

const SAMPLES = [
  {
    eventType: 'Control Execution',
    entityName: 'Global Procurement Services',
    description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold',
    monetaryImpact: '85000',
    controlId: 'CTRL-FIN-302',
    actorUserId: 'user_7731',
  },
  {
    eventType: 'Payment Release',
    entityName: 'Accounts Payable',
    description: 'Supplier payment split into multiple invoices just below approval limit, approved urgently',
    monetaryImpact: '49500',
    controlId: 'CTRL-FIN-305',
    actorUserId: 'user_4410',
  },
  {
    eventType: 'Access Review',
    entityName: 'Corporate IT',
    description: 'Admin privilege self-approved by system owner on weekend',
    monetaryImpact: '0',
    controlId: 'CTRL-ITGC-114',
    actorUserId: 'user_1180',
  },
];

const EMPTY = { eventType: '', entityName: '', description: '', monetaryImpact: '', controlId: '', actorUserId: '' };
const newEvidenceId = () => `EVID-${Math.floor(100000 + Math.random() * 900000)}`;

export default class IngestForm extends React.Component {
  constructor(props) {
    super(props);
    this.state = { form: { ...EMPTY, evidenceId: newEvidenceId() }, submitting: false, error: null, sampleIdx: 0 };
  }

  set = (field) => (e) => this.setState({ form: { ...this.state.form, [field]: e.target.value } });

  fillSample = () => {
    const { sampleIdx } = this.state;
    this.setState({
      form: { ...SAMPLES[sampleIdx % SAMPLES.length], evidenceId: newEvidenceId() },
      sampleIdx: sampleIdx + 1,
      error: null,
    });
  };

  submit = async (e) => {
    e.preventDefault();
    const { form } = this.state;
    this.setState({ submitting: true, error: null });
    try {
      await this.props.onSubmit({ ...form, monetaryImpact: Number(form.monetaryImpact), timestamp: new Date().toISOString() });
    } catch (err) {
      const details = err.details ? ` (${Object.values(err.details).join('; ')})` : '';
      this.setState({ submitting: false, error: `${err.message}${details}` });
    }
  };

  render() {
    const { form, submitting, error } = this.state;
    return (
      <form className="ingest" onSubmit={this.submit}>
        <div className="ingest-grid">
          <Field label="Evidence ID" value={form.evidenceId} onChange={this.set('evidenceId')} mono />
          <Field label="Event type" value={form.eventType} onChange={this.set('eventType')} placeholder="Control Execution" />
          <Field label="Entity" value={form.entityName} onChange={this.set('entityName')} placeholder="Global Procurement Services" />
          <Field label="Monetary impact (USD)" type="number" value={form.monetaryImpact} onChange={this.set('monetaryImpact')} />
          <Field label="Control ID" value={form.controlId} onChange={this.set('controlId')} placeholder="CTRL-FIN-302" mono />
          <Field label="Actor" value={form.actorUserId} onChange={this.set('actorUserId')} placeholder="user_7731" mono />
          <label className="field span-all">
            <span>Description</span>
            <textarea rows={2} required value={form.description} onChange={this.set('description')} />
          </label>
        </div>
        {error && <div className="banner banner-error">{error}</div>}
        <div className="ingest-actions">
          <button type="button" className="btn btn-ghost" onClick={this.fillSample}>
            Fill sample
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={this.props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? <span className="spinner spinner-xs" /> : null} Ingest &amp; queue for AI
          </button>
        </div>
      </form>
    );
  }
}

class Field extends React.Component {
  render() {
    const { label, mono, ...input } = this.props;
    return (
      <label className="field">
        <span>{label}</span>
        <input required className={mono ? 'mono' : undefined} {...input} />
      </label>
    );
  }
}
