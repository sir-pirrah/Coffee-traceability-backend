-- Make the role predicates return a definite boolean instead of NULL.
--
-- `app_current_role()` is NULL whenever the request carries no identity, and
-- `NULL = 'SUPER_ADMIN'` evaluates to NULL rather than false. That made
-- `app_is_unrestricted()` and `app_is_farmer()` return NULL for an
-- unauthenticated caller.
--
-- Nothing is currently exploitable: a policy treats a NULL predicate as "does
-- not match", which is the outcome we want. But the moment one of these is used
-- negated — `NOT app_is_farmer()` — NULL propagates and that branch also fails
-- to match, so a check meant to catch every non-farmer would quietly catch none.
-- A three-valued predicate underneath a security rule is a trap regardless of
-- whether it has been stepped in yet, so pin both to two values.

CREATE OR REPLACE FUNCTION app_is_unrestricted() RETURNS BOOLEAN AS $$
  SELECT app_is_system() OR COALESCE(app_current_role() = 'SUPER_ADMIN', false);
$$ LANGUAGE sql STABLE PARALLEL SAFE;

CREATE OR REPLACE FUNCTION app_is_farmer() RETURNS BOOLEAN AS $$
  SELECT COALESCE(app_current_role() = 'FARMER', false);
$$ LANGUAGE sql STABLE PARALLEL SAFE;
