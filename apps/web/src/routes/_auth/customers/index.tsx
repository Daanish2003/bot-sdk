import { CustomersPage } from "@botsdk/ui/representative";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/customers/")({
  component: CustomersPage,
});
