import { startLabPhone } from "./lab-phone.ts";

const phone = await startLabPhone({
  port: Number(process.env.PORT ?? 4010),
  host: process.env.HOST ?? "0.0.0.0",
  ...(process.env.LAB_PHONE_SEED && { seed: process.env.LAB_PHONE_SEED }),
  ...(process.env.LAB_PHONE_WEBHOOK_URL && { webhookUrl: process.env.LAB_PHONE_WEBHOOK_URL }),
});
console.log(`Lab phone on ${phone.url}; webhook public key ${phone.publicKey}`);
