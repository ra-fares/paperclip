import { and, eq } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  agentConfigRevisions,
  agents,
  completionContracts,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "@paperclipai/db";

import { nativeSha256 } from "./canonical.js";
import {
  SENSOR_ADMISSION_CONTEXT_KEY, SENSOR_ADMISSION_DOCUMENT_KEY,
  SensorAdmissionDeniedError,
  type SensorAdmissionPin,
  record, parseAdmissionPin, parseSensorAdmissionDocumentBody,
  readBaselineSha, executionConfigFingerprintFromAgent,
  executionConfigFingerprintFromRevision, verifySensorAdmissionInTx,
} from "../sensor-admission-verifier.js";

// Shared parsing, canonical validation, fingerprints and pin types.
 // Native owns its original run-first transaction and pin writer.
export * from "../sensor-admission-verifier.js";

export async function assertSensorAdmissionBeforeNativeSpawn(input: {
  db: Db;
  binding: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    executionWorkspaceId: string;
  };
  completionContract: {
    id: string;
    sha256: string;
  };
}): Promise<{ governed: boolean; pin: SensorAdmissionPin | null }> {
  return input.db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        nativeIssueId: heartbeatRuns.nativeIssueId,
        completionContractId: heartbeatRuns.completionContractId,
        completionContractSha256: heartbeatRuns.completionContractSha256,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.binding.runId),
        eq(heartbeatRuns.companyId, input.binding.companyId),
        eq(heartbeatRuns.agentId, input.binding.agentId),
      ))
      .for("update")
      .limit(1);

    if (!run || run.nativeIssueId !== input.binding.issueId) {
      throw new SensorAdmissionDeniedError(
        "binding_conflict",
        "native run binding changed before provider launch",
      );
    }
    const contextSnapshot = record(run.contextSnapshot);
    const existingPin = parseAdmissionPin(contextSnapshot[SENSOR_ADMISSION_CONTEXT_KEY]);

    let documentId: string;
    let revisionId: string;
    let body: string;

    if (existingPin) {
      const [revision] = await tx
        .select({
          documentId: issueDocuments.documentId,
          revisionId: documentRevisions.id,
          body: documentRevisions.body,
        })
        .from(issueDocuments)
        .innerJoin(
          documentRevisions,
          eq(documentRevisions.documentId, issueDocuments.documentId),
        )
        .where(and(
          eq(issueDocuments.companyId, input.binding.companyId),
          eq(issueDocuments.issueId, input.binding.issueId),
          eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
          eq(issueDocuments.documentId, existingPin.documentId),
          eq(documentRevisions.id, existingPin.revisionId),
        ))
        .limit(1);
      if (!revision) {
        throw new SensorAdmissionDeniedError(
          "binding_conflict",
          "pinned sensor admission document revision no longer exists",
        );
      }
      documentId = revision.documentId;
      revisionId = revision.revisionId;
      body = revision.body;
    } else {
      const [document] = await tx
        .select({
          documentId: issueDocuments.documentId,
          latestRevisionId: documents.latestRevisionId,
        })
        .from(issueDocuments)
        .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
        .where(and(
          eq(issueDocuments.companyId, input.binding.companyId),
          eq(issueDocuments.issueId, input.binding.issueId),
          eq(issueDocuments.key, SENSOR_ADMISSION_DOCUMENT_KEY),
        ))
        .limit(1);

      if (!document) {
        return { governed: false, pin: null };
      }
      if (!document.latestRevisionId) {
        throw new SensorAdmissionDeniedError(
          "contract_invalid",
          "sensor-admission document has no revision",
        );
      }
      const [revision] = await tx
        .select({
          id: documentRevisions.id,
          body: documentRevisions.body,
        })
        .from(documentRevisions)
        .where(and(
          eq(documentRevisions.id, document.latestRevisionId),
          eq(documentRevisions.documentId, document.documentId),
          eq(documentRevisions.companyId, input.binding.companyId),
        ))
        .limit(1);
      if (!revision) {
        throw new SensorAdmissionDeniedError(
          "contract_invalid",
          "latest sensor-admission revision is missing",
        );
      }
      documentId = document.documentId;
      revisionId = revision.id;
      body = revision.body;
    }

    if (
      run.completionContractId !== input.completionContract.id ||
      run.completionContractSha256 !== input.completionContract.sha256
    ) {
      throw new SensorAdmissionDeniedError(
        "completion_contract_mismatch",
        "run completion contract binding does not match native execution input",
      );
    }

    const contract = parseSensorAdmissionDocumentBody(body);
    const contractSha256 = nativeSha256(contract);

    if (existingPin && existingPin.contractSha256 !== contractSha256) {
      throw new SensorAdmissionDeniedError(
        "binding_conflict",
        "pinned sensor admission revision hash changed",
      );
    }

    const [issue] = await tx
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        executionWorkspaceId: issues.executionWorkspaceId,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.binding.companyId),
        eq(issues.id, input.binding.issueId),
      ))
      .limit(1);
    if (!issue || issue.assigneeAgentId !== input.binding.agentId) {
      throw new SensorAdmissionDeniedError(
        "assignee_mismatch",
        "issue assignee no longer matches the executing agent",
      );
    }
    if (
      issue.executionWorkspaceId !== input.binding.executionWorkspaceId ||
      issue.executionWorkspaceId !== contract.workspace.id
    ) {
      throw new SensorAdmissionDeniedError(
        "workspace_mismatch",
        "issue, run, and sensor contract do not reference the same execution workspace",
      );
    }

    const [agent] = await tx
      .select({
        id: agents.id,
        capabilities: agents.capabilities,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
        defaultEnvironmentId: agents.defaultEnvironmentId,
      })
      .from(agents)
      .where(and(
        eq(agents.companyId, input.binding.companyId),
        eq(agents.id, input.binding.agentId),
      ))
      .limit(1);
    if (!agent) {
      throw new SensorAdmissionDeniedError(
        "qualification_missing",
        "executing agent no longer exists",
      );
    }

    const [qualificationConfig] = await tx
      .select({
        id: agentConfigRevisions.id,
        afterConfig: agentConfigRevisions.afterConfig,
      })
      .from(agentConfigRevisions)
      .where(and(
        eq(agentConfigRevisions.companyId, input.binding.companyId),
        eq(agentConfigRevisions.agentId, input.binding.agentId),
        eq(
          agentConfigRevisions.id,
          contract.workerQualification.agentConfigRevisionId,
        ),
      ))
      .limit(1);
    if (!qualificationConfig) {
      throw new SensorAdmissionDeniedError(
        "qualification_missing",
        "referenced agent configuration revision does not exist",
      );
    }

    const [workspace] = await tx
      .select({
        id: executionWorkspaces.id,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(and(
        eq(executionWorkspaces.companyId, input.binding.companyId),
        eq(executionWorkspaces.id, input.binding.executionWorkspaceId),
      ))
      .limit(1);
    const baselineSha = workspace ? readBaselineSha(workspace.metadata) : null;
    if (!baselineSha) {
      throw new SensorAdmissionDeniedError(
        "baseline_missing",
        "execution workspace has no persisted baseRefSnapshot.resolvedSha",
      );
    }

    const [completion] = await tx
      .select({
        id: completionContracts.id,
        canonicalSha256: completionContracts.canonicalSha256,
        risk: completionContracts.risk,
      })
      .from(completionContracts)
      .where(and(
        eq(completionContracts.companyId, input.binding.companyId),
        eq(completionContracts.issueId, input.binding.issueId),
        eq(completionContracts.id, input.completionContract.id),
      ))
      .limit(1);
    if (
      !completion ||
      completion.canonicalSha256 !== input.completionContract.sha256
    ) {
      throw new SensorAdmissionDeniedError(
        "completion_contract_mismatch",
        "native completion contract row does not match the execution binding",
      );
    }

    const verified = await verifySensorAdmissionInTx(tx as unknown as Db, {
      issueId: input.binding.issueId,
      agentId: input.binding.agentId,
      documentId,
      revisionId,
      documentBody: body,
      workspaceId: input.binding.executionWorkspaceId,
      baselineSha,
      completionContractId: input.completionContract.id,
      completionContractSha256: input.completionContract.sha256,
      completionRisk: completion.risk,
      qualificationConfigMatches:
        executionConfigFingerprintFromAgent(agent) ===
        executionConfigFingerprintFromRevision(qualificationConfig.afterConfig),
    }, { mode: "native", sourceLockPolicy: "native-existing" });

    const pin: SensorAdmissionPin = existingPin ?? verified.pin;

    if (
      existingPin &&
      (
        existingPin.documentId !== documentId ||
        existingPin.revisionId !== revisionId ||
        existingPin.qualificationRevision !== contract.workerQualification.qualificationRevision ||
        existingPin.agentConfigRevisionId !== contract.workerQualification.agentConfigRevisionId ||
        existingPin.workspaceId !== contract.workspace.id ||
        existingPin.baselineSha !== baselineSha ||
        existingPin.completionContractId !== input.completionContract.id ||
        existingPin.completionContractSha256 !== input.completionContract.sha256
      )
    ) {
      throw new SensorAdmissionDeniedError(
        "binding_conflict",
        "pinned sensor admission binding no longer matches this run",
      );
    }

    if (!existingPin) {
      await tx
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...contextSnapshot,
            [SENSOR_ADMISSION_CONTEXT_KEY]: pin,
          },
          updatedAt: new Date(),
        })
        .where(and(
          eq(heartbeatRuns.id, input.binding.runId),
          eq(heartbeatRuns.companyId, input.binding.companyId),
        ));
    }

    return { governed: true, pin };
  });
}
