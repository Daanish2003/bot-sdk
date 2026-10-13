import { Link, createFileRoute } from "@tanstack/react-router";

import { AdminQuotaControl } from "@/components/admin-quota-control";
import { AdminSpendChart } from "@/components/admin-spend-chart";
import { AdminTwoFactorControl } from "@/components/admin-two-factor-control";
import { getAdminUserDetail } from "@/functions/admin-quota";

/** Admin: one user's spend per day over 30 days, split by Model, and their Quota. Admin only. */
export const Route = createFileRoute("/_auth/admin/$userId")({
  loader: ({ params }) => getAdminUserDetail({ data: { userId: params.userId } }),
  component: AdminUserPage,
});

function AdminUserPage() {
  const detail = Route.useLoaderData();

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
      <Link
        to="/admin"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        Back to users
      </Link>
      <header>
        <h1 className="text-xl font-semibold">{detail.name}</h1>
        <p className="text-sm text-muted-foreground">{detail.email}</p>
      </header>
      <section aria-labelledby="spend-heading" className="space-y-3">
        <h2 id="spend-heading" className="font-medium">
          Spend per day, last 30 days
        </h2>
        <AdminSpendChart days={detail.days} models={detail.models} />
      </section>
      <section aria-labelledby="quota-heading" className="space-y-3">
        <h2 id="quota-heading" className="font-medium">
          Quota
        </h2>
        <AdminQuotaControl userId={detail.id} quota={detail.quota} />
      </section>
      {detail.twoFactorEnabled && (
        <section aria-labelledby="two-factor-heading" className="space-y-3">
          <h2 id="two-factor-heading" className="font-medium">
            Two-factor sign-in
          </h2>
          <AdminTwoFactorControl user={detail} />
        </section>
      )}
    </main>
  );
}
