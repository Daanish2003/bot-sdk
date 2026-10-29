// The channel service's entry point inside the SDK (#889): the core imports it only through this
// file. index.ts stays the public package export.
export {
  bareAddress,
  type EmailChannel,
  type EmailProvider,
  type InboundMail,
  type MailFile,
  MailFileTooLargeError,
  type OutboundMail,
} from "./email";
export {
  emailBody,
  type FileBytes,
  fitsInOneEmail,
  headerText,
  maxAttachedBytes,
  namedAddress,
  replySubject,
} from "./email-out";
export {
  type ChannelAdapter,
  type ChannelApi,
  type ChannelOptions,
  type ChannelPlugin,
  deliveryPayload,
  type DeliveryPayload,
} from "./plugin";
export {
  type PushNotification,
  type PushProvider,
  type PushSubscriptionKeys,
  type WebPushChannel,
} from "./push";
