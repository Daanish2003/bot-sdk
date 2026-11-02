import { RepresentativePage } from "@botsdk/ui/representative";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/representatives/$id")({
  component: function RepresentativeRoute() {
    const { id } = Route.useParams();
    return <RepresentativePage id={id} />;
  },
});
