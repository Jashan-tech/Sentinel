import { readFileSync } from "node:fs";
import type { EquipmentIdentity } from "./schemas.js";
export const DOC_TOPICS = [
  "temperature",
  "humidity",
  "acoustic",
  "distance",
  "general",
  "led",
  "airflow",
] as const;
export interface ReferenceDoc {
  doc_id: string;
  title: string;
  source_type: string;
  verified: boolean;
  availability?: string;
  applies_to: string[];
  topics: string[];
  content?: string;
  manufacturer?: string;
  equipment_family?: string;
  supported_models?: string[];
  source_url?: string;
  revision_date?: string | null;
  revision?: string | null;
  section?: string;
  access_date?: string;
  technical_facts?: { fact_id: string; statement: string }[];
  applicability_conditions?: string[];
  limitations?: string[];
}
const DOCS: ReferenceDoc[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/docs/equipment-docs.json", import.meta.url),
    "utf8",
  ),
).documents;
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** Exact allow-listed identity matching. No model prefix, equipment category, or image-derived fallback. */
export function lookupDocumentation(
  equipmentType: string,
  topic?: (typeof DOC_TOPICS)[number],
  identity?: EquipmentIdentity,
) {
  const trusted =
    identity?.provenance === "OPERATOR_PROVIDED" &&
    Boolean(identity.assertion.trim());
  const matching = DOCS.filter(
    (d) =>
      d.verified &&
      d.source_url &&
      trusted &&
      normalize(d.manufacturer ?? "") === normalize(identity!.manufacturer) &&
      d.supported_models?.some(
        (m) => normalize(m) === normalize(identity!.model),
      ) &&
      (!topic || d.topics.includes(topic)),
  );
  const general = DOCS.filter(
    (d) =>
      !d.supported_models &&
      d.applies_to.some((a) => normalize(a) === normalize(equipmentType)) &&
      (!topic || d.topics.includes(topic)) &&
      (!matching.length || d.availability !== "UNAVAILABLE"),
  );
  return {
    equipment_type: equipmentType,
    topic: topic ?? "any",
    equipment_identity: trusted ? identity : null,
    match_status: matching.length ? "MATCH" : "NO_MATCH",
    documents: structuredClone([...general, ...matching]),
    manufacturer_specification_available: matching.length > 0,
    missing_information: matching.length
      ? []
      : [
          trusted
            ? "No verified knowledge-base record matches the exact manufacturer, model, and requested topic."
            : "Installed equipment manufacturer/model have not been explicitly provided by the operator.",
        ],
    note: matching.length
      ? "Only these sourced facts are available; every fact inherits its document section, URL, applicability conditions and limitations. Never infer compliance or a fault."
      : "NO_MATCH: model-specific guidance unavailable. Confirm installed identity and inspect sensor placement and visible ventilation generally; do not apply specifications from a reference photograph or generic rack profile.",
  };
}
