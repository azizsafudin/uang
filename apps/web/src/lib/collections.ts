// TanStack DB collections for accounts and FX rates.
//
// NOTE: @tanstack/query-db-collection (queryCollectionOptions) is not installed.
// We use createCollection with the native sync API from @tanstack/db 0.6.8.
// The sync function fetches data from the API and populates the collection via
// begin/write/commit/markReady. Mutations are handled by onInsert/onUpdate/onDelete.
// Components read via useQuery (TanStack Query) for simplicity since the DB is REST-based.

import { createCollection } from "@tanstack/react-db";
import { api } from "./api";

type AccountRow = {
  id: string;
  name: string;
  class: string;
  subtype: string;
  currency: string;
  institution: string | null;
  isArchived: number;
  sortOrder: number;
  valuationMode: string;
  balanceMinor: number;
  createdAt: number;
  createdBy: string;
};

type FxRow = {
  id: string;
  currency: string;
  date: string;
  rateScaled: number;
  createdAt: number;
};

// Accounts collection — reads via GET /accounts, writes via the API.
export const accountsCollection = createCollection<AccountRow, string>({
  id: "accounts",
  getKey: (a) => a.id,
  sync: {
    sync: ({ begin, write, commit, markReady }) => {
      let stopped = false;

      void (async () => {
        try {
          const { data, error } = await api.accounts.get();
          if (stopped) return;
          if (!error && Array.isArray(data)) {
            begin();
            for (const item of data as AccountRow[]) {
              write({ type: "insert", value: item });
            }
            commit();
          }
          markReady();
        } catch {
          markReady();
        }
      })();

      return () => {
        stopped = true;
      };
    },
  },
  onInsert: async ({ transaction }) => {
    const m = transaction.mutations[0]?.modified as AccountRow | undefined;
    if (!m) return;
    const { id: _id, balanceMinor: _bal, createdAt: _ca, createdBy: _cb, ...body } = m;
    await api.accounts.post(body as any);
  },
  onUpdate: async ({ transaction }) => {
    const m = transaction.mutations[0]?.modified as AccountRow | undefined;
    if (!m) return;
    await api.accounts({ id: m.id }).patch(m as any);
  },
});

// FX rates collection.
export const fxCollection = createCollection<FxRow, string>({
  id: "fx",
  getKey: (r) => r.id,
  sync: {
    sync: ({ begin, write, commit, markReady }) => {
      let stopped = false;

      void (async () => {
        try {
          const { data, error } = await api.fx.get();
          if (stopped) return;
          if (!error && Array.isArray(data)) {
            begin();
            for (const item of data as FxRow[]) {
              write({ type: "insert", value: item });
            }
            commit();
          }
          markReady();
        } catch {
          markReady();
        }
      })();

      return () => {
        stopped = true;
      };
    },
  },
  onInsert: async ({ transaction }) => {
    const m = transaction.mutations[0]?.modified as FxRow | undefined;
    if (!m) return;
    await api.fx.post(m as any);
  },
  onDelete: async ({ transaction }) => {
    const id = (transaction.mutations[0]?.original as FxRow | undefined)?.id;
    if (!id) return;
    await api.fx({ id }).delete();
  },
});
