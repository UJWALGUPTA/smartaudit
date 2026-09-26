/**
 * npm run seed               -> 5 sample entries (replaces the tenant's data)
 * npm run seed -- --extended -> 5 + 7 extra historical exceptions, for a richer /similar demo
 *
 * Entries are inserted as PENDING; the running worker (npm run dev) enriches
 * them within a second or two, so you can watch the pipeline work.
 */
import config from '../src/config/index.js';
import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { AuditEntry } from '../src/models/AuditEntry.js';
import { AuditRepository } from '../src/repositories/AuditRepository.js';

const daysAgo = (d, hourUtc = 14) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - d);
  // Keep samples on weekdays so OFF_HOURS_ACTIVITY only fires where intended.
  while ([0, 6].includes(t.getUTCDay())) t.setUTCDate(t.getUTCDate() - 1);
  t.setUTCHours(hourUtc, 0, 0, 0);
  return t;
};

const CORE = [
  {
    timestamp: daysAgo(0, 10),
    eventType: 'Control Execution',
    evidenceId: 'EVID-902188',
    entityName: 'Global Procurement Services',
    description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold',
    monetaryImpact: 85000,
    controlId: 'CTRL-FIN-302',
    actorUserId: 'user_7731',
  },
  {
    timestamp: daysAgo(1, 23),
    eventType: 'Access Review',
    evidenceId: 'EVID-902204',
    entityName: 'Corporate IT',
    description: 'Temporary admin privilege granted to finance analyst after hours without ticket reference',
    monetaryImpact: 0,
    controlId: 'CTRL-ITGC-114',
    actorUserId: 'user_1180',
  },
  {
    timestamp: daysAgo(2, 15),
    eventType: 'Payment Release',
    evidenceId: 'EVID-902231',
    entityName: 'Treasury Operations',
    description: 'Duplicate wire transfer to supplier detected; payment released twice for the same invoice',
    monetaryImpact: 42750,
    controlId: 'CTRL-TRE-021',
    actorUserId: 'user_5520',
  },
  {
    timestamp: daysAgo(3, 11),
    eventType: 'Journal Entry',
    evidenceId: 'EVID-902260',
    entityName: 'Group Financial Reporting',
    description: 'Backdated manual journal entry posted to revenue accrual during quarter close',
    monetaryImpact: 120000,
    controlId: 'CTRL-FIN-410',
    actorUserId: 'user_3094',
  },
  {
    timestamp: daysAgo(4, 9),
    eventType: 'Expense Approval',
    evidenceId: 'EVID-902275',
    entityName: 'Regional Sales EMEA',
    description: 'Employee travel expense reimbursement approved by line manager within policy limits',
    monetaryImpact: 1840,
    controlId: 'CTRL-OPS-055',
    actorUserId: 'user_6612',
  },
];

const EXTENDED = [
  ['Control Execution', 'EVID-901877', 'Global Procurement Services', 'Vendor invoice approval limit bypassed via manual override by procurement lead', 64000, 'CTRL-FIN-302', 'user_7731', 21],
  ['Payment Release', 'EVID-901902', 'Accounts Payable', 'Supplier invoices split into multiple payments just below the $10k approval threshold', 29700, 'CTRL-FIN-305', 'user_4410', 18],
  ['Access Review', 'EVID-901933', 'Corporate IT', 'Superuser access provisioned to contractor account without manager approval', 0, 'CTRL-ITGC-114', 'user_1180', 16],
  ['Journal Entry', 'EVID-901950', 'Group Financial Reporting', 'Manual ledger adjustment to revenue recognition posted on weekend before period close', 250000, 'CTRL-FIN-410', 'user_3094', 14],
  ['Payment Release', 'EVID-901981', 'Treasury Operations', 'Repeated ACH payment to the same vendor bank account within 24 hours', 15500, 'CTRL-TRE-021', 'user_5520', 11],
  ['Payroll Run', 'EVID-902010', 'People Operations', 'Off-cycle payroll bonus disbursement approved verbally by CFO, urgent', 90000, 'CTRL-PAY-201', 'user_2271', 9],
  ['Expense Approval', 'EVID-902044', 'Regional Sales APAC', 'Routine employee expense reimbursement for client meeting, receipts attached', 640, 'CTRL-OPS-055', 'user_8800', 7],
].map(([eventType, evidenceId, entityName, description, monetaryImpact, controlId, actorUserId, age]) => ({
  timestamp: daysAgo(age),
  eventType,
  evidenceId,
  entityName,
  description,
  monetaryImpact,
  controlId,
  actorUserId,
}));

async function main() {
  const extended = process.argv.includes('--extended');
  await connectDatabase();
  await AuditEntry.syncIndexes();

  const repo = new AuditRepository();
  const tenantId = config.defaultTenantId;
  const { deletedCount } = await repo.deleteAllForTenant(tenantId);

  const rows = extended ? [...EXTENDED, ...CORE] : CORE;
  for (const row of rows) await repo.create(tenantId, row); // created order == list order

  console.log(`Seeded ${rows.length} audit entries (removed ${deletedCount}) for tenant ${tenantId}.`);
  console.log('All entries are PENDING - start/keep `npm run dev` running and the worker will enrich them.');
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
