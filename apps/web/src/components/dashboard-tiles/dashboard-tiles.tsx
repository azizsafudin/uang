import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Check } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Money } from "@/components/money.tsx";
import { AccountsBreakdownCard } from "@/components/accounts-breakdown-card";
import { TILE_REGISTRY, getTile, DEFAULT_TILES, type Tile, type TileData } from "@/lib/dashboard-tiles/registry";
import { cn } from "@/lib/utils";

function SortableTile({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-center gap-2", isDragging && "opacity-60")}
    >
      <button type="button" className="cursor-grab text-muted-foreground" {...attributes} {...listeners} aria-label="Reorder">
        <GripVertical className="size-4" />
      </button>
      <div className="flex-1">{children}</div>
    </div>
  );
}

type SettingsData = { dashboardTiles: string[] };

export function DashboardTiles({
  data,
  baseCurrency,
  editing,
  onEditingChange,
}: {
  data: TileData;
  baseCurrency: string;
  editing: boolean;
  onEditingChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: async (): Promise<SettingsData> => {
      const { data, error } = await api.settings.get();
      if (error) throw new Error(String(error));
      return data as unknown as SettingsData;
    },
  });
  // At most three tiles can be shown beside the vault; cap the enabled set so the
  // display, edit-mode checkboxes, and persisted list all stay consistent.
  const MAX_VISIBLE = 3;
  const enabled: string[] = (settings?.dashboardTiles ?? DEFAULT_TILES).slice(0, MAX_VISIBLE);

  const [draft, setDraft] = useState<string[] | null>(null);
  const order = draft ?? enabled;

  const save = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await api.settings.patch({ dashboardTiles: ids });
      if (error) throw new Error(String(error));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Visible (non-edit) tiles: enabled ∩ available, in saved order, capped at
  // two so the companion column stays compact beside the net-worth vault.
  const visible = useMemo(
    () =>
      order
        .map(getTile)
        .filter((t): t is NonNullable<typeof t> => !!t && t.isAvailable(data))
        .slice(0, MAX_VISIBLE),
    [order, data],
  );

  if (!editing) {
    return (
      <div data-testid="dashboard-tiles" className="flex flex-col gap-4">
        {visible.map((t) => (
          <TileCard key={t.id} tile={t} data={data} baseCurrency={baseCurrency} />
        ))}
      </div>
    );
  }

  // Edit mode: every registry tile, checkbox + drag, in current draft order.
  const editOrder = order.filter((id) => getTile(id));
  const missing = TILE_REGISTRY.map((t) => t.id).filter((id) => !editOrder.includes(id));
  const allInOrder = [...editOrder, ...missing];
  // At most two tiles can be shown, so block enabling a third.
  const atLimit = editOrder.length >= MAX_VISIBLE;

  return (
    <div data-testid="dashboard-tiles-edit" className="rounded-[14px] border border-dashed border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Edit tiles · pick up to 3</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Done editing tiles"
          onClick={() => {
            save.mutate(order);
            onEditingChange(false);
          }}
        >
          <Check className="size-4" />
        </Button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!over || active.id === over.id) return;
          const from = allInOrder.indexOf(String(active.id));
          const to = allInOrder.indexOf(String(over.id));
          // Reorder the full list, then keep only enabled ids — the saved order
          // is the enabled set in its new relative order.
          setDraft(arrayMove(allInOrder, from, to).filter((id) => order.includes(id)));
        }}
      >
        <SortableContext items={allInOrder} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {allInOrder.map((id) => {
              const tile = getTile(id)!;
              const isEnabled = order.includes(id);
              const blocked = !isEnabled && atLimit;
              return (
                <SortableTile key={id} id={id}>
                  <label className={cn("flex items-center gap-2 text-sm", blocked && "opacity-50")}>
                    <Checkbox
                      checked={isEnabled}
                      disabled={blocked}
                      onCheckedChange={(v) => {
                        if (v && atLimit) return;
                        setDraft(v ? [...order, id] : order.filter((x) => x !== id));
                      }}
                    />
                    <span>{tile.label}</span>
                    {!tile.isAvailable(data) && <span className="text-xs text-muted-foreground">(no data)</span>}
                  </label>
                </SortableTile>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function TileCard({ tile, data, baseCurrency }: { tile: Tile; data: TileData; baseCurrency: string }) {
  // Breakdown tiles render an allocation donut over the asset accounts.
  if (tile.breakdown) {
    return (
      <AccountsBreakdownCard
        title={tile.label}
        dim={tile.breakdown}
        accounts={data.assetAccounts}
        baseCurrency={baseCurrency}
      />
    );
  }

  const isCount = tile.id === "goalsOnTrack";
  const value = tile.value?.(data) ?? 0;
  return (
    <div className="flex flex-col justify-center rounded-[14px] border border-border bg-card px-5 py-4">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{tile.label}</div>
      <div className="mt-1 font-heading text-[1.6rem] tabular-nums">
        {isCount ? (
          <span>{value}</span>
        ) : (
          <>
            <Money minor={value} currency={baseCurrency} />
            {tile.valueSuffix && <span className="text-base text-muted-foreground">{tile.valueSuffix}</span>}
          </>
        )}
      </div>
      {tile.subMoney ? (
        <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
          <Money minor={tile.subMoney(data)} currency={baseCurrency} />
          {tile.subMoneySuffix}
        </div>
      ) : tile.subtitle ? (
        <div className="mt-0.5 text-xs text-muted-foreground">{tile.subtitle(data)}</div>
      ) : null}
    </div>
  );
}
