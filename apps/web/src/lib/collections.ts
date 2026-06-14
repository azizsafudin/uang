// TanStack DB collections backed by @tanstack/query-db-collection.
// Each collection uses queryCollectionOptions to integrate TanStack Query's
// fetching lifecycle with TanStack DB's optimistic-update / live-query model.

import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./query";
import { api } from "./api";

// Client-generated row id. TanStack DB requires every optimistic insert to
// yield a defined key via getKey (it throws UndefinedKeyError otherwise). We
// send this id to the server, which persists it as-is, so the optimistic row's
// key equals the final server key — no temp→real key swap on refetch. Matches
// the server's randomUUID() id format.
export const newId = (): string => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Types — inferred from the API (Eden/Elysia) GET responses. The server schema
// is the single source of truth; do not hand-maintain these row shapes.
// ---------------------------------------------------------------------------

// Element type of a GET endpoint's `data` array. Eden folds the auth guard's
// `{ error }` 401 body into `data`, so we Extract the array branch before indexing.
type RowOf<G extends (...args: never[]) => Promise<{ data: unknown }>> =
  Extract<NonNullable<Awaited<ReturnType<G>>["data"]>, readonly unknown[]>[number];

// Sub-routes hanging off the parameterised /accounts/:id and /instruments/:id calls.
type AccountApi = ReturnType<typeof api.accounts>;
type InstrumentApi = ReturnType<typeof api.instruments>;

export type AccountRow = RowOf<typeof api.accounts.get> & {
  // Insert-only hints consumed by POST /accounts (it creates an opening entry);
  // never returned by GET.
  openingBalanceMinor?: number;
  openingDate?: string;
};
export type FxRow = RowOf<typeof api.fx.get>;
export type InstrumentRow = RowOf<typeof api.instruments.get>;
export type EntryRow = RowOf<AccountApi["entries"]["get"]>;
export type LotRow = RowOf<AccountApi["lots"]["get"]>;
export type PriceRow = RowOf<InstrumentApi["prices"]["get"]>;

// ---------------------------------------------------------------------------
// accountsCollection
// ---------------------------------------------------------------------------

export const accountsCollection = createCollection(
  queryCollectionOptions<AccountRow, Error, ["accounts"], string>({
    queryKey: ["accounts"],
    queryFn: async (): Promise<Array<AccountRow>> => {
      const { data, error } = await api.accounts.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (a) => a.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as AccountRow | undefined;
      if (!m) return;
      // Send the client-generated id; server fills balanceMinor/createdAt/createdBy.
      const { error } = await api.accounts.post({
        id: m.id,
        name: m.name,
        class: m.class,
        subtype: m.subtype,
        currency: m.currency,
        valuationMode: m.valuationMode,
        institution: m.institution ?? undefined,
        sortOrder: m.sortOrder,
        ownerIds: m.ownerIds,
        openingBalanceMinor: m.openingBalanceMinor,
        openingDate: m.openingDate,
        growthRateBps: m.growthRateBps,
        accessibleFromAge: m.accessibleFromAge,
        earlyWithdrawal: m.earlyWithdrawal,
        earlyHaircutBps: m.earlyHaircutBps,
        illiquid: m.illiquid === 1,
        liquidationAge: m.liquidationAge ?? null,
      });
      if (error) throw new Error(String(error));
    },
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as AccountRow | undefined;
      if (!m) return;
      const { error } = await api.accounts({ id: m.id }).patch({
        name: m.name,
        institution: m.institution ?? undefined,
        sortOrder: m.sortOrder,
        isArchived: m.isArchived === 1,
        growthRateBps: m.growthRateBps,
        accessibleFromAge: m.accessibleFromAge,
        earlyWithdrawal: m.earlyWithdrawal,
        earlyHaircutBps: m.earlyHaircutBps,
        illiquid: m.illiquid === 1,
        liquidationAge: m.liquidationAge ?? null,
      });
      if (error) throw new Error(String(error));
    },
    onDelete: async ({ transaction }) => {
      const id = (transaction.mutations[0]?.original as AccountRow | undefined)
        ?.id;
      if (!id) return;
      const { error } = await api.accounts({ id }).delete();
      if (error) throw new Error(String(error));
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
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (r) => r.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as FxRow | undefined;
      if (!m) return;
      const { error } = await api.fx.post({
        id: m.id,
        currency: m.currency,
        date: m.date,
        rateScaled: m.rateScaled,
      });
      if (error) throw new Error(String(error));
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
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (i) => i.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as InstrumentRow | undefined;
      if (!m) return;
      const { error } = await api.instruments.post({
        name: m.name,
        kind: m.kind,
        currency: m.currency,
        symbol: m.symbol ?? undefined,
        isin: m.isin ?? undefined,
      });
      if (error) throw new Error(String(error));
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
        return Array.isArray(data) ? data : [];
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
        return Array.isArray(data) ? data : [];
      },
      queryClient,
      getKey: (l) => l.id,
      onInsert: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as LotRow | undefined;
        if (!m) return;
        // Send the client-generated id; accountId is in the URL, createdAt/createdBy are server-set.
        const { error } = await api.accounts({ id: accountId }).lots.post({
          id: m.id,
          instrumentId: m.instrumentId,
          unitsScaled: m.unitsScaled,
          unitCostScaled: m.unitCostScaled,
          feesMinor: m.feesMinor,
          tradeDate: m.tradeDate,
          note: m.note ?? undefined,
        });
        if (error) throw new Error(String(error));
      },
      onUpdate: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as LotRow | undefined;
        if (!m) return;
        const { error } = await api.lots({ id: m.id }).patch({
          instrumentId: m.instrumentId,
          unitsScaled: m.unitsScaled,
          unitCostScaled: m.unitCostScaled,
          feesMinor: m.feesMinor,
          tradeDate: m.tradeDate,
          note: m.note ?? undefined,
        });
        if (error) throw new Error(String(error));
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
        return Array.isArray(data) ? data : [];
      },
      queryClient,
      getKey: (p) => p.id,
      onInsert: async ({ transaction }) => {
        const m = transaction.mutations[0]?.modified as PriceRow | undefined;
        if (!m) return;
        const { error } = await api.instruments({ id: instrumentId }).prices.post({ id: m.id, date: m.date, priceScaled: m.priceScaled });
        if (error) throw new Error(String(error));
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

// ---------------------------------------------------------------------------
// membersCollection — household members + birth years
// ---------------------------------------------------------------------------

export type MemberRow = RowOf<typeof api.members.get>;

export const membersCollection = createCollection(
  queryCollectionOptions<MemberRow, Error, ["members"], string>({
    queryKey: ["members"],
    queryFn: async (): Promise<Array<MemberRow>> => {
      const { data, error } = await api.members.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (m) => m.id,
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as MemberRow | undefined;
      if (!m) return;
      const { error } = await api.members({ id: m.id }).patch({ birthYear: m.birthYear ?? null });
      if (error) throw new Error(String(error));
    },
  })
);

// ---------------------------------------------------------------------------
// goalsCollection — financial goals
// ---------------------------------------------------------------------------

export type GoalRow = RowOf<typeof api.goals.get>;

export const goalsCollection = createCollection(
  queryCollectionOptions<GoalRow, Error, ["goals"], string>({
    queryKey: ["goals"],
    queryFn: async (): Promise<Array<GoalRow>> => {
      const { data, error } = await api.goals.get();
      if (error) throw new Error(String(error));
      return Array.isArray(data) ? data : [];
    },
    queryClient,
    getKey: (g) => g.id,
    onInsert: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as GoalRow | undefined;
      if (!m) return;
      const { error } = await api.goals.post({
        id: m.id,
        name: m.name,
        term: m.term,
        targetAmountMinor: m.targetAmountMinor,
        currency: m.currency,
        targetDate: m.targetDate,
        ownerScope: m.ownerScope,
        anchorDate: m.anchorDate ?? null,
        monthlyContributionMinor: m.monthlyContributionMinor,
        sortOrder: m.sortOrder,
      });
      if (error) throw new Error(String(error));
    },
    onUpdate: async ({ transaction }) => {
      const m = transaction.mutations[0]?.modified as GoalRow | undefined;
      if (!m) return;
      const { error } = await api.goals({ id: m.id }).patch({
        name: m.name,
        term: m.term,
        targetAmountMinor: m.targetAmountMinor,
        currency: m.currency,
        targetDate: m.targetDate,
        ownerScope: m.ownerScope,
        anchorDate: m.anchorDate ?? null,
        monthlyContributionMinor: m.monthlyContributionMinor,
        sortOrder: m.sortOrder,
      });
      if (error) throw new Error(String(error));
    },
    onDelete: async ({ transaction }) => {
      const id = (transaction.mutations[0]?.original as GoalRow | undefined)?.id;
      if (!id) return;
      const { error } = await api.goals({ id }).delete();
      if (error) throw new Error(String(error));
    },
  })
);
