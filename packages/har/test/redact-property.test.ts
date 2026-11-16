import { describe, expect, it } from "vite-plus/test";

import { buildMarkerDocument, haystackFor, type PlantedMarker } from "./marker-document.ts";
import {
  HAR_REDACTION_PLACES,
  type HarDocument,
  type HarModelStringField,
  type HarRedactionPlace,
  type RedactionLevel,
} from "../src/model.ts";
import {
  HAR_MODEL_FIELD_TABLE,
  HAR_PLACE_TABLE,
  type HarPlaceRule,
  redactHar,
} from "../src/redact.ts";

const STANDARD_REMOVED_PLACES: ReadonlySet<HarRedactionPlace> = new Set([
  "request-url-userinfo",
  "request-url-query-secret",
  "header-value-secret",
  "cookie",
  "query-string-secret",
  "body-param-secret",
  "redaction-record",
  "malformed-number",
]);

const SHAREABLE_KEPT_PLACES: ReadonlySet<HarRedactionPlace> = new Set([
  "request-url-host",
  "request-url-path",
  "header-name",
  "header-value-allowlisted",
  "protocol-metadata",
]);

function verifyLevel(
  document: HarDocument,
  markers: readonly PlantedMarker[],
  level: RedactionLevel,
  placeTable: Readonly<Record<HarRedactionPlace, HarPlaceRule>> = HAR_PLACE_TABLE,
): readonly string[] {
  const { document: redacted, report } = redactHar(document, { level, placeTable });
  const hay = haystackFor(redacted);
  const failures: string[] = [];

  for (const item of markers) {
    const present = hay.includes(item.marker);
    const coverage = report.places.find((place) => place.place === item.place);
    if (!coverage) {
      failures.push(`${item.field} (${item.place}) missing from report.places`);
      continue;
    }
    if (coverage.count <= 0) {
      failures.push(`${item.field} (${item.place}) has count ${String(coverage.count)}`);
    }

    if (present) {
      const expectedKeptStatus = level === "standard" ? "kept-not-examined" : "kept-by-allowlist";
      if (coverage.status !== expectedKeptStatus) {
        failures.push(
          `${item.field} (${item.place}) marker stayed in output, but report status is ${coverage.status}`,
        );
      }
      if (level === "standard" && STANDARD_REMOVED_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) is a credential carrier and must be removed under standard`,
        );
      }
      if (level === "shareable" && !SHAREABLE_KEPT_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) is not on the shareable allowlist and must be removed`,
        );
      }
    } else {
      if (coverage.status !== "removed") {
        failures.push(
          `${item.field} (${item.place}) marker was removed, but report status is ${coverage.status}`,
        );
      }
      if (level === "standard" && !STANDARD_REMOVED_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) must be kept byte-for-byte intact under standard`,
        );
      }
      if (level === "shareable" && SHAREABLE_KEPT_PLACES.has(item.place)) {
        failures.push(
          `${item.field} (${item.place}) is on the shareable allowlist and must be kept`,
        );
      }
    }
  }

  return failures;
}

describe("total model place table and marker verification", () => {
  it("fills every string-holding place of the HAR model with a unique marker and accounts for 100% of markers at both levels", () => {
    const { document, markers, plantedFields } = buildMarkerDocument();

    const modelFields = Object.keys(HAR_MODEL_FIELD_TABLE) as HarModelStringField[];
    expect([...plantedFields].sort()).toEqual([...modelFields].sort());

    for (const field of modelFields) {
      const expectedPlaces = HAR_MODEL_FIELD_TABLE[field].places;
      const plantedPlacesForField = markers
        .filter((item) => item.field === field)
        .map((item) => item.place);
      expect([...plantedPlacesForField].sort()).toEqual([...expectedPlaces].sort());
    }

    const beforeHay = haystackFor(document);
    for (const item of markers) {
      expect(beforeHay, `missing initial marker for ${item.field} (${item.place})`).toContain(
        item.marker,
      );
    }

    const standardFailures = verifyLevel(document, markers, "standard");
    expect(standardFailures).toEqual([]);

    const shareableFailures = verifyLevel(document, markers, "shareable");
    expect(shareableFailures).toEqual([]);
  });

  it("fails when any single row in HAR_PLACE_TABLE has the wrong disposition at either level", () => {
    const { document, markers } = buildMarkerDocument();

    for (const place of HAR_REDACTION_PLACES) {
      const original = HAR_PLACE_TABLE[place];

      const mutatedStandard: Record<HarRedactionPlace, HarPlaceRule> = {
        ...HAR_PLACE_TABLE,
        [place]: {
          ...original,
          standard: original.standard === "removed" ? "kept-not-examined" : "removed",
        },
      };
      const standardFailures = verifyLevel(document, markers, "standard", mutatedStandard);
      expect(
        standardFailures.some((msg) => msg.includes(`(${place})`)),
        `expected mutating standard row for ${place} to fail`,
      ).toBe(true);

      const mutatedShareable: Record<HarRedactionPlace, HarPlaceRule> = {
        ...HAR_PLACE_TABLE,
        [place]: {
          ...original,
          shareable: original.shareable === "removed" ? "kept-by-allowlist" : "removed",
        },
      };
      const shareableFailures = verifyLevel(document, markers, "shareable", mutatedShareable);
      expect(
        shareableFailures.some((msg) => msg.includes(`(${place})`)),
        `expected mutating shareable row for ${place} to fail`,
      ).toBe(true);
    }
  });
});
