// TanStack DB collections backed by @tanstack/query-db-collection.
// Each collection uses queryCollectionOptions to integrate TanStack Query's
// fetching lifecycle with TanStack DB's optimistic-update / live-query model.

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./query";
import { api } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountRow = {
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
  ownerIds: string[];
};

export type FxRow = {
  id: string;
  currency: string;
  date: string;
  rateScaled: number;
  createdAt: number;
};

export type EntryRow = {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  kind: string;
  note: string | null;
  createdAt: number;
  createdBy: string;
};

export type InstrumentRow = {
  id: string;
  symbol: string | null;
  isin: string | null;
  name: string;
  kind: string;
  currency: string;
  createdAt: number;
};

export type LotRow = {
  id: string;
  accountId: string;
  instrumentId: string;
  unitsScaled: number;
  unitCostScaled: number;
  feesMinor: number;
  tradeDate: string;
  note: string | null;
  createdAt: number;
  createdBy: string;
};

export type PriceRow = {
  id: string;
  instrumentId: string;
  date: string;
  priceScaled: number;
  source: string;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// accountsCollection
// ---------------------------------------------------------------------------

export const accountsCollection = createCollection(
  queryCollectionOptions<AccountRow, Error, ["accounts"], string>({
    queryKey: ["accounts"],
    queryFn: async (): Promise<Array<AccountRow>> => {
      const { data, error } = await api.accounts.get();
      if (error) throw new Error(String(error));
      return (data as unknown as AccountRow[]) ?? [];
    },
    queryClient,
    getKey: (a) => a.id,
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
  })
);

// ---------------------------------------------------------------------------
// fxCollection
// ---------------------------------------------------------------------------

export const fxCollection = createCollection(
  queryCollectionOptions<FxRow, Error, ["fx"], string>({
    queryKey: ["fx"],
    queryFn: async (): Promise<Array<FxRow>> => {
      const { data, error } = await api.fx.get();
      if (error) throw new Error(String(error));
      return (data as unknown as FxRow[]) ?? [];
    },
    queryClient,
    getKey: (r) => r.id,
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
  })
);

// ---------------------------------------------------------------------------
// instrumentsCollection
// ---------------------------------------------------------------------------

export const instrumentsCollection = createCollection(
  queryCollectionOptions<InstrumentRow, Error, ["instruments"], string>({
    queryKey: ["instruments"],
    queryFn: async (): Promise<Array<InstrumentRow>> => {
      const { data, error } = await api.instruments.get();
      if (error) throw new Error(String(error));
      return (data as unknown as InstrumentRow[]) ?? [];
    },
    queryClient,
    getKey: (i) => i.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as InstrumentRow | undefined;
      if (!m) return;
      const { id: _id, createdAt: _ca, ...body } = m;
      await api.instruments.post(body as any);
    },
  })
);

// ---------------------------------------------------------------------------
// entriesCollection — factory, memoised per accountId
// ---------------------------------------------------------------------------

type EntriesCollection = ReturnType<typeof _makeEntriesCollection>;
const _entriesCache = new Map<string, EntriesCollection>();

function _makeEntriesCollection(accountId: string) {
  return createCollection(
    queryCollectionOptions<EntryRow, Error, [string, string], string>({
      queryKey: ["entries", accountId],
      queryFn: async (): Promise<Array<EntryRow>> => {
        const { data, error } = await api.accounts({ id: accountId }).entries.get();
        if (error) throw new Error(String(error));
        return (data as unknown as EntryRow[]) ?? [];
      },
      queryClient,
      getKey: (e) => e.id,
      onDelete: async ({ transaction }) => {
        const id = (transaction.mutations[0]?.original as EntryRow | undefined)?.id;
        if (!id) return;
        await api.entries({ id }).delete();
      },
    })
  );
}

export function entriesCollection(accountId: string): EntriesCollection {
  if (!_entriesCache.has(accountId)) {
    _entriesCache.set(accountId, _makeEntriesCollection(accountId));
  }
  return _entriesCache.get(accountId)!;
}

// ---------------------------------------------------------------------------
// lotsCollection — factory, memoised per accountId
// ---------------------------------------------------------------------------

type LotsCollection = ReturnType<typeof _makeLotsCollection>;
const _lotsCache = new Map<string, LotsCollection>();

function _makeLotsCollection(accountId: string) {
  return createCollection(
    queryCollectionOptions<LotRow, Error, [string, string], string>({
      queryKey: ["lots", accountId],
      queryFn: async (): Promise<Array<LotRow>> => {
        const { data, error } = await api.accounts({ id: accountId }).lots.get();
        if (error) throw new Error(String(error));
        return (data as unknown as LotRow[]) ?? [];
      },
      queryClient,
      getKey: (l) => l.id,
      onInsert: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as LotRow | undefined;
        if (!m) return;
        const { id: _id, accountId: _aid, createdAt: _ca, createdBy: _cb, ...body } = m;
        await api.accounts({ id: accountId }).lots.post(body as any);
      },
      onUpdate: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as LotRow | undefined;
        if (!m) return;
        await api.lots({ id: m.id }).patch(m as any);
      },
      onDelete: async ({ transaction }) => {
        const id = (transaction.mutations[0]?.original as LotRow | undefined)?.id;
        if (!id) return;
        await api.lots({ id }).delete();
      },
    })
  );
}

export function lotsCollection(accountId: string): LotsCollection {
  if (!_lotsCache.has(accountId)) _lotsCache.set(accountId, _makeLotsCollection(accountId));
  return _lotsCache.get(accountId)!;
}

// ---------------------------------------------------------------------------
// pricesCollection — factory, memoised per instrumentId
// ---------------------------------------------------------------------------

type PricesCollection = ReturnType<typeof _makePricesCollection>;
const _pricesCache = new Map<string, PricesCollection>();

function _makePricesCollection(instrumentId: string) {
  return createCollection(
    queryCollectionOptions<PriceRow, Error, [string, string], string>({
      queryKey: ["prices", instrumentId],
      queryFn: async (): Promise<Array<PriceRow>> => {
        const { data, error } = await api.instruments({ id: instrumentId }).prices.get();
        if (error) throw new Error(String(error));
        return (data as unknown as PriceRow[]) ?? [];
      },
      queryClient,
      getKey: (p) => p.id,
      onInsert: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as PriceRow | undefined;
        if (!m) return;
        await api.instruments({ id: instrumentId }).prices.post({ date: m.date, priceScaled: m.priceScaled } as any);
      },
      onDelete: async ({ transaction }) => {
        const id = (transaction.mutations[0]?.original as PriceRow | undefined)?.id;
        if (!id) return;
        await api.prices({ id }).delete();
      },
    })
  );
}

export function pricesCollection(instrumentId: string): PricesCollection {
  if (!_pricesCache.has(instrumentId)) _pricesCache.set(instrumentId, _makePricesCollection(instrumentId));
  return _pricesCache.get(instrumentId)!;
}
