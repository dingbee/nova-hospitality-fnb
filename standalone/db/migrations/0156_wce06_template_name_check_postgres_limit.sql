-- WCE-06 correction: 0144 declared
--   CHECK (template_name ~ '^[a-z0-9_]{3,512}$')
-- PostgreSQL caps regex repetition counts at 255 (RE_DUP_MAX), so evaluating
-- that constraint raises "invalid regular expression: invalid repetition
-- count(s)" and every INSERT/UPDATE of wa_message_templates fails. Replace it
-- with an equivalent, evaluable predicate (same character set, same 3..512
-- length bounds, matching Meta's template-name rule and the application
-- validators). No data is modified; no row can satisfy the old constraint.

ALTER TABLE public.wa_message_templates
  DROP CONSTRAINT IF EXISTS wa_message_templates_template_name_check;

ALTER TABLE public.wa_message_templates
  ADD CONSTRAINT wa_message_templates_template_name_check
  CHECK (
    template_name ~ '^[a-z0-9_]+$'
    AND char_length(template_name) BETWEEN 3 AND 512
  );
