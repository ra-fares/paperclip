import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

async function createFixture(adapterType: string, withMalformedAdmission: boolean) {
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

  if (withMalformedAdmission) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const body = '{"schema":"sensor-admission.v1",INVALID_JSON';
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

      const f = await createFixture(adapterType, true);
      const run = await runFixture(f.agentId, f.issueId);
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

      const f = await createFixture(adapterType, false);
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
