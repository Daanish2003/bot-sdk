import { BotRoute } from "@/components/bot-pages";

export default async function BotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BotRoute botId={id} />;
}
