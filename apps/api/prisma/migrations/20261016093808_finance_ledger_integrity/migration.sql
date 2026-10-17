-- Ledger integrity (hand-written, reviewed): journal entries and lines are append-only, every
-- entry balances, and every line is either a debit or a credit.
-- Corrections are new entries (LedgerService). There is no bypass setting: nothing in the
-- application updates or deletes journal rows. Resetting a database (TRUNCATE) is not affected
-- by these row triggers.

CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger rows are immutable (%), post a correcting entry instead', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Checked at commit, so the lines of one entry can be inserted one by one in a transaction.
CREATE OR REPLACE FUNCTION ledger_entry_balanced() RETURNS trigger AS $$
DECLARE
  d NUMERIC;
  c NUMERIC;
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) INTO d, c FROM "journal_lines" WHERE "entryId" = NEW."entryId";
  IF d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debits %, credits %)', NEW."entryId", d, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced();

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_one_side" CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0));
