import { ProjectPage } from "@ai-chat/bot-sdk/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/p/$id")({
  component: ProjectRoute,
});

function ProjectRoute() {
  const { id } = Route.useParams();
  return <ProjectPage key={id} projectId={id} />;
}
