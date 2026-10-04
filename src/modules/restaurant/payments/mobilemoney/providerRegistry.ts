/**
 * Provider-neutral Mobile Money registry.
 *
 * Product metadata only. No provider SDK calls, credentials, URLs or payment
 * logic live here. A provider becomes executable only after its server-side
 * adapter is certified against MobileMoneyAdapter.
 */
import { z } from "zod";
import type { MobileMoneyNetwork } from "./contracts";

export const MOBILE_MONEY_PROVIDER_CODES = [
  "test",
  "stakaba",
  "clickpesa",
  "payin",
  "snippe",
  "malipopay",
] as const;

export type MobileMoneyProviderCode = (typeof MOBILE_MONEY_PROVIDER_CODES)[number];

export const mobileMoneyProviderCodeSchema = z.enum(MOBILE_MONEY_PROVIDER_CODES);

export interface MobileMoneyProviderDefinition {
  code: MobileMoneyProviderCode;
  name: string;
  automatic: boolean;
  supportedNetworks: readonly MobileMoneyNetwork[];
  credentialFields: readonly string[];
  certified: boolean;
}

const ALL_CONNECTED_NETWORKS: readonly MobileMoneyNetwork[] = [
  "mpesa",
  "mixx_yas",
  "airtel_money",
  "halopesa",
];

export const MOBILE_MONEY_PROVIDERS: Record<
  MobileMoneyProviderCode,
  MobileMoneyProviderDefinition
> = {
  test: {
    code: "test",
    name: "LexiBite Test Provider",
    automatic: true,
    supportedNetworks: ALL_CONNECTED_NETWORKS,
    credentialFields: [],
    certified: true,
  },
  stakaba: {
    code: "stakaba",
    name: "Stakaba",
    automatic: true,
    supportedNetworks: ALL_CONNECTED_NETWORKS,
    credentialFields: ["apiKey", "webhookSecret"],
    certified: false,
  },
  clickpesa: {
    code: "clickpesa",
    name: "ClickPesa",
    automatic: true,
    supportedNetworks: ALL_CONNECTED_NETWORKS,
    credentialFields: ["apiKey", "apiSecret", "webhookSecret"],
    certified: false,
  },
  payin: {
    code: "payin",
    name: "PayIn",
    automatic: true,
    supportedNetworks: ALL_CONNECTED_NETWORKS,
    credentialFields: ["apiKey", "apiSecret", "webhookSecret"],
    certified: false,
  },
  snippe: {
    code: "snippe",
    name: "Snippe",
    automatic: true,
    supportedNetworks: ALL_CONNECTED_NETWORKS,
    credentialFields: ["apiKey", "apiSecret", "webhookSecret"],
    certified: false,
  },
  malipopay: {
    code: "malipopay",
    name: "MALIPOPAY",
    automatic: true,
    supportedNetworks: ALL_CONNECTED_NETWORKS,
    credentialFields: ["apiKey", "apiSecret", "webhookSecret"],
    certified: false,
  },
};

export function getMobileMoneyProvider(
  code: string | null | undefined,
): MobileMoneyProviderDefinition | null {
  if (!code) return null;
  return MOBILE_MONEY_PROVIDERS[code as MobileMoneyProviderCode] ?? null;
}
