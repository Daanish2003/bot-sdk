import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  render,
  Section,
  Text,
} from "@react-email/components";

import type { EmailMessage } from "./sender";

export const TEMPLATE_NAMES = [
  "verify-email",
  "reset-password",
  "change-email-confirm",
  "verify-new-email",
  "delete-account-confirm",
  "password-changed",
  "account-deleted",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

// Templates with an action link take a `url`; the two notices take only the app name.
type LinkTemplateName = Exclude<TemplateName, "password-changed" | "account-deleted">;

export type TemplateProps<N extends TemplateName> = {
  appName: string;
} & (N extends LinkTemplateName ? { url: string } : Record<never, never>);

type Copy = {
  subject: string;
  heading: string;
  paragraph: string;
  button?: string;
  expiry?: string;
  reason: string;
};

const EXPIRY = "This link expires in 1 hour.";

const copy: { [N in TemplateName]: (props: TemplateProps<N>) => Copy } = {
  "verify-email": ({ appName }: TemplateProps<"verify-email">) => ({
    subject: `Verify your email for ${appName}`,
    heading: "Verify your email",
    paragraph: `Confirm this address to finish setting up your ${appName} account.`,
    button: "Verify email",
    expiry: EXPIRY,
    reason: "someone signed up for an account with this address",
  }),
  "reset-password": ({ appName }: TemplateProps<"reset-password">) => ({
    subject: `Reset your ${appName} password`,
    heading: "Reset your password",
    paragraph:
      "Choose a new password with the button below. Your old password keeps working until you do.",
    button: "Reset password",
    expiry: EXPIRY,
    reason: "a password reset was requested for this address",
  }),
  "change-email-confirm": ({ appName }: TemplateProps<"change-email-confirm">) => ({
    subject: `Confirm your email change for ${appName}`,
    heading: "Confirm your email change",
    paragraph:
      "Someone asked to change the email address on your account. This email went to your current address; confirm the change with the button below.",
    button: "Confirm change",
    expiry: EXPIRY,
    reason: "an email change was requested for your account",
  }),
  "verify-new-email": ({ appName }: TemplateProps<"verify-new-email">) => ({
    subject: `Verify your new email for ${appName}`,
    heading: "Verify your new email",
    paragraph: "Verify this address to finish changing the email on your account.",
    button: "Verify new email",
    expiry: EXPIRY,
    reason: "this address was added as the new email for an account",
  }),
  "delete-account-confirm": ({ appName }: TemplateProps<"delete-account-confirm">) => ({
    subject: `Confirm deleting your ${appName} account`,
    heading: "Confirm account deletion",
    paragraph:
      "Clicking the button deletes your account at once, with your Conversations, Messages, Attachments, Shared links, Provider credentials, Tool credentials and settings. This cannot be undone.",
    button: "Delete my account",
    expiry: EXPIRY,
    reason: "someone asked to delete the account for this address",
  }),
  "password-changed": ({ appName }: TemplateProps<"password-changed">) => ({
    subject: `Your ${appName} password was changed`,
    heading: "Your password was changed",
    paragraph:
      "The password on your account was just changed. No action is needed if this was you.",
    reason: "the password on your account was changed",
  }),
  "account-deleted": ({ appName }: TemplateProps<"account-deleted">) => ({
    subject: `Your ${appName} account was deleted`,
    heading: "Your account was deleted",
    paragraph: "Your account and its data were deleted as you asked. This cannot be undone.",
    reason: "your account was deleted",
  }),
};

const body = {
  backgroundColor: "#f6f6f6",
  fontFamily: "Helvetica, Arial, sans-serif",
  color: "#111111",
};
const card = {
  backgroundColor: "#ffffff",
  margin: "24px auto",
  padding: "32px",
  maxWidth: "520px",
  borderRadius: "8px",
};
const button = {
  backgroundColor: "#111111",
  color: "#ffffff",
  padding: "12px 20px",
  borderRadius: "6px",
  textDecoration: "none",
  display: "inline-block",
};
const muted = { color: "#555555", fontSize: "14px" };

function EmailLayout({ copy, url, appName }: { copy: Copy; url?: string; appName: string }) {
  return (
    <Html lang="en">
      <Head />
      <Body style={body}>
        <Container style={card}>
          <Text style={{ ...muted, margin: 0 }}>{appName}</Text>
          <Heading as="h1">{copy.heading}</Heading>
          <Text>{copy.paragraph}</Text>
          {url && copy.button ? (
            <Section>
              <Button href={url} style={button}>
                {copy.button}
              </Button>
            </Section>
          ) : null}
          {url ? (
            <Text style={muted}>
              If the button doesn&apos;t work, open this link: <Link href={url}>{url}</Link>
            </Text>
          ) : null}
          {copy.expiry ? <Text style={muted}>{copy.expiry}</Text> : null}
          <Hr />
          <Text style={muted}>
            You received this email from {appName} because {copy.reason}. If that wasn&apos;t you,
            you can ignore it.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// Renders a template to a message: the React element for the sender, the
// generated plain text and the action link, if it has one.
export async function renderTemplate<N extends TemplateName>(
  name: N,
  to: string,
  props: TemplateProps<N>,
): Promise<EmailMessage> {
  const content = (copy[name] as (props: TemplateProps<N>) => Copy)(props);
  const url = "url" in props ? (props as { url: string }).url : undefined;
  const react = <EmailLayout copy={content} url={url} appName={props.appName} />;
  const text = await render(react, { plainText: true });
  return { to, subject: content.subject, template: name, react, text, link: url };
}
