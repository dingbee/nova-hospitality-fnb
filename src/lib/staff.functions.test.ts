/* eslint-disable @typescript-eslint/no-explicit-any -- the fake mirrors Supabase's untyped surface. */
/**
 * Ops UAT gap #1 — user/staff provisioning.
 *
 * TeamPanel could only grant a restaurant role to someone already present
 * in the platform-wide staff directory (app_users), and nothing anywhere in
 * this codebase ever created that first account or app_users row — there
 * was no invite/signup path at all. provisionInvitedStaffUser closes that:
 * it's the piece TeamPanel's new "Invite a new person" form calls.
 */
import { describe, expect, it } from "vitest";
import { provisionInvitedStaffUser } from "./staff.functions";

function makeFakeAdminClient(opts: { existingEmails?: string[] } = {}) {
  const appUsers: any[] = [];
  let seq = 0;

  return {
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, _options?: any) => {
          if (opts.existingEmails?.includes(email)) {
            return { data: null, error: { message: "User already been registered" } };
          }
          seq += 1;
          return { data: { user: { id: `user-${seq}`, email } }, error: null };
        },
      },
    },
    from: (table: string) => {
      if (table !== "app_users") throw new Error(`Unexpected table ${table}`);
      return {
        insert: (row: any) => {
          appUsers.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    appUsers,
  };
}

describe("provisionInvitedStaffUser", () => {
  it("creates the auth account and mirrors it into app_users as pending", async () => {
    const admin = makeFakeAdminClient();

    const result = await provisionInvitedStaffUser(admin, {
      email: "newchef@example.com",
      fullName: "New Chef",
    });

    expect(result).toEqual({ userId: "user-1", email: "newchef@example.com" });
    expect(admin.appUsers).toEqual([
      {
        user_id: "user-1",
        email: "newchef@example.com",
        full_name: "New Chef",
        status: "pending",
      },
    ]);
  });

  it("works with no name supplied", async () => {
    const admin = makeFakeAdminClient();
    const result = await provisionInvitedStaffUser(admin, { email: "a@b.com" });
    expect(result.email).toBe("a@b.com");
    expect(admin.appUsers[0].full_name).toBeNull();
  });

  it("reports a duplicate invite as an operator-facing error, not a raw auth error", async () => {
    const admin = makeFakeAdminClient({ existingEmails: ["existing@example.com"] });

    await expect(
      provisionInvitedStaffUser(admin, { email: "existing@example.com" }),
    ).rejects.toThrow(/existing@example\.com already has an account/);
    expect(admin.appUsers).toHaveLength(0); // no orphan profile row for a failed invite
  });

  it("never inserts an app_users row when the auth invite itself fails", async () => {
    const admin = {
      auth: {
        admin: {
          inviteUserByEmail: async () => ({ data: null, error: { message: "rate limited" } }),
        },
      },
      from: () => {
        throw new Error("app_users should never be touched after a failed invite");
      },
    };
    await expect(provisionInvitedStaffUser(admin, { email: "x@y.com" })).rejects.toThrow(
      /rate limited/,
    );
  });
});
