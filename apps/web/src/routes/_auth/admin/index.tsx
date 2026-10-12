import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { type AdminUser, formatUsd, isAtQuota } from "@/admin/users";
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
  loader: ({ deps }) =>
    listAdminUsers({
      data: {
        search: deps.search,
        sort: deps.sort ?? "email",
        atQuota: deps.atQuota === "1",
      },
    }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const users = Route.useLoaderData();
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
    </main>
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
          </tr>
        </thead>
        <tbody>
          {users.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              <td className="px-3 py-2">{row.email}</td>
              <td className="px-3 py-2">{row.name}</td>
              <td className="px-3 py-2">{row.createdAt.slice(0, 10)}</td>
              <td className="px-3 py-2">{row.signInMethods.join(", ") || "None"}</td>
              <td className="px-3 py-2">{row.role ?? "user"}</td>
              <td className="px-3 py-2">{row.banned ? "Banned" : "Active"}</td>
              <td className="px-3 py-2">
                {formatUsd(row.spentMicros)}
                {row.budgetMicros === null ? (
                  <span className="text-muted-foreground"> of unlimited</span>
                ) : (
                  <span className="text-muted-foreground"> of {formatUsd(row.budgetMicros)}</span>
                )}
                {isAtQuota(row) && <span className="ml-2 text-destructive">At Quota</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
