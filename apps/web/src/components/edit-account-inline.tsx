import { useState } from "react";
import { accountsCollection, type AccountRow } from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eyebrow } from "@/components/app-layout";

export function EditAccountInline({ account }: { account: AccountRow }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(account.name);
  const [institution, setInstitution] = useState(account.institution ?? "");

  function openForm() {
    setName(account.name);
    setInstitution(account.institution ?? "");
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await accountsCollection.update(account.id, (draft) => {
      draft.name = name.trim();
      draft.institution = institution.trim() || null;
    });
    setOpen(false);
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={openForm}>
        Edit account
      </Button>
    );
  }

  return (
    <div className="max-w-xs space-y-3 rounded-xl border border-border bg-card p-4">
      <Eyebrow>Edit account</Eyebrow>
      <form onSubmit={save} className="space-y-3">
        <div>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label>Institution</Label>
          <Input
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="optional"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
