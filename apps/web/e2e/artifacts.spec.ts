import { test } from "@playwright/test";

import { registerArtifactScenarios } from "../../../packages/chat-sdk/test/e2e/artifact-scenarios";

import { appWebHost } from "./host";

registerArtifactScenarios(test, appWebHost);
