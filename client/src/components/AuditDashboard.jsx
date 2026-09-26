import React from 'react';
import { api } from '../api.js';
import { isInFlight } from '../format.js';
import AuditTable from './AuditTable.jsx';
import IngestForm from './IngestForm.jsx';
import ActivityFeed from './ActivityFeed.jsx';
import Toasts from './Toasts.jsx';

const SAFETY_POLL_MS = 5000;
const POLL_ACTIVE_MS = 2000; // serverless mode, while anything is in flight
const POLL_IDLE_MS = 8000;
const MAX_ACTIVITY = 40;

const EVENT_TEXT = {
  created: ['queued', 'ingested → PENDING'],
  processing: ['ai', 'AI worker picked up'],
  completed: ['ai', 'AI enrichment completed'],
  retry_scheduled: ['warn', 'AI attempt failed, retry scheduled'],
  failed: ['error', 'AI enrichment failed permanently'],
  requeued: ['queued', 'manually re-queued'],
  fast_track: ['fast', 'notes saved — fast track, AI skipped'],
  direct_update: ['fast', 'metadata updated, AI skipped'],
  ai_requeue: ['queued', 'core evidence changed → re-queued for AI'],
};

/** Newer-wins merge so out-of-order responses never roll a row backwards. */
function upsert(entries, incoming) {
  const idx = entries.findIndex((e) => e._id === incoming._id);
  if (idx === -1) return [incoming, ...entries];
  if (new Date(incoming.updated) < new Date(entries[idx].updated)) return entries;
  const next = entries.slice();
  next[idx] = incoming;
  return next;
}

export default class AuditDashboard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      entries: [],
      loading: true,
      error: null,
      connection: 'connecting', // connecting | live | reconnecting | polling
      health: null,
      showIngest: false,
      similar: null, // { sourceId, loading, results, meta, error }
      pending: {}, // { [id]: 'notes' | 'core' | 'retry' } - per-row request indicators
      flashed: {}, // { [id]: true } - briefly highlight rows that just changed
      activity: [],
      toasts: [],
    };
    this.eventSource = null;
    this.pollTimer = null;
    this.pollTimeout = null;
    this.draining = false;
    this.unmounted = false;
    this.timeouts = new Set();
  }

  componentDidMount() {
    this.loadAll();
    // Long-lived server -> SSE push. Serverless (Vercel) -> polling, since
    // function instances can't share an event stream.
    api
      .health()
      .then((health) => {
        this.setState({ health });
        if (health.runtime === 'serverless') this.startPolling();
        else this.openStream();
      })
      .catch(() => this.openStream());
    // Safety net if the SSE stream drops: refetch while anything is in flight.
    this.pollTimer = setInterval(() => {
      const { connection, entries } = this.state;
      if (!['live', 'polling'].includes(connection) && entries.some(isInFlight)) this.loadAll();
    }, SAFETY_POLL_MS);
  }

  componentWillUnmount() {
    this.unmounted = true;
    this.eventSource?.close();
    clearInterval(this.pollTimer);
    clearTimeout(this.pollTimeout);
    this.timeouts.forEach(clearTimeout);
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timeouts.delete(t);
      fn();
    }, ms);
    this.timeouts.add(t);
  }

  // ------------------------------------------------------------- data flow

  async loadAll({ diff = false } = {}) {
    try {
      const { data } = await api.list();
      if (diff) this.logDiff(this.state.entries, data);
      // Newer-wins per row: a list fetched before a local PUT/POST resolved
      // must not roll that row back.
      this.setState((s) => {
        const local = new Map(s.entries.map((e) => [e._id, e]));
        const merged = data.map((d) => {
          const l = local.get(d._id);
          return l && new Date(l.updated) > new Date(d.updated) ? l : d;
        });
        return { entries: merged, loading: false, error: null };
      });
    } catch (err) {
      this.setState({ loading: false, error: err.message });
    }
  }

  // ------------------------------------------------------ serverless polling

  startPolling() {
    this.setState({ connection: 'polling' });
    const tick = async () => {
      if (this.unmounted) return;
      await this.loadAll({ diff: true });
      const inFlight = this.state.entries.some(isInFlight);
      if (this.state.entries.some((e) => e.aiMetadata.status === 'PENDING')) this.kickWorker();
      this.pollTimeout = setTimeout(tick, inFlight ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    this.pollTimeout = setTimeout(tick, POLL_ACTIVE_MS);
  }

  /** Nudge the queue; safe to call from any number of tabs (claims are atomic). */
  kickWorker() {
    if (this.draining) return;
    this.draining = true;
    api.drain().catch(() => {}).finally(() => { this.draining = false; });
  }

  /** Derive activity-feed events from list snapshots (polling has no push events). */
  logDiff(prev, next) {
    const before = new Map(prev.map((e) => [e._id, e]));
    for (const e of next) {
      const old = before.get(e._id);
      if (!old) {
        if (prev.length) this.log('queued', e.evidenceId, 'ingested → PENDING');
        continue;
      }
      const [was, now] = [old.aiMetadata.status, e.aiMetadata.status];
      if (was === now && old.coreRevision === e.coreRevision) continue;
      this.flash(e._id);
      if (now === 'PROCESSING') this.log('ai', e.evidenceId, 'AI worker picked up');
      else if (now === 'COMPLETED') this.log('ai', e.evidenceId, `AI enrichment completed · ${e.aiMetadata.riskLevel} ${e.aiMetadata.riskScore}`);
      else if (now === 'FAILED') this.log('error', e.evidenceId, 'AI enrichment failed permanently');
      else if (now === 'PENDING' && was === 'PROCESSING' && e.aiMetadata.lastError) this.log('warn', e.evidenceId, 'AI attempt failed, retry scheduled');
    }
  }

  openStream() {
    const es = new EventSource(api.eventsUrl);
    this.eventSource = es;
    es.addEventListener('hello', () => {
      // (Re)connected: resync anything we may have missed while offline.
      if (this.state.connection === 'reconnecting') this.loadAll();
      this.setState({ connection: 'live' });
    });
    es.addEventListener('entry', (msg) => this.handleEntryEvent(JSON.parse(msg.data)));
    es.onerror = () => this.setState({ connection: 'reconnecting' });
  }

  async handleEntryEvent(evt) {
    try {
      const { data } = await api.get(evt.id);
      this.setState((s) => ({ entries: upsert(s.entries, data) }));
      this.flash(evt.id);
      const [kind, text] = EVENT_TEXT[evt.reason] ?? ['info', evt.reason];
      const detail = evt.reason === 'completed' ? ` · ${data.aiMetadata.riskLevel} ${data.aiMetadata.riskScore}` : '';
      this.log(kind, data.evidenceId, `${text}${detail}`);
    } catch {
      /* entry may belong to a stale view; ignore */
    }
  }

  flash(id) {
    this.setState((s) => ({ flashed: { ...s.flashed, [id]: true } }));
    this.later(() => this.setState((s) => {
      const { [id]: _, ...rest } = s.flashed;
      return { flashed: rest };
    }), 1200);
  }

  log(kind, evidenceId, text) {
    const item = { id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString(), kind, evidenceId, text };
    this.setState((s) => ({ activity: [item, ...s.activity].slice(0, MAX_ACTIVITY) }));
  }

  toast(kind, title, body) {
    const id = `${Date.now()}-${Math.random()}`;
    this.setState((s) => ({ toasts: [...s.toasts, { id, kind, title, body }] }));
    this.later(() => this.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  }

  setPending(id, value) {
    this.setState((s) => {
      const pending = { ...s.pending };
      if (value) pending[id] = value;
      else delete pending[id];
      return { pending };
    });
  }

  // --------------------------------------------------------------- actions

  handleCreate = async (entry) => {
    const { data } = await api.create(entry);
    this.setState((s) => ({ entries: upsert(s.entries, data), showIngest: false }));
    this.flash(data._id);
    if (this.state.connection === 'polling') this.log('queued', data.evidenceId, 'ingested → PENDING');
    this.toast('queued', 'Evidence ingested', `${data.evidenceId} saved as PENDING — AI enrichment queued.`);
  };

  handleUpdate = async (entry, patch, kind) => {
    this.setPending(entry._id, kind);
    try {
      const { data, meta } = await api.update(entry._id, patch);
      this.setState((s) => ({ entries: upsert(s.entries, data) }));
      this.flash(entry._id);
      if (this.state.connection === 'polling' && EVENT_TEXT[meta.path.toLowerCase()]) {
        const [kind, text] = EVENT_TEXT[meta.path.toLowerCase()];
        this.log(kind, data.evidenceId, text);
      }
      if (meta.path === 'FAST_TRACK') {
        this.toast('fast', 'Fast-tracked', `Notes saved in ${meta.durationMs} ms. AI pipeline skipped.`);
      } else if (meta.path === 'AI_REQUEUE') {
        this.toast('queued', 'Re-queued for AI', `Changed ${meta.changedFields.join(', ')} → risk will be recomputed.`);
      } else if (meta.path === 'DIRECT_UPDATE') {
        this.toast('fast', 'Updated', `Changed ${meta.changedFields.join(', ')}. AI pipeline skipped.`);
      } else {
        this.toast('info', 'No changes', 'Nothing differed from the stored evidence.');
      }
      return true;
    } catch (err) {
      this.toast('error', 'Update failed', err.message);
      return false;
    } finally {
      this.setPending(entry._id, null);
    }
  };

  handleRetry = async (entry) => {
    this.setPending(entry._id, 'retry');
    try {
      const { data } = await api.retry(entry._id);
      this.setState((s) => ({ entries: upsert(s.entries, data) }));
    } catch (err) {
      this.toast('error', 'Retry failed', err.message);
    } finally {
      this.setPending(entry._id, null);
    }
  };

  handleFindSimilar = async (entry) => {
    if (this.state.similar?.sourceId === entry._id && !this.state.similar.loading) {
      this.setState({ similar: null }); // toggle closed
      return;
    }
    this.setState({ similar: { sourceId: entry._id, loading: true, results: [], meta: null, error: null } });
    try {
      const { data, meta } = await api.similar(entry._id);
      this.setState((s) => (s.similar?.sourceId === entry._id ? { similar: { ...s.similar, loading: false, results: data, meta } } : null));
    } catch (err) {
      this.setState((s) => (s.similar?.sourceId === entry._id ? { similar: { ...s.similar, loading: false, error: err.message } } : null));
    }
  };

  closeSimilar = () => this.setState({ similar: null });

  // ---------------------------------------------------------------- render

  renderHeader() {
    const { entries, connection, health } = this.state;
    const counts = entries.reduce((acc, e) => {
      acc[e.aiMetadata.status] = (acc[e.aiMetadata.status] ?? 0) + 1;
      return acc;
    }, {});
    const high = entries.filter((e) => ['HIGH', 'CRITICAL'].includes(e.aiMetadata.riskLevel)).length;
    const ai = health?.ai;

    return (
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">◆</div>
          <div>
            <h1>SmartAudit</h1>
            <p>Continuous audit pipeline · AI risk &amp; anomaly enrichment</p>
          </div>
        </div>
        <div className="topbar-meta">
          <div className="kpis">
            <Kpi label="Evidence" value={entries.length} />
            <Kpi label="In queue" value={(counts.PENDING ?? 0) + (counts.PROCESSING ?? 0)} tone="amber" />
            <Kpi label="High / critical" value={high} tone="red" />
            <Kpi label="Failed" value={counts.FAILED ?? 0} tone={counts.FAILED ? 'red' : undefined} />
          </div>
          <div className="topbar-status">
            <span className={`live live-${connection}`}>
              <i />{' '}
              {{ live: 'Live stream', polling: 'Auto-refresh', connecting: 'Connecting…' }[connection] ?? 'Reconnecting…'}
            </span>
            {ai && (
              <span className="engine" title={ai.fallback ? `Falls back to ${ai.fallback}` : undefined}>
                AI engine: <b>{ai.provider === 'mock' ? 'Local simulation' : ai.provider}</b> · {ai.model}
              </span>
            )}
          </div>
        </div>
      </header>
    );
  }

  render() {
    const { entries, loading, error, showIngest, similar, pending, flashed, activity, toasts } = this.state;
    return (
      <div className="app">
        {this.renderHeader()}
        <main className="layout">
          <section className="card stream">
            <div className="card-head">
              <div>
                <h2>Live audit stream</h2>
                <p className="muted">Records enter as PENDING and are enriched asynchronously by the AI worker.</p>
              </div>
              <button className="btn btn-primary" onClick={() => this.setState({ showIngest: !showIngest })}>
                {showIngest ? 'Close' : '+ Ingest evidence'}
              </button>
            </div>
            {showIngest && <IngestForm onSubmit={this.handleCreate} onCancel={() => this.setState({ showIngest: false })} />}
            {error && <div className="banner banner-error">Could not load entries: {error}</div>}
            <AuditTable
              entries={entries}
              loading={loading}
              pending={pending}
              flashed={flashed}
              similar={similar}
              onUpdate={this.handleUpdate}
              onRetry={this.handleRetry}
              onFindSimilar={this.handleFindSimilar}
              onCloseSimilar={this.closeSimilar}
            />
          </section>
          <ActivityFeed items={activity} />
        </main>
        <Toasts items={toasts} />
      </div>
    );
  }
}

class Kpi extends React.Component {
  render() {
    const { label, value, tone } = this.props;
    return (
      <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
        <span className="kpi-value">{value}</span>
        <span className="kpi-label">{label}</span>
      </div>
    );
  }
}
