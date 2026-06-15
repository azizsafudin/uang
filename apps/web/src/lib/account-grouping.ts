// Shared grouping + ordering for account lists. The dashboard (sortable) and the
// projections page (read-only) render the SAME groups in the SAME order via these
// pure helpers — no React, no fetching here.

import type { GroupRow } from "./collections";

export type AccountValuation = {
  id: string;
  name: string;
  class: string;
  subtype: string;
  currency: string;
  balanceMinor: number;
  baseMinor: number;
  missingRate: boolean;
  ownerIds: string[];
  shared: boolean;
  illiquid: boolean;
  groupId: string | null;
  sortOrder: number;
};

const OWNER_PREFIX = "owner:";

function ownerKey(ownerIds: string[]): string {
  return [...ownerIds].sort().join("|");
}

export function isOwnerCard(id: string): boolean {
  return id.startsWith(OWNER_PREFIX);
}

export function ownerIdsOf(cardId: string): string[] {
  return cardId.slice(OWNER_PREFIX.length).split("|").filter(Boolean);
}

export function homeBucketId(account: AccountValuation): string {
  return OWNER_PREFIX + ownerKey(account.ownerIds);
}

// Accounts visible for the dashboard owner toggle. "household" shows all;
// a member id shows accounts they own — including shared accounts they co-own.
export function visibleForOwner(
  accounts: AccountValuation[],
  owner: string,
): AccountValuation[] {
  if (owner === "household") return accounts;
  return accounts.filter((a) => a.ownerIds.includes(owner));
}

export type Built = { order: string[]; members: Record<string, string[]> };

// Group accounts into cards (real groups + per-owner buckets) and order the cards.
// Groups sort by group.sortOrder; owner buckets by the min sortOrder of their
// members; accounts within a card sort by account.sortOrder.
export function build(groups: GroupRow[], accounts: AccountValuation[]): Built {
  const members: Record<string, string[]> = {};
  const sortKey: Record<string, number> = {};

  for (const g of groups) {
    const mem = accounts
      .filter((a) => a.groupId === g.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    members[g.id] = mem.map((a) => a.id);
    sortKey[g.id] = g.sortOrder;
  }

  const ungrouped = accounts
    .filter((a) => !a.groupId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const a of ungrouped) {
    const cardId = homeBucketId(a);
    if (!members[cardId]) {
      members[cardId] = [];
      sortKey[cardId] = a.sortOrder; // first seen = min sortOrder (already sorted)
    }
    members[cardId].push(a.id);
  }

  const order = Object.keys(members).sort((a, b) => sortKey[a] - sortKey[b]);
  return { order, members };
}

export function signature(groups: GroupRow[], accounts: AccountValuation[]): string {
  return JSON.stringify([
    groups.map((g) => [g.id, g.sortOrder]),
    accounts.map((a) => [a.id, a.groupId, a.sortOrder, a.ownerIds]),
  ]);
}
