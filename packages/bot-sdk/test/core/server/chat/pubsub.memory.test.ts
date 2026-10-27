import { createMemoryPubSub } from "@botsdk/bot/chat/pubsub";
import { pubsubContract } from "./pubsub.contract";

pubsubContract("memory", () => createMemoryPubSub());
