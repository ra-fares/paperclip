ALTER TABLE "execution_workspaces" ADD COLUMN "identity_revision" bigint DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "identity_revision" bigint DEFAULT '0' NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION p04_project_workspace_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $p04$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.identity_revision := 0;
    RETURN NEW;
  END IF;
  IF OLD.identity_revision < 0 THEN
    RAISE EXCEPTION 'invalid negative identity revision';
  END IF;
  IF ROW(NEW.company_id, NEW.project_id, NEW.source_type, NEW.cwd, NEW.repo_url, NEW.repo_ref, NEW.default_ref, NEW.visibility, NEW.setup_command, NEW.cleanup_command, NEW.remote_provider, NEW.remote_workspace_ref, NEW.shared_workspace_key, NEW.is_primary, NEW.metadata) IS DISTINCT FROM ROW(OLD.company_id, OLD.project_id, OLD.source_type, OLD.cwd, OLD.repo_url, OLD.repo_ref, OLD.default_ref, OLD.visibility, OLD.setup_command, OLD.cleanup_command, OLD.remote_provider, OLD.remote_workspace_ref, OLD.shared_workspace_key, OLD.is_primary, OLD.metadata) THEN
    -- BIGINT overflow fails the whole transaction; no wraparound or reset.
    NEW.identity_revision := OLD.identity_revision + 1;
  ELSE
    NEW.identity_revision := OLD.identity_revision;
  END IF;
  RETURN NEW;
END;
$p04$;
--> statement-breakpoint
CREATE TRIGGER p04_project_workspace_identity_revision_guard
  BEFORE INSERT OR UPDATE ON project_workspaces
  FOR EACH ROW EXECUTE FUNCTION p04_project_workspace_identity_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION p04_execution_workspace_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $p04$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.identity_revision := 0;
    RETURN NEW;
  END IF;
  IF OLD.identity_revision < 0 THEN
    RAISE EXCEPTION 'invalid negative identity revision';
  END IF;
  IF ROW(NEW.company_id, NEW.project_id, NEW.project_workspace_id, NEW.source_issue_id, NEW.mode, NEW.strategy_type, NEW.status, NEW.cwd, NEW.repo_url, NEW.base_ref, NEW.branch_name, NEW.provider_type, NEW.provider_ref, NEW.derived_from_execution_workspace_id) IS DISTINCT FROM ROW(OLD.company_id, OLD.project_id, OLD.project_workspace_id, OLD.source_issue_id, OLD.mode, OLD.strategy_type, OLD.status, OLD.cwd, OLD.repo_url, OLD.base_ref, OLD.branch_name, OLD.provider_type, OLD.provider_ref, OLD.derived_from_execution_workspace_id)
     OR (NEW.metadata - 'reopenPendingConsumptionSince') IS DISTINCT FROM
        (OLD.metadata - 'reopenPendingConsumptionSince') THEN
    -- BIGINT overflow fails the whole transaction; no wraparound or reset.
    NEW.identity_revision := OLD.identity_revision + 1;
  ELSE
    NEW.identity_revision := OLD.identity_revision;
  END IF;
  RETURN NEW;
END;
$p04$;
--> statement-breakpoint
CREATE TRIGGER p04_execution_workspace_identity_revision_guard
  BEFORE INSERT OR UPDATE ON execution_workspaces
  FOR EACH ROW EXECUTE FUNCTION p04_execution_workspace_identity_revision();
