import { useState } from "react";
import { Avatar, Button, Modal, useOverlayState } from "@heroui/react";
import { CheckIcon, PlusIcon } from "lucide-react";
import { getInitials } from "../../hooks/useSelectedConversation";
import { useChatStore } from "../../store/useChatStore";

const MAX_OTHER_PARTICIPANTS = 99;

export function CreateGroupModal() {
  const modal = useOverlayState();
  const users = useChatStore((state) => state.users);
  const createGroup = useChatStore((state) => state.createGroup);

  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // System accounts are never valid group members (the backend rejects
  // them too); keep them out of the picker.
  const candidates = users.filter((user) => !user.isSystemUser);

  const canSubmit =
    name.trim().length > 0 &&
    selectedIds.length > 0 &&
    selectedIds.length <= MAX_OTHER_PARTICIPANTS &&
    !isSubmitting;

  const toggleUser = (userId) => {
    setSelectedIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId],
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setIsSubmitting(true);
    const didCreate = await createGroup({
      name: name.trim(),
      avatar: avatar.trim(),
      participantIds: selectedIds,
    });
    setIsSubmitting(false);

    if (didCreate) {
      setName("");
      setAvatar("");
      setSelectedIds([]);
      modal.close();
    }
  };

  return (
    <Modal.Root state={modal}>
      <Modal.Trigger>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="shrink-0"
          aria-label="New group"
        >
          <PlusIcon className="size-5" strokeWidth={2} />
        </Button>
      </Modal.Trigger>

      <Modal.Backdrop variant="opaque">
        <Modal.Container size="md" scroll="inside" placement="center">
          <Modal.Dialog className="max-h-[85dvh] border border-white/10 bg-[#2a2a2c] text-foreground shadow-2xl">
            <Modal.Header className="flex flex-row items-center justify-between gap-3 border-b border-white/10 pb-3">
              <Modal.Heading className="text-lg font-semibold tracking-tight text-white">
                New group
              </Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>

            <Modal.Body className="isolate space-y-4 pt-4">
              <div className="space-y-2">
                <input
                  type="text"
                  value={name}
                  maxLength={100}
                  placeholder="Group name"
                  onChange={(event) => setName(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-accent"
                />
                <input
                  type="url"
                  value={avatar}
                  placeholder="Avatar image URL (optional)"
                  onChange={(event) => setAvatar(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-accent"
                />
                <p className="text-xs text-zinc-500">
                  Name and avatar can&apos;t be changed after the group is
                  created.
                </p>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-medium text-zinc-400">
                  Members ({selectedIds.length} selected)
                </h3>
                {candidates.length === 0 ? (
                  <p className="py-4 text-center text-sm text-zinc-500">
                    No people available to add.
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto rounded-xl border border-white/10">
                    {candidates.map((user) => {
                      const isSelected = selectedIds.includes(user._id);

                      return (
                        <button
                          key={user._id}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => toggleUser(user._id)}
                          className={`flex w-full items-center gap-3 border-b border-white/10 px-3 py-2 text-left last:border-b-0 ${
                            isSelected ? "bg-white/10" : ""
                          }`}
                        >
                          <Avatar className="size-9 shrink-0">
                            <Avatar.Image
                              alt={user.fullName}
                              src={user.profilePic}
                            />
                            <Avatar.Fallback className="text-sm font-medium">
                              {getInitials(user.fullName)}
                            </Avatar.Fallback>
                          </Avatar>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                            {user.fullName}
                          </span>
                          {isSelected ? (
                            <CheckIcon
                              className="size-4 shrink-0 text-accent"
                              strokeWidth={3}
                              aria-hidden
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex justify-end pt-1">
                <Button
                  variant="primary"
                  isDisabled={!canSubmit}
                  onPress={handleSubmit}
                >
                  {isSubmitting ? "Creating..." : "Create group"}
                </Button>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
