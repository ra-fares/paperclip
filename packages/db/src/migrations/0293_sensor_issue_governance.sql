-- T-P04-DIRECT-ADMISSION-01: irreversible issue-level Sensor governance.
-- DB integrity backstop: services acquire issue locks BEFORE editing document links.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "sensor_governed_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION p04_sensor_issue_governance_immutable() RETURNS trigger LANGUAGE plpgsql AS $p04$
BEGIN
  IF OLD.sensor_governed_at IS NOT NULL AND
     NEW.sensor_governed_at IS DISTINCT FROM OLD.sensor_governed_at THEN
    RAISE EXCEPTION 'sensor_governed_at is immutable once set';
  END IF;
  RETURN NEW;
END;
$p04$;
--> statement-breakpoint
CREATE TRIGGER p04_sensor_issue_governance_immutable_guard
  BEFORE UPDATE OF sensor_governed_at ON issues
  FOR EACH ROW EXECUTE FUNCTION p04_sensor_issue_governance_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION p04_sensor_link_governance_mark() RETURNS trigger LANGUAGE plpgsql AS $p04$
BEGIN
  IF NEW.key = 'sensor-admission' THEN
    UPDATE issues
    SET sensor_governed_at = COALESCE(sensor_governed_at, transaction_timestamp())
    WHERE id = NEW.issue_id AND company_id = NEW.company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sensor document issue/company does not exist';
    END IF;
  END IF;
  RETURN NEW;
END;
$p04$;
--> statement-breakpoint
CREATE TRIGGER p04_sensor_link_governance_mark_trigger
  AFTER INSERT OR UPDATE OF key, issue_id, company_id ON issue_documents
  FOR EACH ROW EXECUTE FUNCTION p04_sensor_link_governance_mark();
--> statement-breakpoint
-- Protect ONLY the committed direct-dispatch receipt. All other runner-profile
-- keys remain editable, including when the profile is reconstructed by legacy code.
-- SQL NULL, JSON null and a missing key are distinct states.
CREATE OR REPLACE FUNCTION p04_sensor_direct_claim_immutable() RETURNS trigger LANGUAGE plpgsql AS $p04$
BEGIN
  IF jsonb_typeof(OLD.runner_profile_json) = 'object'
    AND OLD.runner_profile_json ? 'sensorDirectDispatchClaim' THEN
    IF jsonb_typeof(NEW.runner_profile_json) IS DISTINCT FROM 'object'
       OR NOT (NEW.runner_profile_json ? 'sensorDirectDispatchClaim')
       OR (NEW.runner_profile_json -> 'sensorDirectDispatchClaim') IS DISTINCT FROM
          (OLD.runner_profile_json -> 'sensorDirectDispatchClaim') THEN
      RAISE EXCEPTION 'sensorDirectDispatchClaim cannot be removed or replaced';
    END IF;
  END IF;
  RETURN NEW;
END;
$p04$;
--> statement-breakpoint
CREATE TRIGGER p04_sensor_direct_claim_immutable_guard
  BEFORE UPDATE OF runner_profile_json ON heartbeat_runs
  FOR EACH ROW EXECUTE FUNCTION p04_sensor_direct_claim_immutable();
--> statement-breakpoint
-- A backfill records what is observable NOW, not the deleted history.
-- Compare identifiers as text and validate JSON types before reading fields.
UPDATE issues AS i
SET sensor_governed_at = transaction_timestamp()
WHERE i.sensor_governed_at IS NULL AND (
  EXISTS (
    SELECT 1 FROM issue_documents AS d
    WHERE d.company_id = i.company_id
      AND d.issue_id = i.id
      AND d.key = 'sensor-admission'
  )
  OR EXISTS (
    SELECT 1 FROM heartbeat_runs AS r
    WHERE r.company_id = i.company_id
      AND jsonb_typeof(r.runner_profile_json) = 'object'
      AND jsonb_typeof(r.runner_profile_json -> 'sensorGovernance') = 'object'
      AND r.runner_profile_json -> 'sensorGovernance' ->> 'schema' = 'sensor-governance.queued.v1'
      AND jsonb_typeof(r.runner_profile_json -> 'sensorGovernance' -> 'issueId') = 'string'
      AND r.runner_profile_json -> 'sensorGovernance' ->> 'issueId' = i.id::text
  )
);
