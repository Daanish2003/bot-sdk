import { createMemoryPubSub } from "../../src/chat/pubsub";
import { pubsubContract } from "@ai-chat/test-support/pubsub.contract";

pubsubContract("memory", () => createMemoryPubSub());
