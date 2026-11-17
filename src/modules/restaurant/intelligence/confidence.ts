/**
 * LexiBite sprint — presentation-integrity fix for confidence values.
 *
 * The reasoning layer's "confidence" is a model's own self-reported
 * estimate — never a calibrated statistical probability. Showing it as a
 * bare "94%" invites the operator to read it as a measured statistic,
 * which it is not. This module does not invent a new confidence
 * methodology; it only re-labels the SAME existing 0-1 value the
 * reasoning layer already returns into a coarse, honest band before it
 * ever reaches the UI.
 */
export type ConfidenceBand = "High confidence" | "Medium confidence" | "Low confidence";

const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.5;

export function confidenceBand(value: number | null | undefined): ConfidenceBand | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value >= HIGH_THRESHOLD) return "High confidence";
  if (value >= MEDIUM_THRESHOLD) return "Medium confidence";
  return "Low confidence";
}
