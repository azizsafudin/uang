import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type Member = { id: string; email: string; name: string; isAdmin: boolean };

// Household members. Shared by the owners picker, owner badges, and the net-worth toggle.
export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await api.users.get();
      if (error) throw new Error(String(error));
      return (data as unknown as Member[]) ?? [];
    },
  });
}
