import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { documentService } from "../services/documents.js";
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
  for (const [adapterType] of ADAPTERS) unregisterServerAdapter(adapterType);
  if (testUrl) await closeRegisteredClients(testUrl);
});

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
      expect((run.resultJson as Record<string, unknown> | null)?.proof)
        .toBe("direct-legacy-no-document");
    },
  );
});
