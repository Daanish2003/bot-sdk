import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { AdminBanControl } from "@/components/admin-ban-control";
import { type RatingRow } from "@/admin/ratings";
import { type AdminUser, formatUsd, isAtQuota } from "@/admin/users";
import { listRatingTotals } from "@/functions/admin-ratings";
import { listAdminUsers } from "@/functions/admin-users";

const searchSchema = z.object({
  search: z.string().optional().catch(undefined),
  sort: z.enum(["email", "spend"]).optional().catch(undefined),
  atQuota: z.enum(["1"]).optional().catch(undefined),
});

/** Admin: every user's spend against their Quota. A non-Admin gets a 404 (spec #277). */
export const Route = createFileRoute("/_auth/admin/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [users, ratings] = await Promise.all([
      listAdminUsers({
        data: {
          search: deps.search,
          sort: deps.sort ?? "email",
          atQuota: deps.atQuota === "1",
        },
      }),
      listRatingTotals(),
    ]);
    return { users, ratings };
  },
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const { users, ratings } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const update = (patch: z.infer<typeof searchSchema>) =>
    navigate({ search: (previous) => ({ ...previous, ...patch }) });

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <h1 className="text-xl font-semibold">Users</h1>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          type="search"
          aria-label="Search by email"
          placeholder="Search by email"
          defaultValue={search.search ?? ""}
          onChange={(event) => void update({ search: event.target.value || undefined })}
          className="sm:max-w-xs"
        />
        <div className="flex gap-2">
          <Button
            variant={search.sort === "spend" ? "default" : "outline"}
            onClick={() => update({ sort: search.sort === "spend" ? undefined : "spend" })}
          >
            Sort by spend
          </Button>
          <Button
            variant={search.atQuota ? "default" : "outline"}
            onClick={() => update({ atQuota: search.atQuota ? undefined : "1" })}
          >
            At Quota
          </Button>
        </div>
      </div>
      <UsersTable users={users} />
      <RatingsSection ratings={ratings} />
    </main>
  );
}

/** Replies rated in the last 30 days, per Model: 👍, 👎 and the share of 👎. Never per user. */
function RatingsSection({ ratings }: { ratings: RatingRow[] }) {
  return (
    <section aria-labelledby="ratings-heading" className="space-y-3">
      <h2 id="ratings-heading" className="text-lg font-semibold">
        Ratings
      </h2>
      <p className="text-sm text-muted-foreground">Replies rated in the last 30 days, per Model.</p>
      {ratings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No replies have been rated in this window.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">👍</th>
                <th className="px-3 py-2 font-medium">👎</th>
                <th className="px-3 py-2 font-medium">% 👎</th>
              </tr>
            </thead>
            <tbody>
              {ratings.map((row) => (
                <tr key={row.model} className="border-b last:border-0">
                  <td className="px-3 py-2">{row.model}</td>
                  <td className="px-3 py-2">{row.up}</td>
                  <td className="px-3 py-2">{row.down}</td>
                  <td className="px-3 py-2">{row.downPercent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UsersTable({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground">No users match.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <thead className="border-b bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Email</th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Joined</th>
            <th className="px-3 py-2 font-medium">Sign-in methods</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Spend this window</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              <td className="px-3 py-2">
                <Link
                  to="/admin/$userId"
                  params={{ userId: row.id }}
                  className="underline-offset-4 hover:underline"
                >
                  {row.email}
                </Link>
              </td>
              <td className="px-3 py-2">{row.name}</td>
              <td className="px-3 py-2">{row.createdAt.slice(0, 10)}</td>
              <td className="px-3 py-2">{row.signInMethods.join(", ") || "None"}</td>
              <td className="px-3 py-2">{row.role ?? "user"}</td>
              <td className="px-3 py-2">
                {row.banned
                  ? row.banExpires
                    ? `Banned until ${new Date(row.banExpires).toLocaleString()}`
                    : "Banned"
                  : "Active"}
              </td>
              <td className="px-3 py-2">
                {formatUsd(row.spentMicros)}
                {row.budgetMicros === null ? (
                  <span className="text-muted-foreground"> of unlimited</span>
                ) : (
                  <span className="text-muted-foreground"> of {formatUsd(row.budgetMicros)}</span>
                )}
                {isAtQuota(row) && <span className="ml-2 text-destructive">At Quota</span>}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-2">
                  <AdminBanControl user={row} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
