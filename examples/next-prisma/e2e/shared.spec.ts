import { test } from "@playwright/test";

import { registerSharedScenarios } from "../../../packages/chat-sdk/test/e2e/scenarios";

import { exampleHost } from "./host";

registerSharedScenarios(test, exampleHost);
