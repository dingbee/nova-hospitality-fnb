import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCurrentPrincipal } from "./rbac.functions";
import type { Permission } from "./permissions";

/**
 * Presentation-only helper. Hiding a control is a courtesy; the server
 * function behind it enforces the same permission independently.
 */
export function usePrincipal() {
  const fn = useServerFn(getCurrentPrincipal);
  return useQuery({ queryKey: ["nova", "principal"], queryFn: () => fn({}), staleTime: 5 * 60_000 });
}

export function useCan(perm: Permission): boolean {
  const { data } = usePrincipal();
  return Boolean(data?.permissions.includes(perm));
}
