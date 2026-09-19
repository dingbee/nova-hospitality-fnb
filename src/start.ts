import { createStart } from "@tanstack/react-start";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { withRequestCorrelation } from "@/lib/observability/server-fn-correlation";

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth, withRequestCorrelation],
}));
