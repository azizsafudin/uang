import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { Pencil, X } from "lucide-react";
import { accountsCollection, groupsCollection, newId, type AccountRow } from "@/lib/collections";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OwnersField } from "@/components/owners-field";
import { OwnersBadge } from "@/components/owners-badge";
import { cn } from "@/lib/utils";

type Props = { account: AccountRow };

export function AccountInfoCard({ account }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [institution, setInstitution] = useState(account.institution ?? "");
  const [groupId, setGroupId] = useState<string | null>(account.groupId ?? null);
  const [draftOwners, setDraftOwners] = useState<string[]>(account.ownerIds);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  const { data: allGroups } = useLiveQuery(groupsCollection);
  const groups = (allGroups ?? []).filter((g) => g.class === account.class);

  function openEdit() {
    setName(account.name);
    setInstitution(account.institution ?? "");
    setGroupId(account.groupId ?? null);
    setDraftOwners(account.ownerIds);
    setShowNewGroup(false);
    setNewGroupName("");
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setShowNewGroup(false);
    setNewGroupName("");
  }

  async function createGroup() {
    if (!newGroupName.trim()) return;
    const id = newId();
    await groupsCollection.insert({
      id,
      name: newGroupName.trim(),
      class: account.class,
      sortOrder: 0,
      createdAt: Math.floor(Date.now() / 1000),
    });
    setGroupId(id);
    setShowNewGroup(false);
    setNewGroupName("");
  }

  async function save() {
    await accountsCollection.update(account.id, (draft) => {
      draft.name = name.trim();
      draft.institution = institution.trim() || null;
      draft.groupId = groupId;
    });
    if (!ownersEqual(draftOwners, account.ownerIds)) {
      await api.accounts({ id: account.id }).owners.patch({ ownerIds: draftOwners });
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    }
    await qc.invalidateQueries({ queryKey: ["networth"] });
    setEditing(false);
  }

  const groupName = groups.find((g) => g.id === groupId)?.name ?? null;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted px-4 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Account info
        </span>
        <button
          onClick={editing ? cancel : openEdit}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent",
            editing && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
          )}
          aria-label={editing ? "Cancel editing" : "Edit account"}
          title={editing ? "Cancel editing" : "Edit account"}
        >
          {editing ? <X size={13} /> : <Pencil size={13} />}
        </button>
      </div>

      {!editing && (
        <div>
          <KVRow label="Name" value={account.name} />
          <KVRow label="Institution" value={account.institution ?? null} empty="—" />
          <KVRow label="Group" value={groupName} empty="None" />
          <div className="flex items-start gap-6 border-t border-border px-4 py-2.5">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">Owners</span>
            <OwnersBadge ownerIds={account.ownerIds} />
          </div>
        </div>
      )}

      {editing && (
        <div>
          <div className="flex flex-col gap-4 p-4">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>

            <Field label="Institution" hint="Optional. The bank or provider holding this account.">
              <Input
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                placeholder="e.g. DBS Bank"
              />
            </Field>

            <Field label="Group" hint="Accounts in the same group are shown together on the dashboard.">
              <select
                value={showNewGroup ? "__new__" : (groupId ?? "")}
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    setShowNewGroup(true);
                    setGroupId(null);
                  } else {
                    setShowNewGroup(false);
                    setGroupId(e.target.value || null);
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value="__new__">+ New group…</option>
              </select>
              {showNewGroup && (
                <div className="mt-2 flex gap-2">
                  <Input
                    autoFocus
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="Group name"
                    onKeyDown={(e) => e.key === "Enter" && createGroup()}
                  />
                  <Button type="button" size="sm" onClick={createGroup} disabled={!newGroupName.trim()}>
                    Create
                  </Button>
                </div>
              )}
            </Field>

            <Field label="Owners" hint="Shared accounts (2+ owners) appear in household total only, not personal net worth.">
              <OwnersField value={draftOwners} onChange={setDraftOwners} />
            </Field>
          </div>

          <div className="flex gap-2 border-t border-border bg-muted px-4 py-3">
            <Button size="sm" onClick={save} disabled={!name.trim() || draftOwners.length === 0}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function KVRow({ label, value, empty = "—" }: { label: string; value: string | null; empty?: string }) {
  return (
    <div className="flex items-start gap-6 border-t border-border px-4 py-2.5 first:border-t-0">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-medium", !value && "text-muted-foreground font-normal")}>
        {value ?? empty}
      </span>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ownersEqual(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}
