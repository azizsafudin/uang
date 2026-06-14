import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
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

const STANDALONE = "standalone";

type Built = { order: string[]; members: Record<string, string[]> };

function build(groups: GroupRow[], accounts: AccountValuation[]): Built {
  const members: Record<string, string[]> = {};

  const sortedGroups = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const g of sortedGroups) {
    const mem = accounts
      .filter((a) => a.groupId === g.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    members[g.id] = mem.map((a) => a.id);
  }

  const ungrouped = accounts
    .filter((a) => !a.groupId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  members[STANDALONE] = ungrouped.map((a) => a.id);

  // Group cards are reorderable; the standalone card is always pinned last.
  const order = [...sortedGroups.map((g) => g.id), STANDALONE];
  return { order, members };
}

function signature(groups: GroupRow[], accounts: AccountValuation[]): string {
  return JSON.stringify([
    groups.map((g) => [g.id, g.sortOrder]),
    accounts.map((a) => [a.id, a.groupId, a.sortOrder]),
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

// The standalone (ungrouped) card is pinned to the bottom and is NOT
// reorderable — it only needs to be a drop target for accounts.
function DroppableCard({
  id,
  highlight,
  children,
}: {
  id: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        highlight && "ring-2 ring-primary ring-offset-1 ring-offset-background",
      )}
    >
      {children}
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
      if (cardId === STANDALONE) {
        for (const acctId of curMembers[STANDALONE] ?? []) {
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
    setActiveId(String(event.active.id));
    setOverContainer(null);
    draggingRef.current = true;
    crossMovedRef.current = false;
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

    // Group card drag — reorder among groups; the standalone card stays last.
    if (order.includes(activeIdStr) && activeIdStr !== STANDALONE) {
      const groupOrder = order.filter((id) => id !== STANDALONE);
      const overCard = order.includes(overIdStr) ? overIdStr : findContainer(overIdStr);
      const oldIndex = groupOrder.indexOf(activeIdStr);
      // Dropping onto (or past) the standalone card sends the group to the end.
      const newIndex =
        !overCard || overCard === STANDALONE
          ? groupOrder.length - 1
          : groupOrder.indexOf(overCard);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const newOrder = [...arrayMove(groupOrder, oldIndex, newIndex), STANDALONE];
      setOrder(newOrder);
      await persist(newOrder, membersRef.current);
      return;
    }

    // Account drag.
    const fromContainer = findContainer(activeIdStr);
    if (!fromContainer) return;
    const toContainer = order.includes(overIdStr) ? overIdStr : findContainer(overIdStr);

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
          <SortableContext
            items={order.filter((id) => id !== STANDALONE)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {order.map((cardId) => {
                const memberIds = members[cardId] ?? [];
                const dragging = activeId !== null;
                const isAccountDrag = activeId !== null && !order.includes(activeId);
                const isDropTarget = isAccountDrag && overContainer === cardId;
                const activeAcctName = activeId ? acctById.get(activeId)?.name : undefined;

                if (cardId === STANDALONE) {
                  // Hidden at rest when empty; shown during a drag as a drop target.
                  if (memberIds.length === 0 && !dragging) return null;
                  return (
                    <DroppableCard key={cardId} id={cardId} highlight={isDropTarget}>
                      {memberIds.length === 0 ? (
                        <p className="px-4 py-4 text-center text-xs text-muted-foreground">
                          Drop here to remove from group
                        </p>
                      ) : (
                        <SortableContext items={memberIds} strategy={verticalListSortingStrategy}>
                          {memberIds.map((aid, i) => {
                            const acct = acctById.get(aid);
                            if (!acct) return null;
                            return (
                              <SortableAccount key={aid} id={aid}>
                                {({ dragHandleProps: dp, isDragging }) => (
                                  <AccountRow
                                    account={acct}
                                    baseCurrency={baseCurrency}
                                    isLast={i === memberIds.length - 1}
                                    dragHandleProps={dp}
                                    isDragging={isDragging}
                                  />
                                )}
                              </SortableAccount>
                            );
                          })}
                        </SortableContext>
                      )}
                    </DroppableCard>
                  );
                }

                // Group card.
                const group = groups.find((g) => g.id === cardId);
                if (!group) return null;
                const memberAccts = memberIds
                  .map((id) => acctById.get(id))
                  .filter((a): a is AccountValuation => a !== undefined);
                const subtotal = memberAccts
                  .filter((a) => !a.missingRate)
                  .reduce((sum, a) => sum + a.baseMinor, 0);
                const isExpanded = expanded.has(group.id);

                return (
                  <SortableCard key={cardId} id={cardId} highlight={isDropTarget}>
                    {({ dragHandleProps, isDragging }) => (
                      <div>
                        <AccountGroupRow
                          name={group.name}
                          memberCount={memberIds.length}
                          subtotalMinor={subtotal}
                          baseCurrency={baseCurrency}
                          expanded={isExpanded}
                          onToggle={() => toggleGroup(group.id)}
                          dragHandleProps={dragHandleProps}
                          isDragging={isDragging}
                        />
                        {isDropTarget && !isExpanded && (
                          <p className="border-t border-primary/30 bg-primary/10 px-4 py-2 text-center text-xs font-medium text-primary">
                            Drop here to add{activeAcctName ? ` ${activeAcctName}` : " account"} into{" "}
                            {group.name}
                          </p>
                        )}
                        {isExpanded && (
                          <SortableContext items={memberIds} strategy={verticalListSortingStrategy}>
                            <div className="border-t border-border/70">
                              {memberIds.length === 0 ? (
                                <p className="px-4 py-3 text-xs text-muted-foreground">
                                  No accounts — drag one in.
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
