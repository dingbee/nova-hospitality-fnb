-- LB-04 governed analytical foundation. UAT-only; production promotion requires separate approval.
-- POS, recipes, stock, procurement and financial records remain LexiBite-owned.
CREATE TABLE IF NOT EXISTS public.lb04_property_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
 staynas_organisation_id uuid NOT NULL, staynas_property_id uuid NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended')),
 verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(property_id), UNIQUE(staynas_organisation_id,staynas_property_id)
);
CREATE TABLE IF NOT EXISTS public.lb04_analytical_metrics (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
 outlet_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
 metric_code text NOT NULL, dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
 value numeric(20,6) NOT NULL, currency text CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
 period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
 source_system text NOT NULL CHECK(source_system IN ('staynas','lexibite','integration')),
 source_record_ref text NOT NULL, source_updated_at timestamptz,
 calculated_at timestamptz NOT NULL DEFAULT now(),
 freshness text NOT NULL DEFAULT 'unknown' CHECK(freshness IN ('current','stale','unknown')),
 reconciliation_status text NOT NULL DEFAULT 'not_applicable' CHECK(reconciliation_status IN ('not_applicable','pending','reconciled','disputed')),
 CHECK(period_end>period_start),
 UNIQUE(property_id,metric_code,period_start,period_end,source_system,source_record_ref)
);
CREATE INDEX IF NOT EXISTS lb04_metrics_property_period_idx ON public.lb04_analytical_metrics(property_id,period_start,metric_code);
CREATE TABLE IF NOT EXISTS public.lb04_forecasts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
 metric_code text NOT NULL, forecast_period_start timestamptz NOT NULL, forecast_period_end timestamptz NOT NULL,
 projected_value numeric(20,6) NOT NULL CHECK(projected_value>=0),
 currency text CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
 method text NOT NULL, model_version text NOT NULL, input_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
 reliability text NOT NULL CHECK(reliability IN ('high','moderate','low','insufficient_data')),
 generated_at timestamptz NOT NULL DEFAULT now(), CHECK(forecast_period_end>forecast_period_start)
);
CREATE INDEX IF NOT EXISTS lb04_forecasts_property_period_idx ON public.lb04_forecasts(property_id,forecast_period_start,metric_code);
CREATE TABLE IF NOT EXISTS public.lb04_recommendations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
 recommendation_type text NOT NULL CHECK(recommendation_type IN ('inventory_replenishment','procurement','operations')),
 status text NOT NULL DEFAULT 'advisory' CHECK(status IN ('advisory','accepted','dismissed','expired')),
 payload jsonb NOT NULL, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
 expected_impact jsonb NOT NULL DEFAULT '{}'::jsonb,
 generated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.lb04_anomalies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
 property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
 outlet_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
 anomaly_code text NOT NULL, severity text NOT NULL CHECK(severity IN ('info','warning','critical')),
 detection_method text NOT NULL, evidence jsonb NOT NULL, recommended_investigation text NOT NULL,
 detected_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved','dismissed'))
);
CREATE TABLE IF NOT EXISTS public.lb04_model_registry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), model_code text NOT NULL, model_version text NOT NULL,
 method text NOT NULL, training_window_start timestamptz, training_window_end timestamptz,
 inputs jsonb NOT NULL DEFAULT '[]'::jsonb, limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(model_code,model_version)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['lb04_property_links','lb04_analytical_metrics','lb04_forecasts','lb04_recommendations','lb04_anomalies','lb04_model_registry'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM anon,authenticated',t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
 END LOOP;
END $$;
GRANT SELECT ON public.lb04_property_links,public.lb04_analytical_metrics,public.lb04_forecasts,public.lb04_recommendations,public.lb04_anomalies TO authenticated;
CREATE POLICY lb04_links_read ON public.lb04_property_links FOR SELECT TO authenticated USING(public.restaurant_can_read_scoped(tenant_id,property_id));
CREATE POLICY lb04_metrics_read ON public.lb04_analytical_metrics FOR SELECT TO authenticated USING(public.restaurant_can_read_scoped(tenant_id,property_id));
CREATE POLICY lb04_forecasts_read ON public.lb04_forecasts FOR SELECT TO authenticated USING(public.restaurant_can_read_scoped(tenant_id,property_id));
CREATE POLICY lb04_recommendations_read ON public.lb04_recommendations FOR SELECT TO authenticated USING(public.restaurant_can_read_scoped(tenant_id,property_id));
CREATE POLICY lb04_anomalies_read ON public.lb04_anomalies FOR SELECT TO authenticated USING(public.restaurant_can_read_scoped(tenant_id,property_id));
