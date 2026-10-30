// The public channel export composes the Bot's channel plugin, which owns delivery and inbound mail.
export { channel } from "../bot/channels";
export type {
  ChannelAccountsApi,
  ChannelAdapter,
  ChannelApi,
  ChannelOptions,
  ChannelPlugin,
} from "./plugin";
export {
  CredentialsRejectedError,
  MessagingFileTooLargeError,
  type MessagingAccount,
  type MessagingAdapter,
  type MessagingButtons,
  type MessagingCall,
  type MessagingFile,
  type MessagingUpdate,
  type OutboundMessage,
  type SentMessage,
} from "./messaging";
export {
  emailChannel,
  type AuthVerdict,
  type EmailChannel,
  type EmailProvider,
  type InboundMail,
  type OutboundMail,
} from "./email";
export {
  type PushNotification,
  type PushProvider,
  type PushSubscriptionKeys,
  type WebPushChannel,
  webPushChannel,
} from "./push";
