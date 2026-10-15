import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentConfigRevisions, agents, completionContracts,
  documentRevisions, documents, executionWorkspaces, heartbeatRuns,
  issueDocuments, issues,
} from "@paperclipai/db";
import {
  buildNativeCompletionContract,
  NATIVE_COMPLETION_CONTRACT_SCHEMA,
  NATIVE_COMPLETION_POLICY_VERSION,
  resolveNativeCompletionPolicy,
} from "./native-runtime/completion-contracts.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import {
  SENSOR_ADMISSION_DOCUMENT_KEY,
  SensorAdmissionDeniedError,
  type SensorAdmissionPin,
  executionConfigFingerprintFromAgent,
  executionConfigFingerprintFromRevision,
  parseSensorAdmissionDocumentBody,
  readBaselineSha,
  verifySensorAdmissionInTx,
} from "./sensor-admission-verifier.js";

type DirectIssue = typeof issues.$inferSelect;
type DirectRun = typeof heartbeatRuns.$inferSelect;

/**
 * Called only with the SAME transaction which already holds the per-issue
 * native-completion advisory lock, then issues FOR UPDATE, then run FOR UPDATE.
 * NEVER open a nested transaction or acquire the advisory after issue lock.
 */
export async function ensureDirectCompletionContractInAdmissionTx(
  tx: Db, issue: DirectIssue, run: DirectRun,
): Promise<typeof completionContracts.$inferSelect> {
  const policy = resolveNativeCompletionPolicy(issue);
  const candidate = (revision: number) => {
    const contract = buildNativeCompletionContract(issue, { revision });
    const canonicalSha256 = nativeSha256({
      schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
      policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
      ...policy, contract,
    });
    return { contract, canonicalSha256 };
  };
  const hasId = run.completionContractId != null;
  const hasSha = run.completionContractSha256 != null;
  if (hasId !== hasSha) {
    throw new SensorAdmissionDeniedError("completion_contract_mismatch", "half-bound direct completion contract");
  }

  const [latest] = await tx.select().from(completionContracts)
    .where(and(
      eq(completionContracts.companyId, issue.companyId),
      eq(completionContracts.issueId, issue.id),
    ))
    .orderBy(desc(completionContracts.revision)).limit(1);

  if (hasId) {
    const [bound] = await tx.select().from(completionContracts)
      .where(and(
        eq(completionContracts.id, run.completionContractId!),
        eq(completionContracts.companyId, issue.companyId),
        eq(completionContracts.issueId, issue.id),
      )).for("share").limit(1);
    if (!bound || bound.canonicalSha256 !== run.completionContractSha256 ||
        bound.schemaVersion !== NATIVE_COMPLETION_CONTRACT_SCHEMA ||
        bound.policyVersion !== NATIVE_COMPLETION_POLICY_VERSION ||
        bound.risk !== policy.risk || bound.completionAuthority !== policy.completionAuthority ||
        bound.canonicalSha256 !== candidate(bound.revision).canonicalSha256 ||
        bound.id !== latest?.id) {
      throw new SensorAdmissionDeniedError(
        "completion_contract_mismatch", "pre-existing direct binding is stale or cannot be verified",
      );
    }
    return bound;
  }

  const proposal = candidate(latest?.revision ?? 1);
  if (latest?.canonicalSha256 === proposal.canonicalSha256 &&
      latest.schemaVersion === NATIVE_COMPLETION_CONTRACT_SCHEMA &&
      latest.policyVersion === NATIVE_COMPLETION_POLICY_VERSION &&
      latest.risk === policy.risk && latest.completionAuthority === policy.completionAuthority) {
    return latest;
  }

  const revision = latest ? latest.revision + 1 : 1;
  const next = candidate(revision);
  const [inserted] = await tx.insert(completionContracts).values({
    companyId: issue.companyId, issueId: issue.id,
    revision, schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
    policyVersion: NATIVE_COMPLETION_POLICY_VERSION, ...policy,
    incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: next.contract as unknown as Record<string, unknown>,
    canonicalSha256: next.canonicalSha256,
    createdByActorType: "system", createdByActorId: run.agentId,
    supersedesContractId: latest?.id ?? null,
  }).returning();
  if (!inserted) {
    throw new SensorAdmissionDeniedError("completion_contract_mismatch", "completion contract insertion failed");
  }
  return inserted;
}

/** All facts here must be read under the direct claim's already-held locks.
 * On any failure no receipt is written and the adapter is not entered. */
export async function verifyGovernedDirectAdmissionInTx(
  tx: Db, issue: DirectIssue, run: DirectRun,
): Promise<{ pin: SensorAdmissionPin; completion: typeof completionContracts.$inferSelect }> {
  if (issue.companyId !== run.companyId || issue.assigneeAgentId !== run.agentId ||
      issue.executionRunId !== run.id || issue.executionWorkspaceId == null) {
    throw new SensorAdmissionDeniedError("binding_conflict", "direct run issue ownership changed");
  }
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  if (context.issueId !== issue.id || context.executionWorkspaceId !== issue.executionWorkspaceId) {
    throw new SensorAdmissionDeniedError("workspace_mismatch", "direct run context is not bound to current workspace");
  }

  // Document restore updates documents before issue_documents. First acquire
  // the document row lock, then the link lock; reread BOTH after waiting.
  const [hint] = await tx.select({ documentId: issueDocuments.documentId })
    .from(issueDocuments).where(and(
      eq(issueDocuments.companyId, issue.companyId),
      eq(issueDocuments.issueId, issue.id),
      eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
    )).limit(1);
  if (!hint) {
    throw new SensorAdmissionDeniedError("binding_conflict", "sticky governed issue lacks Sensor document");
  }
  const [document] = await tx.select().from(documents)
    .where(and(eq(documents.id, hint.documentId), eq(documents.companyId, issue.companyId)))
    .for("update").limit(1);
  const [link] = await tx.select().from(issueDocuments).where(and(
    eq(issueDocuments.companyId, issue.companyId),
    eq(issueDocuments.issueId, issue.id),
    eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
  )).for("update").limit(1);
  if (!document?.latestRevisionId || !link || link.documentId !== document.id) {
    throw new SensorAdmissionDeniedError("binding_conflict", "document link/revision changed during direct admission");
  }
  // LatestRevisionId was read AFTER the document lock. Do not pin the hint.
  const [revision] = await tx.select().from(documentRevisions).where(and(
    eq(documentRevisions.id, document.latestRevisionId),
    eq(documentRevisions.documentId, document.id),
    eq(documentRevisions.companyId, issue.companyId),
  )).for("share").limit(1);
  if (!revision) {
    throw new SensorAdmissionDeniedError("contract_invalid", "Sensor document revision missing");
  }
  const contract = parseSensorAdmissionDocumentBody(revision.body);

  const [agent] = await tx.select().from(agents).where(and(
    eq(agents.id, run.agentId), eq(agents.companyId, run.companyId),
  )).for("update").limit(1);
  if (!agent || (agent.adapterType !== "cline_local" && agent.adapterType !== "agy_local")) {
    throw new SensorAdmissionDeniedError("qualification_missing", "direct adapter/agent not eligible");
  }
  const [config] = await tx.select().from(agentConfigRevisions).where(and(
    eq(agentConfigRevisions.id, contract.workerQualification.agentConfigRevisionId),
    eq(agentConfigRevisions.companyId, issue.companyId),
    eq(agentConfigRevisions.agentId, run.agentId),
  )).for("share").limit(1);
  if (!config) {
    throw new SensorAdmissionDeniedError("qualification_missing", "qualification config revision missing");
  }
  const [workspace] = await tx.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, issue.executionWorkspaceId),
    eq(executionWorkspaces.companyId, issue.companyId),
  )).for("update").limit(1);
  const baselineSha = workspace ? readBaselineSha(workspace.metadata) : null;
  if (!baselineSha) {
    throw new SensorAdmissionDeniedError("baseline_missing", "workspace has no persisted baseline SHA");
  }
  if (workspace?.status !== "active") {
    throw new SensorAdmissionDeniedError("workspace_mismatch", "execution workspace is not active");
  }

  // The advisory allocator lock was acquired before issues FOR UPDATE.
  // The helper must never attempt to acquire it for the first time here.
  const completion = await ensureDirectCompletionContractInAdmissionTx(tx, issue, run);
  const verified = await verifySensorAdmissionInTx(tx, {
    issueId: issue.id, agentId: run.agentId,
    documentId: document.id, revisionId: revision.id, documentBody: revision.body,
    workspaceId: workspace.id, baselineSha,
    completionContractId: completion.id,
    completionContractSha256: completion.canonicalSha256,
    completionRisk: completion.risk,
    qualificationConfigMatches:
      executionConfigFingerprintFromAgent(agent) ===
      executionConfigFingerprintFromRevision(config.afterConfig),
  }, { mode: "direct", sourceLockPolicy: "direct-locked" });
  return { pin: verified.pin, completion };
}
