import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/lib/api";
import { formatMoney } from "@/components/money";
import { cn } from "@/lib/utils";
import { AccountRow } from "@/components/account-row";
import { AccountGroupRow } from "@/components/account-group-row";
import { Eyebrow } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { groupsCollection, newId, type GroupRow } from "@/lib/collections";
import { useUsers, type Member } from "@/lib/use-users";

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
  groupId: string | null;
  sortOrder: number;
};

type Props = {
  cls: "asset" | "liability";
  label: string;
  accounts: AccountValuation[];
  groups: GroupRow[];
  baseCurrency: string;
  sectionTotalMinor: number;
  hasData: boolean;
};

const OWNER_PREFIX = "owner:";

function ownerKey(ownerIds: string[]): string {
  return [...ownerIds].sort().join("|");
}

function isOwnerCard(id: string): boolean {
  return id.startsWith(OWNER_PREFIX);
}

function ownerIdsOf(cardId: string): string[] {
  return cardId.slice(OWNER_PREFIX.length).split("|").filter(Boolean);
}

function homeBucketId(account: AccountValuation): string {
  return OWNER_PREFIX + ownerKey(account.ownerIds);
}

type Built = { order: string[]; members: Record<string, string[]> };

function build(groups: GroupRow[], accounts: AccountValuation[]): Built {
  const members: Record<string, string[]> = {};
  // Card sort key: groups use group.sortOrder; buckets use min member sortOrder.
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

  // All cards (groups + owner buckets) interleave by their sort key.
  const order = Object.keys(members).sort((a, b) => sortKey[a] - sortKey[b]);
  return { order, members };
}

function signature(groups: GroupRow[], accounts: AccountValuation[]): string {
  return JSON.stringify([
    groups.map((g) => [g.id, g.sortOrder]),
    accounts.map((a) => [a.id, a.groupId, a.sortOrder, a.ownerIds]),
  ]);
}

function SortableCard({
  id,
  highlight,
  children,
}: {
  id: string;
  highlight?: boolean;
  children: (props: {
    dragHandleProps: React.HTMLAttributes<HTMLSpanElement>;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        isDragging && "opacity-60",
        highlight && "ring-2 ring-primary ring-offset-1 ring-offset-background",
      )}
    >
      {children({ dragHandleProps: { ...attributes, ...listeners }, isDragging })}
    </div>
  );
}

function SortableAccount({
  id,
  children,
}: {
  id: string;
  children: (props: {
    dragHandleProps: React.HTMLAttributes<HTMLSpanElement>;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ dragHandleProps: { ...attributes, ...listeners }, isDragging })}
    </div>
  );
}

export function DashboardSection({
  cls,
  label,
  accounts,
  groups,
  baseCurrency,
  sectionTotalMinor,
  hasData,
}: Props) {
  const qc = useQueryClient();
  const { data: users } = useUsers();

  const memberById = new Map<string, Member>();
  for (const u of users ?? []) memberById.set(u.id, u);

  function ownerLabel(cardId: string): string {
    const ids = ownerIdsOf(cardId);
    if (ids.length === 0) return "Unowned";
    const names = ids.map((id) => memberById.get(id)?.name ?? "…");
    if (ids.length === 1) return names[0];
    return "Shared · " + names.join(", ");
  }

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const [order, setOrder] = useState<string[]>([]);
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  // The container currently hovered during an account drag (for drop hints).
  const [overContainer, setOverContainer] = useState<string | null>(null);
  const draggingRef = useRef(false);
  // Mirrors `members` synchronously so onDragEnd can persist the latest
  // arrangement even when onDragOver's setState hasn't committed yet.
  const membersRef = useRef<Record<string, string[]>>({});
  // True once a drag has moved an account across containers, so onDragEnd
  // doesn't also apply a within-card reshuffle on top of it.
  const crossMovedRef = useRef(false);

  // Account lookup by id (from props).
  const acctById = new Map<string, AccountValuation>();
  for (const a of accounts) acctById.set(a.id, a);

  const sig = signature(groups, accounts);
  useEffect(() => {
    if (draggingRef.current) return;
    const built = build(groups, accounts);
    setOrder(built.order);
    setMembers(built.members);
    membersRef.current = built.members;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function toggleGroup(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createGroup() {
    if (!newGroupName.trim()) return;
    const id = newId();
    await groupsCollection.insert({
      id,
      name: newGroupName.trim(),
      class: cls,
      sortOrder: groups.length,
      createdAt: Math.floor(Date.now() / 1000),
    });
    setNewGroupOpen(false);
    setNewGroupName("");
    setExpanded((prev) => new Set(prev).add(id));
  }

  async function renameGroup(id: string, name: string) {
    await groupsCollection.update(id, (draft) => {
      draft.name = name;
    });
  }

  async function deleteGroup(id: string) {
    // Server nullifies member accounts' groupId, so they fall back to the
    // standalone card; refresh net worth so they reappear there.
    await groupsCollection.delete(id);
    await qc.invalidateQueries({ queryKey: ["networth"] });
  }

  function findContainer(id: string): string | undefined {
    if (order.includes(id)) return id;
    return Object.keys(members).find((c) => members[c]?.includes(id));
  }

  async function persist(curOrder: string[], curMembers: Record<string, string[]>) {
    let n = 0;
    const items: Array<{
      id: string;
      kind: "account" | "group";
      sortOrder: number;
      groupId?: string | null;
    }> = [];
    for (const cardId of curOrder) {
      if (isOwnerCard(cardId)) {
        for (const acctId of curMembers[cardId] ?? []) {
          items.push({ id: acctId, kind: "account", sortOrder: n++, groupId: null });
        }
      } else {
        items.push({ id: cardId, kind: "group", sortOrder: n++ });
        for (const acctId of curMembers[cardId] ?? []) {
          items.push({ id: acctId, kind: "account", sortOrder: n++, groupId: cardId });
        }
      }
    }
    await api.accounts.reorder.patch({ items });
    await qc.invalidateQueries({ queryKey: ["networth"] });
    await qc.invalidateQueries({ queryKey: ["groups"] });
  }

  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveId(id);
    setOverContainer(null);
    draggingRef.current = true;
    crossMovedRef.current = false;

    // If an account is being dragged, ensure its home owner bucket exists as a
    // (possibly empty) drop target — so a grouped account can be ungrouped even
    // when no other ungrouped account of that owner is currently visible.
    const acct = acctById.get(id);
    if (acct) {
      const home = homeBucketId(acct);
      if (!order.includes(home)) {
        setOrder((prev) => (prev.includes(home) ? prev : [...prev, home]));
        setMembers((prev) => {
          if (prev[home]) return prev;
          const next = { ...prev, [home]: [] };
          membersRef.current = next;
          return next;
        });
      }
    }
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) {
      setOverContainer(null);
      return;
    }
    const activeIdStr = String(active.id);
    // Skip container (card) drags — those reorder only on drag end.
    if (order.includes(activeIdStr)) return;

    const overIdStr = String(over.id);
    const fromContainer = findContainer(activeIdStr);
    const toContainer = order.includes(overIdStr) ? overIdStr : findContainer(overIdStr);

    // Owner-integrity guard: an account may only land in a real group or in its
    // OWN owner bucket. Dropping into a different owner bucket is a no-op.
    if (toContainer && isOwnerCard(toContainer)) {
      const acct = acctById.get(activeIdStr);
      if (acct && toContainer !== homeBucketId(acct)) {
        setOverContainer(null);
        return;
      }
    }

    setOverContainer(toContainer ?? null);
    if (!fromContainer || !toContainer || fromContainer === toContainer) return;

    setMembers((prev) => {
      const fromItems = [...(prev[fromContainer] ?? [])];
      const toItems = [...(prev[toContainer] ?? [])];
      const fromIdx = fromItems.indexOf(activeIdStr);
      if (fromIdx === -1) return prev;
      fromItems.splice(fromIdx, 1);

      let insertIdx = toItems.length;
      if (!order.includes(overIdStr)) {
        const overIdx = toItems.indexOf(overIdStr);
        if (overIdx !== -1) insertIdx = overIdx;
      }
      toItems.splice(insertIdx, 0, activeIdStr);

      const next = { ...prev, [fromContainer]: fromItems, [toContainer]: toItems };
      membersRef.current = next;
      return next;
    });
    crossMovedRef.current = true;
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    draggingRef.current = false;
    setActiveId(null);
    setOverContainer(null);
    if (!over) return;

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    // Card drag — groups and owner buckets reorder freely among each other.
    if (order.includes(activeIdStr)) {
      const overCard = order.includes(overIdStr) ? overIdStr : findContainer(overIdStr);
      const oldIndex = order.indexOf(activeIdStr);
      const newIndex = overCard ? order.indexOf(overCard) : -1;
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const newOrder = arrayMove(order, oldIndex, newIndex);
      setOrder(newOrder);
      await persist(newOrder, membersRef.current);
      return;
    }

    // Account drag.
    const fromContainer = findContainer(activeIdStr);
    if (!fromContainer) return;
    const toContainer = order.includes(overIdStr) ? overIdStr : findContainer(overIdStr);

    // Owner-integrity guard: invalid cross-owner-bucket drop is a no-op.
    if (toContainer && isOwnerCard(toContainer)) {
      const acct = acctById.get(activeIdStr);
      if (acct && toContainer !== homeBucketId(acct)) return;
    }

    if (!crossMovedRef.current && toContainer && fromContainer === toContainer) {
      // Same-container reorder.
      const items = members[fromContainer] ?? [];
      const oldIndex = items.indexOf(activeIdStr);
      const newIndex = items.indexOf(overIdStr);
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const next = { ...members, [fromContainer]: arrayMove(items, oldIndex, newIndex) };
        setMembers(next);
        membersRef.current = next;
        await persist(order, next);
        return;
      }
    }
    // Cross-container move already applied in onDragOver; persist the latest
    // arrangement from the ref (state may not have committed yet).
    await persist(order, membersRef.current);
  }

  const hasCards = order.some((id) => (members[id]?.length ?? 0) > 0);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <Eyebrow>{label}</Eyebrow>
        <div className="flex items-center gap-3">
          {hasData && accounts.length > 0 && (
            <span className="font-heading text-sm tabular-nums text-muted-foreground">
              {formatMoney(sectionTotalMinor, baseCurrency)}
            </span>
          )}
          {newGroupOpen ? (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Group name"
                className="h-7 w-32 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createGroup();
                  if (e.key === "Escape") {
                    setNewGroupOpen(false);
                    setNewGroupName("");
                  }
                }}
              />
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => void createGroup()}
                disabled={!newGroupName.trim()}
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setNewGroupOpen(false);
                  setNewGroupName("");
                }}
              >
                ✕
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground"
              onClick={() => {
                setNewGroupOpen(true);
                setNewGroupName("");
              }}
            >
              + New group
            </Button>
          )}
        </div>
      </div>

      {!hasCards ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={(e) => void onDragEnd(e)}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {order.map((cardId) => {
                const memberIds = members[cardId] ?? [];
                const dragging = activeId !== null;
                const isAccountDrag = activeId !== null && !order.includes(activeId);
                const isDropTarget = isAccountDrag && overContainer === cardId;
                const activeAcctName = activeId ? acctById.get(activeId)?.name : undefined;
                const bucket = isOwnerCard(cardId);

                // Empty owner buckets are hidden at rest; shown during a drag
                // (their home account can be dropped back in to ungroup it).
                if (bucket && memberIds.length === 0 && !dragging) return null;

                const cardName = bucket
                  ? ownerLabel(cardId)
                  : (groups.find((g) => g.id === cardId)?.name ?? "");
                // Group cards must resolve to a real group.
                const group = bucket ? null : groups.find((g) => g.id === cardId);
                if (!bucket && !group) return null;

                const memberAccts = memberIds
                  .map((id) => acctById.get(id))
                  .filter((a): a is AccountValuation => a !== undefined);
                const subtotal = memberAccts
                  .filter((a) => !a.missingRate)
                  .reduce((sum, a) => sum + a.baseMinor, 0);
                // `expanded` tracks toggles away from each card's default:
                // groups default collapsed (in-set = expanded); buckets default
                // expanded (in-set = collapsed).
                const expandedState = bucket ? !expanded.has(cardId) : expanded.has(cardId);

                return (
                  <SortableCard key={cardId} id={cardId} highlight={isDropTarget}>
                    {({ dragHandleProps, isDragging }) => (
                      <div>
                        <AccountGroupRow
                          name={cardName}
                          memberCount={memberIds.length}
                          subtotalMinor={subtotal}
                          baseCurrency={baseCurrency}
                          expanded={expandedState}
                          onToggle={() => toggleGroup(cardId)}
                          onRename={
                            bucket ? undefined : (name) => void renameGroup(cardId, name)
                          }
                          onDelete={bucket ? undefined : () => void deleteGroup(cardId)}
                          dragHandleProps={dragHandleProps}
                          isDragging={isDragging}
                        />
                        {isDropTarget && !expandedState && !bucket && (
                          <p className="border-t border-primary/30 bg-primary/10 px-4 py-2 text-center text-xs font-medium text-primary">
                            Drop here to add{activeAcctName ? ` ${activeAcctName}` : " account"} into{" "}
                            {cardName}
                          </p>
                        )}
                        {expandedState && (
                          <SortableContext items={memberIds} strategy={verticalListSortingStrategy}>
                            <div className="border-t border-border/70">
                              {memberIds.length === 0 ? (
                                <p className="px-4 py-3 text-xs text-muted-foreground">
                                  {bucket
                                    ? "Drop here to remove from group"
                                    : "No accounts — drag one in."}
                                </p>
                              ) : (
                                memberIds.map((aid, i) => {
                                  const acct = acctById.get(aid);
                                  if (!acct) return null;
                                  return (
                                    <SortableAccount key={aid} id={aid}>
                                      {({ dragHandleProps: dp, isDragging: d }) => (
                                        <AccountRow
                                          account={acct}
                                          baseCurrency={baseCurrency}
                                          isLast={i === memberIds.length - 1}
                                          dragHandleProps={dp}
                                          isDragging={d}
                                        />
                                      )}
                                    </SortableAccount>
                                  );
                                })
                              )}
                            </div>
                          </SortableContext>
                        )}
                      </div>
                    )}
                  </SortableCard>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}
