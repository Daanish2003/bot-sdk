import { ProjectRoute } from "@/components/chat-pages";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectRoute id={id} />;
}
