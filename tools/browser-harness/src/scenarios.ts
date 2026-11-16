import {
  FIXTURES_PAGE_PATH,
  FIXTURES_PAGE_REQUESTS,
  PAGE_PATH,
  smallResourcePaths,
  type FixtureMethod,
} from "./fixtures.ts";
import { PINNED_RESPONSES } from "./pinned-responses.ts";

export type ExpectedResponse = {
  readonly id: string;
  readonly method: FixtureMethod;
  readonly path: string;
  readonly status: 200 | 206;
  readonly sha256: string;
  readonly byteLength: number;
};

export type Scenario = {
  readonly name: ScenarioName;
  readonly pagePath: string;
  readonly description: string;
  readonly responses: readonly ExpectedResponse[];
};

export const SCENARIO_NAMES = ["page", "fixtures"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const SCENARIOS: Readonly<Record<ScenarioName, Scenario>> = {
  page: {
    name: "page",
    pagePath: PAGE_PATH,
    description: "the measured page and its 200 small resources",
    responses: [
      expected("page", "GET", PAGE_PATH, 200),
      ...smallResourcePaths().map((path) =>
        expected(`r-${path.split("/").slice(2).join("-")}`, "GET", path, 200),
      ),
    ],
  },
  fixtures: {
    name: "fixtures",
    pagePath: FIXTURES_PAGE_PATH,
    description:
      "the fixtures page and the large, chunked, gzip, video, range, POST and no-store bodies",
    responses: [
      expected("fixtures-page", "GET", FIXTURES_PAGE_PATH, 200),
      ...FIXTURES_PAGE_REQUESTS.map((request) =>
        request.range === null
          ? expected(request.fixtureId, request.method, request.path, 200)
          : expected(
              `${request.fixtureId}@${String(request.range.start)}-${String(request.range.end)}`,
              request.method,
              request.path,
              206,
            ),
      ),
    ],
  },
};

export function parseScenarioName(value: string): ScenarioName {
  const name = SCENARIO_NAMES.find((candidate) => candidate === value);
  if (name === undefined) {
    throw new Error(`unknown scenario ${value}; expected one of ${SCENARIO_NAMES.join(", ")}`);
  }
  return name;
}

function expected(
  id: string,
  method: FixtureMethod,
  path: string,
  status: 200 | 206,
): ExpectedResponse {
  const pinned = PINNED_RESPONSES[id];
  if (pinned === undefined) throw new Error(`no pinned digest for ${id}`);
  return { id, method, path, status, sha256: pinned.sha256, byteLength: pinned.byteLength };
}
