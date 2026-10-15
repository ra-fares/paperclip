import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  authUsers,
  closeRegisteredClients,
  companies,
  completionContracts,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueDocuments,
  issues,
  projects,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { documentService } from "../services/documents.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { ensureNativeCompletionContract } from "../services/native-runtime/completion-contracts.js";
import {
  SENSOR_ADMISSION_DOCUMENT_KEY,
  SENSOR_ADMISSION_CONTEXT_KEY,
} from "../services/native-runtime/sensor-admission.js";

// An actual migrated, disposable PostgreSQL is mandatory.
// Never silently skip a test because embedded PostgreSQL is unavailable.
const testUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const ADAPTERS = [
  ["cline_local", "cline"],
  ["agy_local", "gemini"],
] as const;

type Db = ReturnType<typeof createDb>;
let db: Db;
let heartbeat: ReturnType<typeof heartbeatService>;
const execute = vi.fn<ServerAdapterModule["execute"]>();

function assertIsolatedTestDatabase(url: string | undefined): asserts url is string {
  if (!url) throw new Error("PAPERCLIP_TEST_DATABASE_URL required (real PostgreSQL)");
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    !/^\/paperclip_p04_direct_admission_01_[a-z0-9_]+$/.test(parsed.pathname)
  ) {
    throw new Error("Refusing non-local or non-task PostgreSQL database");
  }
}

async function waitForTerminalRun(runId: string) {
  for (let i = 0; i < 150; i += 1) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Heartbeat run ${runId} failed to reach a terminal state`);
}

async function createFixture(adapterType: string, admission: "malformed" | "unqualified" | "none") {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const responsibleUserId = randomUUID();
  const timestamp = new Date();

  // Real auth user: the heartbeat issue/comment path has an FK to "user".
  // An invented defaultResponsibleUserId can reach dispatch, but corrupts
  // the fixture with a foreign-key error during issue comment handling.
  await db.insert(authUsers).values({
    id: responsibleUserId,
    name: "P04 disposable CI responsible user",
    email: `p04-direct-${responsibleUserId}@example.invalid`,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await db.insert(companies).values({
    id: companyId,
    name: "P04 disposable direct-admission RED fixture",
    issuePrefix: `DR${companyId.replace(/-/g, "").slice(0, 8)}`,
    requireBoardApprovalForNewAgents: false,
    defaultResponsibleUserId: responsibleUserId,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: `P04 test ${adapterType} (spy only)`,
    role: "engineer",
    status: "idle",
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "P04 governed direct launch fixture",
    assigneeAgentId: agentId,
    status: "in_progress",
  });

  if (admission !== "none") {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const body = admission === "malformed"
      ? '{"schema":"sensor-admission.v1",INVALID_JSON'
      : JSON.stringify({
          schema: "sensor-admission.v1",
          issueId,
          requiredCapabilities: ["code"],
          workerQualification: {
            agentId,
            qualificationRevision: "unqualified-v1",
            agentConfigRevisionId: randomUUID(), // deliberately absent
            qualifiedCapabilities: ["code"],
          },
          scope: { allowedPaths: ["server/src/**"], forbiddenPaths: [".github/**"] },
          workspace: { id: randomUUID(), baselineSha: "b".repeat(40) },
          minimumRiskClass: "standard",
        });
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "sensor-admission",
      latestBody: body,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      body,
    });
    await db.update(documents)
      .set({ latestRevisionId: revisionId })
      .where(eq(documents.id, documentId));
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: SENSOR_ADMISSION_DOCUMENT_KEY,
    });
  }

  return { companyId, agentId, issueId };
}

async function runFixture(agentId: string, issueId: string) {
  const queued = await heartbeat.invoke(
    agentId,
    "on_demand",
    { issueId, taskKey: issueId, skipIssueComment: true },
    "manual",
  );
  expect(queued).not.toBeNull();
  return waitForTerminalRun(queued!.id);
}

beforeAll(() => {
  assertIsolatedTestDatabase(testUrl);
  db = createDb(testUrl);
  heartbeat = heartbeatService(db);
  for (const [adapterType] of ADAPTERS) {
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }
});

afterAll(async () => {
  // RED assertions can abort a test while a queued run is still finalizing.
  // Drain tracked execution promises before closing disposable PostgreSQL.
  await drainHeartbeatRunsToQuiescence(db, heartbeat);
  for (const [adapterType] of ADAPTERS) unregisterServerAdapter(adapterType);
  if (testUrl) await closeRegisteredClients(testUrl);
});

async function verifyQueuedDocumentTransition(
  adapterType: string,
  provider: string,
  scenario: "rebind" | "attach_detach",
) {
  execute.mockReset();
  const f = await createFixture(adapterType, scenario === "rebind" ? "malformed" : "none");
  await db.update(agents)
    .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
    .where(eq(agents.id, f.agentId));

  const blockerIssueId = randomUUID();
  await db.insert(issues).values({
    id: blockerIssueId,
    companyId: f.companyId,
    title: "Disposable queue blocker for rebind/attach race (spy only)",
    assigneeAgentId: f.agentId,
    status: "in_progress",
  });
  let releaseBlocker: (() => void) | undefined;
  const blockerWait = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const spyResult = {
    exitCode: 0, signal: null, timedOut: false,
    provider, model: "spy-only", summary: "Simulated legacy execution",
  } as const;
  execute.mockImplementationOnce(async () => {
    await blockerWait;
    return spyResult;
  });
  execute.mockResolvedValue(spyResult);

  let queuedId: string | null = null;
  try {
    const blocker = await heartbeat.invoke(
      f.agentId, "on_demand",
      { issueId: blockerIssueId, taskKey: blockerIssueId, skipIssueComment: true },
      "manual",
    );
    expect(blocker).not.toBeNull();
    for (let i = 0; i < 100 && execute.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(execute.mock.calls.length).toBe(1);

    const queued = await heartbeat.invoke(
      f.agentId, "on_demand",
      { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true },
      "manual",
    );
    expect(queued).not.toBeNull();
    queuedId = queued!.id;
    expect((await heartbeat.getRun(queuedId))?.status).toBe("queued");

    const [stored] = await db.select({
      runnerProfileJson: heartbeatRuns.runnerProfileJson,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedId));
    if (scenario === "rebind") {
      expect(stored?.runnerProfileJson).toMatchObject({
        sensorGovernance: { schema: "sensor-governance.queued.v1", issueId: f.issueId },
      });
    } else {
      expect(stored?.runnerProfileJson?.sensorGovernance).toBeUndefined();
    }

    const svc = documentService(db);
    if (scenario === "rebind") {
      const [oldLink] = await db.select({ documentId: issueDocuments.documentId })
        .from(issueDocuments).where(and(
          eq(issueDocuments.companyId, f.companyId),
          eq(issueDocuments.issueId, f.issueId),
          eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
        ));
      expect(oldLink?.documentId).toBeDefined();
      await svc.deleteIssueDocument(f.issueId, SENSOR_ADMISSION_DOCUMENT_KEY);
      const rebound = await svc.upsertIssueDocument({
        issueId: f.issueId,
        key: SENSOR_ADMISSION_DOCUMENT_KEY,
        format: "markdown",
        body: '{"schema":"sensor-admission.v1","rebind":true}',
      });
      expect(rebound.document.id).not.toBe(oldLink?.documentId);
    } else {
      // The run was queued when the issue was ungoverned. A document was
      // attached AND removed before the final dispatch read: a queue-only
      // sticky marker plus the current-link gate can both miss this history.
      const attached = await svc.upsertIssueDocument({
        issueId: f.issueId,
        key: SENSOR_ADMISSION_DOCUMENT_KEY,
        format: "markdown",
        body: '{"schema":"sensor-admission.v1","intermediate":true}',
      });
      expect(attached.document.key).toBe(SENSOR_ADMISSION_DOCUMENT_KEY);
      const removed = await svc.deleteIssueDocument(f.issueId, SENSOR_ADMISSION_DOCUMENT_KEY);
      expect(removed?.id).toBe(attached.document.id);
    }
  } finally {
    releaseBlocker?.();
  }

  expect(queuedId).not.toBeNull();
  const run = await waitForTerminalRun(queuedId!);
  await drainHeartbeatRunsToQuiescence(db, heartbeat);
  // For the attach-and-detach case this is intentional RED: neither the
  // enqueue-time marker nor the dispatch-time link witnesses governance.
  expect(execute.mock.calls.filter(([ctx]) => ctx.runId === queuedId)).toHaveLength(0);
  expect(run.status).toBe("failed");
  expect(run.errorCode).toBe("sensor_admission_denied");
  expect(run.scheduledRetryAt).toBeNull();
  const successors = await db.select({ id: heartbeatRuns.id })
    .from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, queuedId!));
  expect(successors).toHaveLength(0);
}


/** Prove a real PostgreSQL backend is waiting for an issue row lock, not just that two promises exist. */
async function waitForPostgresLock(label: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [observed] = await db.select({
      waiters: sql<number>`count(*)::int`,
    }).from(sql`pg_stat_activity`).where(sql`
      application_name = ${label}
      AND wait_event_type = 'Lock'
      AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    if ((observed?.waiters ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`P04 expected PostgreSQL lock wait not observed: ${label}`);
}

describe("P04 direct-adapter governed admission — disposable real PostgreSQL", () => {
  it.each(ADAPTERS)(
    "RED: malformed sensor-admission denies %s before adapter.execute",
    async (adapterType, provider) => {
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: "spy-only",
        summary: "UNSAFE — direct adapter executed despite invalid sensor admission",
      });

      const f = await createFixture(adapterType, "malformed");
      const run = await runFixture(f.agentId, f.issueId);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [stored] = await db.select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        processPid: heartbeatRuns.processPid,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      const events = await db.select({ eventType: heartbeatRunEvents.eventType })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run.id));
      const [linkedDocument] = await db.select({ key: issueDocuments.key })
        .from(issueDocuments)
        .where(and(
          eq(issueDocuments.issueId, f.issueId),
          eq(issueDocuments.companyId, f.companyId),
        ));

      expect(linkedDocument?.key).toBe(SENSOR_ADMISSION_DOCUMENT_KEY);
      // This is a real RED assertion against the accepted source. The old
      // legacy dispatch calls execute despite the malformed document.
      // Scope calls to the exact run: other issue wakeups can overlap tests.
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === run.id)).toHaveLength(0);
      expect(stored?.status).toBe("failed");
      expect(stored?.errorCode).toBe("sensor_admission_denied");
      expect(stored?.scheduledRetryAt).toBeNull();
      expect(stored?.processPid).toBeNull();
      expect((stored?.contextSnapshot ?? {})[SENSOR_ADMISSION_CONTEXT_KEY]).toBeUndefined();
      expect(events.some(event => event.eventType === "native.process_start_requested")).toBe(false);
      const replacements = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(replacements).toHaveLength(0);
    },
  );

  it.each(ADAPTERS)(
    "DENY: valid-format but unqualified Sensor issue refuses direct %s",
    async (adapterType, provider) => {
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: "spy-only",
        summary: "UNSAFE governed direct execution",
      });
      const f = await createFixture(adapterType, "unqualified");
      const run = await runFixture(f.agentId, f.issueId);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === run.id)).toHaveLength(0);
      expect(run.status).toBe("failed");
      const [stored] = await db.select({
        errorCode: heartbeatRuns.errorCode,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(stored?.errorCode).toBe("sensor_admission_denied");
      expect(stored?.scheduledRetryAt).toBeNull();
      expect((stored?.contextSnapshot ?? {})[SENSOR_ADMISSION_CONTEXT_KEY]).toBeUndefined();
      const replacements = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(replacements).toHaveLength(0);
    },
  );

  it.each(ADAPTERS)(
    "RECOVERY: terminal Sensor denial for %s must not be automatically requeued by a later sweep",
    async (adapterType, provider) => {
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: "spy-only",
        summary: "UNSAFE recovery execution after Sensor denial",
      });
      const f = await createFixture(adapterType, "malformed");
      const run = await runFixture(f.agentId, f.issueId);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("sensor_admission_denied");
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === run.id)).toHaveLength(0);

      // A later recovery tick must not reinterpret a policy DENY as a
      // retryable provider/continuation failure, even after the first run
      // has released the issue execution lock.
      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const retries = await db.select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(retries).toHaveLength(0);
      const [reconciledIssue] = await db.select({ status: issues.status })
        .from(issues).where(eq(issues.id, f.issueId));
      expect(reconciledIssue?.status).toBe("blocked");
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === run.id)).toHaveLength(0);
    },
  );

  it.each(ADAPTERS)(
    "RECOVERY: terminal Sensor denial on todo for %s blocks without requeue",
    async (adapterType, provider) => {
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: "spy-only",
        summary: "UNSAFE todo recovery execution after Sensor denial",
      });
      const f = await createFixture(adapterType, "malformed");
      const run = await runFixture(f.agentId, f.issueId);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("sensor_admission_denied");
      // Simulate a legitimate issue status return to todo after the run:
      // the recovery sweep must still respect the persisted admission denial.
      await db.update(issues)
        .set({ status: "todo" })
        .where(eq(issues.id, f.issueId));

      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const retries = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
      expect(retries).toHaveLength(0);
      const [current] = await db.select({ status: issues.status })
        .from(issues).where(eq(issues.id, f.issueId));
      expect(current?.status).toBe("blocked");
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === run.id)).toHaveLength(0);
    },
  );

  it.each(ADAPTERS)(
    "RED: queued governed %s remains denied after its Sensor document is detached",
    async (adapterType, provider) => {
      execute.mockReset();
      const f = await createFixture(adapterType, "malformed");
      // Force a genuine queued run: the first no-document run holds this
      // agent's only execution slot while the governed run is enqueued.
      await db.update(agents)
        .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, f.agentId));
      const blockerIssueId = randomUUID();
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId: f.companyId,
        title: "P04 disposable queue blocker (no Sensor document)",
        assigneeAgentId: f.agentId,
        status: "in_progress",
      });

      let releaseBlocker: (() => void) | undefined;
      const holdBlocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const spyResult = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: "spy-only",
        summary: "Safe fake legacy execution",
      } as const;
      execute.mockImplementationOnce(async () => {
        await holdBlocker;
        return spyResult;
      });
      execute.mockResolvedValue(spyResult);

      let governedRunId: string | null = null;
      try {
        const blocker = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: blockerIssueId, taskKey: blockerIssueId, skipIssueComment: true },
          "manual",
        );
        expect(blocker).not.toBeNull();
        // A bounded poll avoids relying on arbitrary sleeps or an assumed
        // scheduling order. The spy holds the real first run in-flight.
        for (let i = 0; i < 100 && execute.mock.calls.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        expect(execute.mock.calls.length).toBe(1);

        const queued = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true },
          "manual",
        );
        expect(queued).not.toBeNull();
        governedRunId = queued!.id;
        expect((await heartbeat.getRun(governedRunId))?.status).toBe("queued");
        const [queuedProfile] = await db.select({
          runnerProfileJson: heartbeatRuns.runnerProfileJson,
        }).from(heartbeatRuns).where(eq(heartbeatRuns.id, governedRunId));
        expect(queuedProfile?.runnerProfileJson).toMatchObject({
          sensorGovernance: {
            schema: "sensor-governance.queued.v1",
            issueId: f.issueId,
          },
        });
        const [linkedBeforeDetach] = await db
          .select({ key: issueDocuments.key })
          .from(issueDocuments)
          .where(and(
            eq(issueDocuments.companyId, f.companyId),
            eq(issueDocuments.issueId, f.issueId),
            eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
          ));
        expect(linkedBeforeDetach?.key).toBe(SENSOR_ADMISSION_DOCUMENT_KEY);

        // Use the actual service path, not a synthetic change to the run:
        // Board-style document deletion removes the current link. A queued
        // Sensor run must not thereby become an unrestricted legacy run.
        const removed = await documentService(db)
          .deleteIssueDocument(f.issueId, SENSOR_ADMISSION_DOCUMENT_KEY);
        expect(removed?.key).toBe(SENSOR_ADMISSION_DOCUMENT_KEY);
        const [linkedAfterDetach] = await db
          .select({ id: issueDocuments.id })
          .from(issueDocuments)
          .where(and(
            eq(issueDocuments.companyId, f.companyId),
            eq(issueDocuments.issueId, f.issueId),
            eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
          ));
        expect(linkedAfterDetach).toBeUndefined();
      } finally {
        // Never strand the first safe spy even if a queue assertion fails.
        releaseBlocker?.();
      }

      expect(governedRunId).not.toBeNull();
      const run = await waitForTerminalRun(governedRunId!);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === governedRunId)).toHaveLength(0);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("sensor_admission_denied");
      expect(run.scheduledRetryAt).toBeNull();
      const successors = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, governedRunId!));
      expect(successors).toHaveLength(0);
    },
  );

  it.each(ADAPTERS)(
    "REBIND: queued governed %s denies direct dispatch after document replacement",
    async (adapterType, provider) => {
      await verifyQueuedDocumentTransition(adapterType, provider, "rebind");
    },
  );

  it.each(ADAPTERS)(
    "RACE RED: transient Sensor link after enqueue and before dispatch must deny %s",
    async (adapterType, provider) => {
      await verifyQueuedDocumentTransition(adapterType, provider, "attach_detach");
    },
  );

  it.each(ADAPTERS)(
    "REGRESSION: issue without sensor-admission executes legacy %s exactly once",
    async (adapterType, provider) => {
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider,
        model: "spy-only",
        summary: "Legacy direct compatibility",
        resultJson: { proof: "direct-legacy-no-document" },
      });

      const f = await createFixture(adapterType, "none");
      const run = await runFixture(f.agentId, f.issueId);
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === run.id)).toHaveLength(1);
      expect(run).toMatchObject({
        status: "succeeded",
        runtimeMode: "legacy",
        nativePhase: null,
      });
      const claim = (run.runnerProfileJson as Record<string, unknown> | null)?.sensorDirectDispatchClaim;
      expect(claim).toBeTruthy();
      expect((claim as Record<string, unknown>).runId).toBe(run.id);

      expect((run.resultJson as Record<string, unknown> | null)?.proof)
        .toBe("direct-legacy-no-document");
    },
  );
  it("BATCH RACE: opposite import issue orders wait for the same first lock and both commit without deadlock", async () => {
    assertIsolatedTestDatabase(testUrl);
    const companyId = randomUUID();
    const issueA = randomUUID(), issueB = randomUUID();
    const [first, second] = [issueA, issueB].sort();
    await db.insert(companies).values({
      id: companyId, name: "P04 reversed parallel batch import",
      issuePrefix: "PB" + companyId.replace(/-/g, "").slice(0, 8),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: first, companyId, title: "P04 import first" },
      { id: second, companyId, title: "P04 import second" },
    ]);

    let announceLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => { announceLock = resolve; });
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const held = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues)
        .where(eq(issues.id, first)).for("update");
      announceLock();
      await release;
    });
    await lockHeld;

    const nameA = "p04-import-asc-" + randomUUID().slice(0, 8);
    const nameB = "p04-import-desc-" + randomUUID().slice(0, 8);
    const forward = documentService(createDb(testUrl, { applicationName: nameA }));
    const reverse = documentService(createDb(testUrl, { applicationName: nameB }));
    const row = (issueId: string, key: string) => ({
      companyId, issueId, key, title: "P04 batch lock order",
      format: "markdown", body: "P04 disposable document",
      createdByAgentId: null, createdByUserId: null,
      createdByRunId: null, sourceTrust: null,
    });
    const pendingA = forward.createIssueDocumentsForImport([
      row(first, "sensor-admission"), row(second, "p04-ordinary-a"),
    ]);
    const pendingB = reverse.createIssueDocumentsForImport([
      row(second, "sensor-admission"), row(first, "p04-ordinary-b"),
    ]);

    try {
      await Promise.all([waitForPostgresLock(nameA), waitForPostgresLock(nameB)]);
    } finally {
      releaseLock();
      await held;
    }
    // The full transactions must settle; a deadlock is a test failure, never dispatch authority.
    await Promise.all([pendingA, pendingB]);
    const stamped = await db.select({ id: issues.id, governedAt: issues.sensorGovernedAt })
      .from(issues).where(eq(issues.companyId, companyId));
    expect(stamped.filter((item) =>
      [first, second].includes(item.id) && item.governedAt !== null,
    )).toHaveLength(2);
    const linked = await db.select({ issueId: issueDocuments.issueId, key: issueDocuments.key })
      .from(issueDocuments).where(eq(issueDocuments.companyId, companyId));
    expect(linked).toHaveLength(4);
  }, 20_000);

  it.each(ADAPTERS)(
    "RACE attach->enqueue: uncommitted Sensor link blocks %s enqueue until governance is committed",
    async (adapterType, provider) => {
      assertIsolatedTestDatabase(testUrl);
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0, signal: null, timedOut: false, provider, model: "spy-only",
        summary: "P04 unsafe enqueue execution",
      });
      const f = await createFixture(adapterType, "none");
      const docId = randomUUID();
      let prepared!: () => void;
      const preparedPromise = new Promise<void>((resolve) => { prepared = resolve; });
      let release!: () => void;
      const permitCommit = new Promise<void>((resolve) => { release = resolve; });
      const writerTx = db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues)
          .where(eq(issues.id, f.issueId)).for("update");
        await tx.insert(documents).values({
          id: docId, companyId: f.companyId, title: "sensor-admission", latestBody: "{}",
        });
        await tx.insert(issueDocuments).values({
          companyId: f.companyId, issueId: f.issueId, documentId: docId,
          key: SENSOR_ADMISSION_DOCUMENT_KEY,
        });
        prepared();
        await permitCommit;
      });
      await preparedPromise;
      const name = "p04-enqueue-wait-" + randomUUID().slice(0, 8);
      const tagged = heartbeatService(createDb(testUrl, { applicationName: name }));
      const invoked = tagged.invoke(
        f.agentId, "on_demand", { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true }, "manual",
      );
      try {
        await waitForPostgresLock(name);
      } finally {
        release();
        await writerTx;
      }
      const queued = await invoked;
      expect(queued).not.toBeNull();
      const run = await waitForTerminalRun(queued!.id);
      await drainHeartbeatRunsToQuiescence(db, tagged);
      expect(execute.mock.calls.filter(([ctx]) => ctx.runId === queued!.id)).toHaveLength(0);
      expect(run).toMatchObject({
        status: "failed", errorCode: "sensor_admission_denied", scheduledRetryAt: null,
      });
      const [current] = await db.select({ at: issues.sensorGovernedAt })
        .from(issues).where(eq(issues.id, f.issueId));
      expect(current?.at).not.toBeNull();
    },
    20_000,
  );


  it.each(ADAPTERS)(
    "RACE enqueue->attach: %s queued transaction commits before waiting document writer, then dispatch denies",
    async (adapterType, provider) => {
      assertIsolatedTestDatabase(testUrl);
      execute.mockReset();
      const f = await createFixture(adapterType, "none");
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, f.agentId));
      const blockerIssueId = randomUUID();
      await db.insert(issues).values({
        id: blockerIssueId, companyId: f.companyId,
        title: "P04 held safe spy before gated enqueue",
        assigneeAgentId: f.agentId, status: "in_progress",
      });
      let unblockAdapter!: () => void;
      const adapterGate = new Promise<void>((resolve) => { unblockAdapter = resolve; });
      const success = {
        exitCode: 0, signal: null, timedOut: false, provider, model: "spy-only",
        summary: "P04 safe blocker",
      } as const;
      execute.mockImplementationOnce(async () => { await adapterGate; return success; });
      execute.mockResolvedValue(success);

      let releaseQueueCommit!: () => void;
      const queueCommitGate = new Promise<void>((resolve) => { releaseQueueCommit = resolve; });
      let queuedInsideTransaction!: () => void;
      const enqueuedPrecommit = new Promise<void>((resolve) => { queuedInsideTransaction = resolve; });
      try {
        const blocker = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: blockerIssueId, taskKey: blockerIssueId, skipIssueComment: true }, "manual",
        );
        expect(blocker).not.toBeNull();
        for (let i = 0; i < 100 && execute.mock.calls.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(execute.mock.calls.length).toBe(1);

        // Intercept ONLY the real queued-run transaction's after-write,
        // before-COMMIT boundary. Its issue row lock remains held while the
        // document service blocks behind it. No fake queue/DB transaction.
        const source = createDb(testUrl, {
          applicationName: "p04-enqueue-first-" + randomUUID().slice(0, 8),
        });
        const intercepted = Object.assign(Object.create(source) as Db, {
          transaction: async (operation: (tx: Db) => Promise<unknown>) =>
            source.transaction(async (tx) => {
              const result = await operation(tx as unknown as Db);
              const value = result as {
                kind?: string; run?: { contextSnapshot?: Record<string, unknown> };
              };
              if (value?.kind === "queued" && value.run?.contextSnapshot?.issueId === f.issueId) {
                queuedInsideTransaction();
                await queueCommitGate;
              }
              return result;
            }),
        });
        const gatedHeartbeat = heartbeatService(intercepted);
        const pendingPromise = gatedHeartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true }, "manual",
        );
        await Promise.race([
          enqueuedPrecommit,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error("P04 queued transaction precommit gate not reached")), 5_000,
          )),
        ]);
        const name = "p04-attach-after-enqueue-" + randomUUID().slice(0, 8);
        const writer = documentService(createDb(testUrl, { applicationName: name }));
        const attachedPromise = writer.upsertIssueDocument({
          issueId: f.issueId, key: SENSOR_ADMISSION_DOCUMENT_KEY,
          format: "markdown", body: "{}",
        });
        try {
          // This explicitly proves attachment is blocked by the genuine
          // not-yet-committed enqueue transaction (not by a third holder).
          await waitForPostgresLock(name);
        } finally {
          releaseQueueCommit();
        }
        const queued = await pendingPromise;
        expect(queued).not.toBeNull();
        await attachedPromise;
        unblockAdapter();
        const run = await waitForTerminalRun(queued!.id);
        await drainHeartbeatRunsToQuiescence(db, gatedHeartbeat);
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        expect(execute.mock.calls.filter(([ctx]) => ctx.runId === queued!.id)).toHaveLength(0);
        expect(run).toMatchObject({
          status: "failed", errorCode: "sensor_admission_denied", scheduledRetryAt: null,
        });
        const successors = await db.select({ id: heartbeatRuns.id })
          .from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, queued!.id));
        expect(successors).toHaveLength(0);
      } finally {
        releaseQueueCommit();
        unblockAdapter();
      }
    },
    25_000,
  );

  it.each(ADAPTERS)(
    "RECOVERY post-claim: %s crash before adapter entry suppresses bounded retry and issue sweeper",
    async (adapterType, provider) => {
      execute.mockReset();
      execute.mockResolvedValue({
        exitCode: 0, signal: null, timedOut: false, provider, model: "spy-only",
        summary: "Unsafe direct recovery after pre-provider crash",
      });
      const f = await createFixture(adapterType, "none");
      const runId = randomUUID(), ownerBootId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: f.companyId, agentId: f.agentId,
        status: "running", runtimeMode: "legacy",
        controllerBootId: ownerBootId,
        controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
        contextSnapshot: { issueId: f.issueId, taskKey: f.issueId },
      });
      await db.update(issues).set({ executionRunId: runId })
        .where(eq(issues.id, f.issueId));
      const dispatch = createPostgresRunDispatchAdapter(db);
      if (!dispatch.claimLegacyDirectDispatch) throw new Error("P04 claim missing");
      const outcome = await dispatch.claimLegacyDirectDispatch({
        companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
        runId, ownerBootId, attemptId: randomUUID(),
        checkContinuationStaleness: false, now: new Date(),
      });
      expect(outcome).toMatchObject({ outcome: "claimed_new" });
      // A process dies after claim commit but BEFORE calling the spy.
      // The persistent profile, not a retry counter, must suppress revival.
      await db.update(heartbeatRuns).set({
        status: "failed", errorCode: "adapter_failed",
        finishedAt: new Date(), controllerLeaseExpiresAt: new Date(0),
      }).where(eq(heartbeatRuns.id, runId));
      const retry = await heartbeat.scheduleBoundedRetry(runId);
      expect(retry).toMatchObject({
        outcome: "not_scheduled",
        errorCode: "legacy_direct_claim_pending_reconciliation",
      });
      await db.update(issues).set({
        status: "todo", executionRunId: null,
      }).where(eq(issues.id, f.issueId));
      // This fixture shares its disposable DB with unrelated completed test
      // cases. Make this committed-claim issue the ONLY eligible candidate,
      // so the aggregate sweeper counters unambiguously describe its decision.
      await db.update(issues).set({ status: "blocked" }).where(sql`
        id <> ${f.issueId}::uuid AND status IN ('todo', 'in_progress', 'in_review')
      `);
      const eligible = await db.select({ id: issues.id }).from(issues).where(sql`
        status IN ('todo', 'in_progress', 'in_review')
        AND assignee_user_id IS NULL
        AND (assignee_agent_id IS NOT NULL OR status = 'in_review')
        AND hidden_at IS NULL
      `);
      expect(eligible.map((row) => row.id)).toEqual([f.issueId]);
      const sweep = await heartbeat.reconcileStrandedAssignedIssues();
      // The real sweeper must identify this sole eligible issue in its
      // changed-issue evidence (as verified by the preceding integration run),
      // without scheduling a replacement in ANY retry or continuation lane.
      expect(sweep.issueIds).toContain(f.issueId);
      expect(sweep.dispatchRequeued).toBe(0);
      expect(sweep.continuationRequeued).toBe(0);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      // The fixture owns an entire unique company. Query ALL its run rows,
      // not only retry children or context.issueId: even an orphan replacement
      // with no retryOfRunId, taskId or nativeIssueId must be detected.
      const companyRuns = await db.select({
        id: heartbeatRuns.id, retryOfRunId: heartbeatRuns.retryOfRunId,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      expect(companyRuns.map((run) => run.id)).toEqual([runId]);
      expect(companyRuns.some((run) => run.retryOfRunId === runId)).toBe(false);
      // Include every invocation in this isolated test, including unlinked
      // replacement runs or unexpected invocations for another runId.
      expect(execute).not.toHaveBeenCalled();
      const [persisted] = await db.select({ profile: heartbeatRuns.runnerProfileJson })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(persisted?.profile?.sensorDirectDispatchClaim).toMatchObject({ runId, issueId: f.issueId });
    },
    20_000,
  );

  it.each(ADAPTERS)(
    "COALESCING: transient Sensor history survives another %s wake merged into the same queued run",
    async (adapterType, provider) => {
      execute.mockReset();
      const f = await createFixture(adapterType, "none");
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
        .where(eq(agents.id, f.agentId));
      const blockerIssueId = randomUUID();
      await db.insert(issues).values({
        id: blockerIssueId, companyId: f.companyId,
        title: "P04 coalescing held fake adapter", assigneeAgentId: f.agentId,
        status: "in_progress",
      });
      let releaseBlocker!: () => void;
      const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const success = {
        exitCode: 0, signal: null, timedOut: false, provider, model: "spy-only",
        summary: "P04 safe blocker",
      } as const;
      execute.mockImplementationOnce(async () => { await blockerGate; return success; });
      execute.mockResolvedValue(success);
      try {
        const blocker = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: blockerIssueId, taskKey: blockerIssueId, skipIssueComment: true }, "manual",
        );
        expect(blocker).not.toBeNull();
        for (let i = 0; i < 100 && execute.mock.calls.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(execute.mock.calls.length).toBe(1);
        const queued = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true }, "manual",
        );
        expect(queued).not.toBeNull();
        expect((await heartbeat.getRun(queued!.id))?.status).toBe("queued");
        const svc = documentService(db);
        await svc.upsertIssueDocument({
          issueId: f.issueId, key: SENSOR_ADMISSION_DOCUMENT_KEY,
          format: "markdown", body: "{}",
        });
        await svc.deleteIssueDocument(f.issueId, SENSOR_ADMISSION_DOCUMENT_KEY);
        const [sticky] = await db.select({ at: issues.sensorGovernedAt })
          .from(issues).where(eq(issues.id, f.issueId));
        expect(sticky?.at).not.toBeNull();
        const merged = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true,
            sensorGovernance: null }, "manual",
        );
        expect(merged?.id).toBe(queued!.id);
        releaseBlocker();
        const run = await waitForTerminalRun(queued!.id);
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        expect(execute.mock.calls.filter(([ctx]) => ctx.runId === queued!.id)).toHaveLength(0);
        expect(run).toMatchObject({
          status: "failed", errorCode: "sensor_admission_denied", scheduledRetryAt: null,
        });
        const successors = await db.select({ id: heartbeatRuns.id })
          .from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, queued!.id));
        expect(successors).toHaveLength(0);
      } finally {
        releaseBlocker();
      }
    },
    25_000,
  );

  it.each(ADAPTERS)(
    "DEFERRED WAKE: %s post-claim wake behind active issue cannot replay after transient Sensor governance",
    async (adapterType, provider) => {
      execute.mockReset();
      const f = await createFixture(adapterType, "none");
      let releaseFirst!: () => void;
      const providerGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const success = {
        exitCode: 0, signal: null, timedOut: false, provider, model: "spy-only",
        summary: "P04 safe first entry",
      } as const;
      execute.mockImplementationOnce(async () => { await providerGate; return success; });
      execute.mockResolvedValue(success);
      try {
        const first = await heartbeat.invoke(
          f.agentId, "on_demand",
          { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true }, "manual",
        );
        expect(first).not.toBeNull();
        for (let i = 0; i < 100 &&
          execute.mock.calls.filter(([ctx]) => ctx.runId === first!.id).length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        expect(execute.mock.calls.filter(([ctx]) => ctx.runId === first!.id)).toHaveLength(1);
        const claim = (await heartbeat.getRun(first!.id))?.runnerProfileJson?.sensorDirectDispatchClaim;
        expect(claim).toMatchObject({ runId: first!.id, issueId: f.issueId });
        const docs = documentService(db);
        await docs.upsertIssueDocument({
          issueId: f.issueId, key: SENSOR_ADMISSION_DOCUMENT_KEY,
          format: "markdown", body: "{}",
        });
        await docs.deleteIssueDocument(f.issueId, SENSOR_ADMISSION_DOCUMENT_KEY);
        // Force a separately durable deferred receipt, not a live-run
        // coalescing optimization or a second dispatch of the same run.
        await heartbeat.wakeup(f.agentId, {
          source: "on_demand", triggerDetail: "system",
          allowRunCoalescing: false, reason: "P04_DEFERRED_GOVERNANCE_TEST",
          contextSnapshot: { issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true },
        });
        const deferred = await db.select({
          id: agentWakeupRequests.id, status: agentWakeupRequests.status,
        }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, f.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`,
        ));
        expect(deferred.length).toBeGreaterThan(0);
        releaseFirst();
        await waitForTerminalRun(first!.id);
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        // The original call was authorized before attach. The deferred
        // re-wake must not turn the now-governed issue into a second call.
        expect(execute.mock.calls.filter(([ctx]) => ctx.runId !== first!.id)).toHaveLength(0);
        const [governed] = await db.select({ at: issues.sensorGovernedAt })
          .from(issues).where(eq(issues.id, f.issueId));
        expect(governed?.at).not.toBeNull();
      } finally {
        releaseFirst();
      }
    },
    25_000,
  );

  it.each(ADAPTERS)(
    "CLASSIFICATION: governed %s cancelled at final heartbeat gate remains stale, never sensor_admission_denied",
    async (adapterType) => {
      execute.mockReset();
      const f = await createFixture(adapterType, "malformed");
      const afterCheck = vi.fn(async ({ issueId }: { runId: string; issueId: string }) => {
        expect(issueId).toBe(f.issueId);
        await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
      });
      const orchestrator = heartbeatService(db, {
        afterResolvedInteractionContinuationDispatchCheck: afterCheck,
      });
      // Interaction-resolution metadata is trusted only when the wake payload
      // identifies the mutation. invoke() has no payload argument and strips
      // interactionId/status before dispatch, making the gate hook unreachable.
      const queued = await orchestrator.wakeup(f.agentId, {
        source: "on_demand", triggerDetail: "manual",
        payload: { mutation: "interaction", issueId: f.issueId },
        contextSnapshot: {
          issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true,
          interactionId: randomUUID(), interactionStatus: "accepted",
          mutation: "interaction", wakeReason: "issue_commented",
        },
      });
      expect(queued).not.toBeNull();
      const run = await waitForTerminalRun(queued!.id);
      await drainHeartbeatRunsToQuiescence(db, orchestrator);
      expect(afterCheck).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(run.status).toBe("cancelled");
      expect(run.errorCode).toBe("issue_cancelled");
      const [issue] = await db.select({ status: issues.status }).from(issues)
        .where(eq(issues.id, f.issueId));
      expect(issue?.status).toBe("cancelled");
    },
    20_000,
  );

  it.each(ADAPTERS)(
    "CLASSIFICATION: governed %s reassigned at final heartbeat gate remains stale, never sensor_admission_denied",
    async (adapterType) => {
      execute.mockReset();
      const f = await createFixture(adapterType, "malformed");
      const afterCheck = vi.fn(async ({ issueId }: { runId: string; issueId: string }) => {
        expect(issueId).toBe(f.issueId);
        await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
      });
      const orchestrator = heartbeatService(db, {
        afterResolvedInteractionContinuationDispatchCheck: afterCheck,
      });
      // Interaction-resolution metadata is trusted only when the wake payload
      // identifies the mutation. invoke() has no payload argument and strips
      // interactionId/status before dispatch, making the gate hook unreachable.
      const queued = await orchestrator.wakeup(f.agentId, {
        source: "on_demand", triggerDetail: "manual",
        payload: { mutation: "interaction", issueId: f.issueId },
        contextSnapshot: {
          issueId: f.issueId, taskKey: f.issueId, skipIssueComment: true,
          interactionId: randomUUID(), interactionStatus: "accepted",
          mutation: "interaction", wakeReason: "issue_commented",
        },
      });
      expect(queued).not.toBeNull();
      const run = await waitForTerminalRun(queued!.id);
      await drainHeartbeatRunsToQuiescence(db, orchestrator);
      expect(afterCheck).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(run.status).toBe("cancelled");
      expect(run.errorCode).toBe("issue_reassigned");
      const [issue] = await db.select({ assignee: issues.assigneeAgentId }).from(issues)
        .where(eq(issues.id, f.issueId));
      expect(issue?.assignee).toBeNull();
    },
    20_000,
  );

});


/**
 * Positive P04 admission is tested at the exact durable, commit-first gate.
 * No real model/provider is registered or called by any of these DB cases.
 */
async function makeGovernedDirectAllowFixture(adapterType: "cline_local" | "agy_local") {
  const base = await createFixture(adapterType, "none");
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const boot = randomUUID();
  const configRevisionId = randomUUID();
  const documentId = randomUUID();
  const revisionId = randomUUID();
  const baselineSha = "c".repeat(40);
  const contextSnapshot = { issueId: base.issueId, executionWorkspaceId: workspaceId };
  await db.insert(projects).values({
    id: projectId, companyId: base.companyId, name: "P04 direct isolated test project",
  });
  await db.insert(executionWorkspaces).values({
    id: workspaceId, companyId: base.companyId, projectId,
    name: "P04 disposable native/direct race workspace", mode: "worktree",
    strategyType: "isolated", metadata: { baseRefSnapshot: { resolvedSha: baselineSha } },
  });
  await db.insert(agentConfigRevisions).values({
    id: configRevisionId, companyId: base.companyId, agentId: base.agentId,
    beforeConfig: {},
    afterConfig: {
      capabilities: null, adapterType, adapterConfig: {}, runtimeConfig: {},
      defaultEnvironmentId: null,
    },
  });
  await db.insert(heartbeatRuns).values({
    id: runId, companyId: base.companyId, agentId: base.agentId,
    status: "running", runtimeMode: "legacy",
    controllerBootId: boot,
    controllerLeaseExpiresAt: new Date(Date.now() + 120_000),
    contextSnapshot,
  });
  await db.update(issues).set({
    executionRunId: runId, executionWorkspaceId: workspaceId,
  }).where(eq(issues.id, base.issueId));
  const sensor = {
    schema: "sensor-admission.v1", issueId: base.issueId,
    requiredCapabilities: ["code"],
    workerQualification: {
      agentId: base.agentId, qualificationRevision: "qualified-direct-test",
      agentConfigRevisionId: configRevisionId, qualifiedCapabilities: ["code"],
    },
    scope: { allowedPaths: ["server/src/**"], forbiddenPaths: [".github/**"] },
    workspace: { id: workspaceId, baselineSha },
    minimumRiskClass: "low",
  };
  const body = JSON.stringify(sensor);
  await db.insert(documents).values({
    id: documentId, companyId: base.companyId,
    title: "P04 governed direct admission", latestBody: body,
  });
  await db.insert(documentRevisions).values({
    id: revisionId, documentId, companyId: base.companyId,
    revisionNumber: 1, body,
  });
  await db.update(documents).set({ latestRevisionId: revisionId })
    .where(eq(documents.id, documentId));
  await db.insert(issueDocuments).values({
    companyId: base.companyId, issueId: base.issueId,
    documentId, key: SENSOR_ADMISSION_DOCUMENT_KEY,
  });
  const input = {
    companyId: base.companyId, issueId: base.issueId, runId,
    agentId: base.agentId, ownerBootId: boot, attemptId: randomUUID(),
    checkContinuationStaleness: false, expectedAdapterType: adapterType, now: new Date(),
  };
  const native = () => ensureNativeCompletionContract({
    db, companyId: base.companyId,
    issue: {
      id: base.issueId, title: "P04 governed direct launch fixture",
      description: null, reviewPolicy: null,
    },
    actorId: base.agentId,
    // A different server-defined criterion forces a new native revision.
    immediateRequest: "Native revision from independent current user direction",
  });
  const direct = () => createPostgresRunDispatchAdapter(db).claimLegacyDirectDispatch!(input);
  return { ...base, runId, workspaceId, boot, input, native, direct, documentId, revisionId };
}

async function observedLockWaiters(minimum: number) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` })
      .from(sql`pg_stat_activity`)
      .where(sql`datname = current_database()
        AND wait_event_type = 'Lock'
        AND query NOT LIKE '%pg_stat_activity%'`);
    if ((row?.count ?? 0) >= minimum) return row!.count;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`P04 expected >=${minimum} PostgreSQL lock waiters were not observed`);
}

/** The second contender must wait on the actual PostgreSQL advisory lock,
 * not merely on a relation/tuple lock acquired elsewhere. */
async function observedCompletionAdvisoryWait() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [row] = await db.select({
      holders: sql<number>`count(*) filter (where granted)::int`,
      waiters: sql<number>`count(*) filter (where not granted)::int`,
    }).from(sql`pg_locks`)
      .where(sql`locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    if ((row?.holders ?? 0) >= 1 && (row?.waiters ?? 0) >= 1) return row;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("P04 native/direct completion advisory holder + waiter not observed");
}

async function expectCommittedDirectPin(f: Awaited<ReturnType<typeof makeGovernedDirectAllowFixture>>) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  const claim = (run?.runnerProfileJson ?? {}).sensorDirectDispatchClaim as
    Record<string, unknown> | undefined;
  expect(claim?.schema).toBe("sensor-direct-dispatch-claim.v2");
  expect(claim?.completionContractId).toBe(run?.completionContractId);
  expect(claim?.completionContractSha256).toBe(run?.completionContractSha256);
  const pin = claim?.sensorAdmission as Record<string, unknown> | undefined;
  expect(pin?.schema).toBe("sensor-admission.pin.v1");
  expect(pin?.workspaceId).toBe(f.workspaceId);
  expect(pin?.documentId).toBe(f.documentId);
  expect(pin?.revisionId).toBe(f.revisionId);
  expect(pin?.completionContractId).toBe(run?.completionContractId);
  expect(pin?.completionContractSha256).toBe(run?.completionContractSha256);
  expect(run?.contextSnapshot?.sensorAdmission).toEqual(pin);
  const rows = await db.select().from(completionContracts)
    .where(eq(completionContracts.issueId, f.issueId));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((c) => c.id === run?.completionContractId &&
    c.canonicalSha256 === run?.completionContractSha256 &&
    c.companyId === f.companyId)).toBe(true);
  expect(new Set(rows.map((x) => x.revision)).size).toBe(rows.length);
  expect(new Set(rows.map((x) => x.canonicalSha256)).size).toBe(rows.length);
  return { run, claim, pin, rows };
}


describe("P04 direct governed ALLOW — actual heartbeat adapter boundary, safe spies only", () => {
  for (const [adapterType, provider] of ADAPTERS) {
    it(`real heartbeat ${adapterType} enters adapter.execute exactly once only after v2 COMMIT`, async () => {
      execute.mockReset();
      const f = await createFixture(adapterType, "none");
      // A project is required for the production workspace persistence path;
      // without one, the runner can fall back to an untracked agent directory
      // and no durable executionWorkspaces row exists to pin.
      const projectId = randomUUID();
      await db.insert(projects).values({
        id: projectId, companyId: f.companyId, name: "P04 safe heartbeat spy workspace",
      });
      await db.update(issues).set({ projectId }).where(eq(issues.id, f.issueId));
      const previousHeartbeat = heartbeat;
      const baselineSha = "d".repeat(40);
      const admissionHookRunIds: string[] = [];
      execute.mockResolvedValue({
        exitCode: 0, signal: null, timedOut: false,
        provider, model: "spy-only", summary: "P04 safe v2 heartbeat ALLOW",
      });
      const prepared = heartbeatService(db, {
        beforeDirectSensorAdmissionCheck: async ({ runId, issueId }) => {
          expect(issueId).toBe(f.issueId);
          // Multiple independent heartbeat runs may reach this test seam.
          // A second pre-claim entry for the SAME run would violate the
          // at-most-once boundary and must remain a test failure.
          if (admissionHookRunIds.includes(runId)) {
            throw new Error(`P04 direct pre-claim hook replay for run ${runId}`);
          }
          admissionHookRunIds.push(runId);
          if (admissionHookRunIds.length > 1) {
            // This is an additional run, not another dispatch of the first
            // run. The trusted document belongs to the issue and persists;
            // never attempt a duplicate issue_documents insert.
            const [existing] = await db.select({ documentId: issueDocuments.documentId })
              .from(issueDocuments).where(and(
                eq(issueDocuments.companyId, f.companyId),
                eq(issueDocuments.issueId, issueId),
                eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
              ));
            expect(existing?.documentId).toBeTruthy();
            return;
          }
          // The production heartbeat must have already provisioned, bound and
          // persisted the SAME workspace in both locked source references.
          // The test only supplies Sensor document and canonical baseline
          // metadata; it does NOT fabricate native session/run provenance.
          const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          const workspaceId = issue?.executionWorkspaceId;
          expect(workspaceId).toBeTruthy();
          expect(run?.contextSnapshot?.executionWorkspaceId).toBe(workspaceId);
          const [workspace] = await db.select().from(executionWorkspaces)
            .where(eq(executionWorkspaces.id, workspaceId!));
          expect(workspace?.status).toBe("active");
          await db.update(executionWorkspaces).set({
            metadata: {
              ...(workspace?.metadata ?? {}),
              baseRefSnapshot: { resolvedSha: baselineSha },
            },
          }).where(eq(executionWorkspaces.id, workspaceId!));
          const [agent] = await db.select().from(agents)
            .where(eq(agents.id, f.agentId));
          expect(agent?.adapterType).toBe(adapterType);
          const configRevisionId = randomUUID();
          await db.insert(agentConfigRevisions).values({
            id: configRevisionId, agentId: f.agentId, companyId: f.companyId,
            beforeConfig: {},
            afterConfig: {
              capabilities: agent!.capabilities,
              adapterType: agent!.adapterType,
              adapterConfig: agent!.adapterConfig,
              runtimeConfig: agent!.runtimeConfig,
              defaultEnvironmentId: agent!.defaultEnvironmentId,
            },
          });
          const documentId = randomUUID(), revisionId = randomUUID();
          const body = JSON.stringify({
            schema: "sensor-admission.v1", issueId: f.issueId,
            requiredCapabilities: ["code"],
            workerQualification: {
              agentId: f.agentId,
              qualificationRevision: "positive-hb-v1",
              agentConfigRevisionId: configRevisionId,
              qualifiedCapabilities: ["code"],
            },
            scope: { allowedPaths: ["server/src/**"], forbiddenPaths: [".github/**"] },
            workspace: { id: workspaceId, baselineSha },
            minimumRiskClass: "low",
          });
          await db.insert(documents).values({
            id: documentId, companyId: f.companyId, title: "sensor-admission",
            latestBody: body,
          });
          await db.insert(documentRevisions).values({
            id: revisionId, companyId: f.companyId, documentId,
            revisionNumber: 1, body,
          });
          await db.update(documents).set({ latestRevisionId: revisionId })
            .where(eq(documents.id, documentId));
          await db.insert(issueDocuments).values({
            issueId: f.issueId, companyId: f.companyId, documentId,
            key: SENSOR_ADMISSION_DOCUMENT_KEY,
          });
        },
      });
      heartbeat = prepared;
      try {
        const run = await runFixture(f.agentId, f.issueId);
        await drainHeartbeatRunsToQuiescence(db, prepared);
        // Observe the exact run under test instead of counting separate
        // heartbeat runs; require a single hook entry for this run.
        expect(admissionHookRunIds.filter((id) => id === run.id)).toEqual([run.id]);
        const hits = execute.mock.calls.filter(([context]) => context.runId === run.id);
        expect(hits).toHaveLength(1);
        const [persisted] = await db.select().from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run.id));
        const claim = persisted?.runnerProfileJson?.sensorDirectDispatchClaim as
          Record<string, unknown> | undefined;
        expect(claim?.schema).toBe("sensor-direct-dispatch-claim.v2");
        expect(claim?.completionContractId).toBe(persisted?.completionContractId);
        expect(claim?.completionContractSha256).toBe(persisted?.completionContractSha256);
        expect(hits[0]?.[0]?.context?.sensorAdmission).toEqual(claim?.sensorAdmission);
        const [completion] = await db.select().from(completionContracts)
          .where(eq(completionContracts.id, persisted!.completionContractId!));
        expect(completion?.canonicalSha256).toBe(claim?.completionContractSha256);
        const replay = await createPostgresRunDispatchAdapter(db).claimLegacyDirectDispatch!({
          companyId: f.companyId, issueId: f.issueId,
          runId: run.id, agentId: f.agentId,
          ownerBootId: persisted!.controllerBootId ?? randomUUID(),
          attemptId: randomUUID(), checkContinuationStaleness: false,
          expectedAdapterType: adapterType, now: new Date(),
        });
        expect(replay.outcome).not.toBe("claimed_new");
        expect(execute.mock.calls.filter(([context]) => context.runId === run.id)).toHaveLength(1);
      } finally {
        await drainHeartbeatRunsToQuiescence(db, prepared);
        heartbeat = previousHeartbeat;
      }
    }, 30_000);
  }
});

describe("P04 positive direct v2 admission — real PostgreSQL, no providers", () => {
  for (const [adapterType] of ADAPTERS) {
    it(`governed ${adapterType} commits exactly one direct v2 completion pin and never replays`, async () => {
      execute.mockClear();
      const f = await makeGovernedDirectAllowFixture(adapterType);
      const first = await f.direct();
      expect(first.outcome).toBe("claimed_new");
      const state = await expectCommittedDirectPin(f);
      expect(first).toMatchObject({ outcome: "claimed_new", pin: state.pin });
      expect((await f.direct()).outcome).toBe("duplicate");
      expect(execute).not.toHaveBeenCalled();
      // Later qualification/document changes do not rewrite the immutable
      // receipt and cannot authorize a second provider entry for this run.
      await db.update(agents).set({ adapterConfig: { revokedAfterCommit: true } })
        .where(eq(agents.id, f.agentId));
      expect((await f.direct()).outcome).toBe("duplicate");
      const after = await expectCommittedDirectPin(f);
      expect(after.claim).toEqual(state.claim);
    }, 30_000);
  }

  it("rejects stale selected direct adapter type BEFORE committing a completion receipt", async () => {
    execute.mockClear();
    const f = await makeGovernedDirectAllowFixture("cline_local");
    const adapter = createPostgresRunDispatchAdapter(db);
    const denied = await adapter.claimLegacyDirectDispatch!({
      ...f.input, expectedAdapterType: "agy_local",
    });
    expect(denied).toMatchObject({
      outcome: "denied", reason: "qualification_config_stale",
    });
    const [before] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, f.runId));
    expect(before?.runnerProfileJson?.sensorDirectDispatchClaim).toBeUndefined();
    expect(before?.completionContractId).toBeNull();
    const contractRows = await db.select().from(completionContracts)
      .where(eq(completionContracts.issueId, f.issueId));
    expect(contractRows).toHaveLength(0);
    expect((await f.direct()).outcome).toBe("claimed_new");
    await expectCommittedDirectPin(f);
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);

  it("v2 protected receipt survives unrelated profile rewrites; column tampering never grants replay", async () => {
    execute.mockClear();
    const f = await makeGovernedDirectAllowFixture("cline_local");
    const admitted = await f.direct();
    expect(admitted.outcome).toBe("claimed_new");
    const before = await expectCommittedDirectPin(f);
    const profile = before.run!.runnerProfileJson ?? {};
    await expect(db.update(heartbeatRuns).set({
      runnerProfileJson: { ...profile, sensorDirectDispatchClaim: { forged: true } },
    }).where(eq(heartbeatRuns.id, f.runId))).rejects.toThrow();
    await db.update(heartbeatRuns).set({
      runnerProfileJson: { ...profile, independentMarker: "allowed" },
    }).where(eq(heartbeatRuns.id, f.runId));
    const [safe] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(safe?.runnerProfileJson?.sensorDirectDispatchClaim).toEqual(before.claim);
    // The protected v2 receipt is the sole frozen authority. Mutable run
    // columns/context are not sufficient to reconstruct or replay it.
    await db.update(heartbeatRuns).set({
      completionContractSha256: "f".repeat(64),
      contextSnapshot: { issueId: f.issueId, executionWorkspaceId: f.workspaceId },
    }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.direct()).outcome).toBe("duplicate");
    const [tampered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(tampered?.runnerProfileJson?.sensorDirectDispatchClaim).toEqual(before.claim);
    expect(tampered?.completionContractSha256).not.toEqual(before.claim?.completionContractSha256);
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);

  for (const first of ["native", "direct"] as const) {
    it(`native allocator ↔ direct v2 completion revision: ${first} obtains advisory first`, async () => {
      execute.mockClear();
      const f = await makeGovernedDirectAllowFixture("cline_local");
      let release!: () => void;
      let blockerReady!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { blockerReady = resolve; });
      // An actual third connection owns issue FOR UPDATE. The two tested
      // sessions must NOT deadlock when the issue is subsequently released.
      const blocker = db.transaction(async (tx) => {
        await tx.select().from(issues)
          .where(eq(issues.id, f.issueId)).for("update");
        blockerReady();
        await gate;
      });
      await ready;
      let nativePromise: ReturnType<typeof f.native> | undefined;
      let directPromise: ReturnType<typeof f.direct> | undefined;
      try {
        if (first === "native") nativePromise = f.native();
        else directPromise = f.direct();
        await observedLockWaiters(1);
        // The second contender must wait behind the same advisory key,
        // not enter issue-first and recreate the old issue↔advisory cycle.
        if (first === "native") directPromise = f.direct();
        else nativePromise = f.native();
        await observedLockWaiters(2);
        const advisory = await observedCompletionAdvisoryWait();
        expect(advisory.holders).toBeGreaterThanOrEqual(1);
        expect(advisory.waiters).toBeGreaterThanOrEqual(1);
      } finally {
        release();
        await blocker;
      }
      const [nativeResult, directResult] = await Promise.all([nativePromise!, directPromise!]);
      expect(nativeResult.row.revision).toBe(first === "native" ? 1 : 2);
      expect(directResult.outcome).toBe("claimed_new");
      const state = await expectCommittedDirectPin(f);
      expect(state.rows).toHaveLength(2);
      expect(execute).not.toHaveBeenCalled();
    }, 30_000);
  }
});
