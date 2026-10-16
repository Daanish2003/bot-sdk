import { test } from "@playwright/test";

import { registerSharedScenarios } from "../../../packages/bot-sdk/test/e2e/scenarios";

import { appWebHost } from "./host";

registerSharedScenarios(test, appWebHost);
