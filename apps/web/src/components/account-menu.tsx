import { Button } from "@ai-chat/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ai-chat/ui/components/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { UserIcon } from "lucide-react";

import { authClient } from "@/lib/auth-client";

/**
 * The account menu at the foot of the Bots sidebar: Keys, Account, Admin (Admins only), Sign out.
 */
export default function AccountMenu({
  name,
  email,
  isAdmin,
}: {
  name: string;
  email: string;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="w-full justify-start" />}
      >
        <UserIcon />
        <span className="truncate">{name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link to="/settings/keys" />}>Keys</DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings/account" />}>Account</DropdownMenuItem>
          {isAdmin && <DropdownMenuItem render={<Link to="/admin" />}>Admin</DropdownMenuItem>}
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    // The next user on this tab must not see this user's cached Bots.
                    queryClient.clear();
                    navigate({ to: "/login" });
                  },
                },
              });
            }}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
