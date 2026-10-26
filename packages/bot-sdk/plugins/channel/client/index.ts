import type { FeatureClient } from "../../../core/client/chat-client";
import { type ChannelsContract, channelsContract } from "../../bot/shared/contract";

export type { ChannelsContract };

export type ChannelsClient = FeatureClient<"channels", ChannelsContract>;

/**
 * The email Channel's client part: its contract, served under `channels` when the Host fills the
 * `channels` slot. It adds no URLs.
 */
export function channelClient(): ChannelsClient {
  return { id: "channels", contract: channelsContract };
}
